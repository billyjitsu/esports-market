import { HTTPFacilitatorClient } from '@x402/core/http';
import { type Hex, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readOption, readPrivateKey } from './market.ts';
import {
  BASE_SEPOLIA,
  createPayingFetch,
  formatDollars,
  isPaymentAsset,
  PAYMENT_ASSET_ADDRESSES,
  PAYMENT_ASSET_DECIMALS,
} from './x402.ts';

// Checks that the agent's x402 payments settle, before any Airnode charges for a call. It plays the Airnode's side of a
// priced call: it answers the agent's paying fetch with a 402, takes the payment that the agent signs, and has a real
// x402 facilitator verify and settle it on Base Sepolia. The tokens move from the agent to --to, which is the deployer
// unless you name another account.
//
//   pnpm x402-check                      pays 0.01 in X402_ASSET from the agent to the deployer
//   pnpm x402-check --amount 0.05 --to 0x…
const asset = process.env.X402_ASSET ?? 'aUSD';
if (!isPaymentAsset(asset)) throw new Error('X402_ASSET must be aUSD or USDC');
const amount = parseUnits(readOption('--amount') ?? '0.01', PAYMENT_ASSET_DECIMALS);
const payTo = (readOption('--to') ?? privateKeyToAccount(readPrivateKey(undefined)).address) as Hex;
const facilitator = new HTTPFacilitatorClient({ url: readOption('--facilitator') ?? 'https://x402.org/facilitator' });

// What an Airnode puts in its 402 for this asset. The EIP-712 name and version are the token's own.
const eip712Domain = asset === 'aUSD' ? { name: 'AirnodeHub USD', version: '1' } : { name: 'USDC', version: '2' };
const requirements = {
  scheme: 'exact',
  network: BASE_SEPOLIA,
  asset: PAYMENT_ASSET_ADDRESSES[asset],
  amount: amount.toString(),
  payTo,
  maxTimeoutSeconds: 300,
  extra: eip712Domain,
} as const;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

// Stands in for the Airnode: 402 without a payment, then verify and settle with the facilitator
const priceAirnode: typeof fetch = async (input, init) => {
  // The x402 client sends its retry as a Request, with the payment in its headers
  const paymentHeader =
    new Headers(init?.headers).get('PAYMENT-SIGNATURE') ??
    (input instanceof Request ? input.headers.get('PAYMENT-SIGNATURE') : null);
  if (!paymentHeader) {
    const paymentRequired = { x402Version: 2, resource: { url: 'https://x402-check.local/' }, accepts: [requirements] };
    return new Response('{"error":"Payment required"}', {
      status: 402,
      headers: { 'PAYMENT-REQUIRED': encode(paymentRequired) },
    });
  }
  const payload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'));
  const verification = await facilitator.verify(payload, requirements);
  console.log(`Facilitator verify: ${verification.isValid ? 'valid' : `invalid (${verification.invalidReason})`}`);
  if (!verification.isValid) return new Response('{"error":"Payment invalid"}', { status: 402 });
  const settlement = await facilitator.settle(payload, requirements);
  console.log(`Facilitator settle: ${settlement.success ? 'settled' : `failed (${settlement.errorReason})`}`);
  return new Response('{"data":"paid"}', { status: 200, headers: { 'PAYMENT-RESPONSE': encode(settlement) } });
};

const payerPrivateKey = readPrivateKey(readOption('--as') ?? 'agent');
console.log(
  `Paying ${formatDollars(amount)} in ${asset} from ${privateKeyToAccount(payerPrivateKey).address} to ${payTo}`
);
const paying = createPayingFetch(
  {
    payerPrivateKey,
    asset,
    maxAmountPerCall: parseUnits(process.env.X402_MAX_PAYMENT ?? '0.10', PAYMENT_ASSET_DECIMALS),
    budget: parseUnits(process.env.X402_BUDGET ?? '1.00', PAYMENT_ASSET_DECIMALS),
    onPayment: ({ amount: paid, transaction }) =>
      console.log(`Paid ${formatDollars(paid)}: https://sepolia.basescan.org/tx/${transaction}`),
  },
  priceAirnode
);
const response = await paying.fetch('https://x402-check.local/', { method: 'POST', body: '{}' });
if (!response.ok) throw new Error(`The payment did not go through: ${response.status} ${await response.text()}`);
