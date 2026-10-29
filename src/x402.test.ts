import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Address, recoverTypedDataAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { AUSD_ADDRESS, BASE_SEPOLIA, createPayingFetch } from './x402.ts';

// Testnet USDC on Base Sepolia, which the Airnodes no longer accept
const USDC_ADDRESS: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

// A 402 the way an Airnode sends one: the price in aUSD, in a base64 PAYMENT-REQUIRED header
const requirement = (asset: Address, name: string, version: string) => ({
  scheme: 'exact',
  network: BASE_SEPOLIA,
  asset,
  amount: '10000',
  payTo: '0x000000000000000000000000000000000000dEaD',
  maxTimeoutSeconds: 300,
  extra: { name, version },
});
const buildPaymentRequired = (accepts = [requirement(AUSD_ADDRESS, 'AirnodeHub USD', '1')]) => ({
  x402Version: 2,
  resource: { url: 'https://airnode.example/' },
  accepts,
});
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
const decode = (value: string) => JSON.parse(Buffer.from(value, 'base64').toString('utf8'));

// Answers the first call with 402, and a paid call with a signed response and a settlement
const createFakeAirnode = (paymentRequired = buildPaymentRequired()) => {
  const paymentHeaders: (string | null)[] = [];
  const fakeAirnode: typeof fetch = async (input, init) => {
    const paymentHeader =
      new Headers(init?.headers).get('PAYMENT-SIGNATURE') ??
      (input instanceof Request ? input.headers.get('PAYMENT-SIGNATURE') : null);
    paymentHeaders.push(paymentHeader);
    if (!paymentHeader) {
      return new Response('{"error":"Payment required"}', {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': encode(paymentRequired) },
      });
    }
    return new Response('{"data":{}}', {
      status: 200,
      headers: {
        'PAYMENT-RESPONSE': encode({ success: true, transaction: '0xabc', network: BASE_SEPOLIA, payer: '0x0' }),
      },
    });
  };
  return { fakeAirnode, paymentHeaders };
};

test('pays a 402 in aUSD with a signed EIP-3009 authorization, and counts it against the budget', async () => {
  const payerPrivateKey = generatePrivateKey();
  const account = privateKeyToAccount(payerPrivateKey);
  const { fakeAirnode, paymentHeaders } = createFakeAirnode();
  const payments: bigint[] = [];
  const paying = createPayingFetch(
    {
      payerPrivateKey,
      maxAmountPerCall: 100_000n,
      budget: 1_000_000n,
      onPayment: ({ amount }) => payments.push(amount),
    },
    fakeAirnode
  );

  const response = await paying.fetch('https://airnode.example/', { method: 'POST', body: '{}' });
  assert.equal(response.status, 200);
  assert.deepEqual(payments, [10_000n]);
  assert.equal(paying.spent(), 10_000n);

  const paymentHeader = paymentHeaders.at(-1);
  assert.ok(paymentHeader);
  const payment = decode(paymentHeader);
  assert.equal(payment.accepted.asset, AUSD_ADDRESS);
  const { authorization, signature } = payment.payload;
  const signer = await recoverTypedDataAddress({
    domain: { name: 'AirnodeHub USD', version: '1', chainId: 84532, verifyingContract: AUSD_ADDRESS },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
    signature,
  });
  assert.equal(signer, account.address);
});

test('refuses to pay past the budget', async () => {
  const { fakeAirnode } = createFakeAirnode();
  const paying = createPayingFetch(
    { payerPrivateKey: generatePrivateKey(), maxAmountPerCall: 100_000n, budget: 15_000n },
    fakeAirnode
  );
  await paying.fetch('https://airnode.example/', { method: 'POST', body: '{}' });
  await assert.rejects(paying.fetch('https://airnode.example/', { method: 'POST', body: '{}' }));
  assert.equal(paying.spent(), 10_000n);
});

test('refuses a call that costs more than the per-call limit', async () => {
  const { fakeAirnode } = createFakeAirnode();
  const paying = createPayingFetch(
    { payerPrivateKey: generatePrivateKey(), maxAmountPerCall: 5_000n, budget: 1_000_000n },
    fakeAirnode
  );
  await assert.rejects(paying.fetch('https://airnode.example/', { method: 'POST', body: '{}' }));
  assert.equal(paying.spent(), 0n);
});

test('refuses to pay in an asset other than aUSD', async () => {
  const { fakeAirnode } = createFakeAirnode(buildPaymentRequired([requirement(USDC_ADDRESS, 'USDC', '2')]));
  const paying = createPayingFetch(
    { payerPrivateKey: generatePrivateKey(), maxAmountPerCall: 100_000n, budget: 1_000_000n },
    fakeAirnode
  );
  await assert.rejects(paying.fetch('https://airnode.example/', { method: 'POST', body: '{}' }));
  assert.equal(paying.spent(), 0n);
});

test('passes through a call that needs no payment', async () => {
  const paying = createPayingFetch(
    { payerPrivateKey: generatePrivateKey(), maxAmountPerCall: 0n, budget: 0n },
    async () => new Response('ok', { status: 200 })
  );
  assert.equal((await paying.fetch('https://airnode.example/')).status, 200);
});
