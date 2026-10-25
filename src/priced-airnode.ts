import { createServer } from 'node:http';
import { HTTPFacilitatorClient } from '@x402/core/http';
import { type Hex, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readOption, readPrivateKey } from './market.ts';
import { PANDASCORE_AIRNODE_DIRECT_URL } from './pandascore.ts';
import { BASE_SEPOLIA, formatDollars, PAYMENT_ASSET_ADDRESSES, PAYMENT_ASSET_DECIMALS } from './x402.ts';

// A priced gateway in front of the real PandaScore Airnode, for rehearsing x402 while no AirnodeHub operation charges.
// It answers a POST without payment with 402 and the price in aUSD and USDC, the way an Airnode does. With a payment, it
// has a real x402 facilitator verify it, forwards the call to the PandaScore Airnode, has the facilitator settle the
// payment on Base Sepolia, and returns the Airnode's response with the settlement in PAYMENT-RESPONSE.
//
// It does not sign anything: the signed result comes from the real Airnode, so contracts accept it unchanged.
//
//   pnpm priced-airnode                         $0.01 per call, paid to the PRIVATE_KEY account, on port 4021
//   pnpm priced-airnode --price 0.02 --port 4021 --to 0x…
//   PANDASCORE_AIRNODE_URL=http://127.0.0.1:4021/ pnpm agent --once
const port = Number(readOption('--port') ?? 4021);
const price = parseUnits(readOption('--price') ?? '0.01', PAYMENT_ASSET_DECIMALS);
const payTo = (readOption('--to') ?? privateKeyToAccount(readPrivateKey(undefined)).address) as Hex;
const facilitator = new HTTPFacilitatorClient({ url: readOption('--facilitator') ?? 'https://x402.org/facilitator' });

// Every asset an Airnode accepts, at the same price, with each token's EIP-712 name and version in `extra`
const accepts = [
  { asset: PAYMENT_ASSET_ADDRESSES.aUSD, extra: { name: 'AirnodeHub USD', version: '1' } },
  { asset: PAYMENT_ASSET_ADDRESSES.USDC, extra: { name: 'USDC', version: '2' } },
].map(({ asset, extra }) => ({
  scheme: 'exact' as const,
  network: BASE_SEPOLIA,
  asset,
  amount: price.toString(),
  payTo,
  maxTimeoutSeconds: 300,
  extra,
}));
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
const log = (message: string) => console.log(`[priced-airnode ${new Date().toISOString().slice(11, 19)}] ${message}`);

const server = createServer(async (request, response) => {
  if (request.method === 'GET') {
    response.writeHead(302, { Location: PANDASCORE_AIRNODE_DIRECT_URL }).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString('utf8');

  const paymentHeader = request.headers['payment-signature'];
  if (typeof paymentHeader !== 'string') {
    log(`402 for ${body.slice(0, 80)}`);
    const paymentRequired = { x402Version: 2, resource: { url: `http://127.0.0.1:${port}/` }, accepts };
    response
      .writeHead(402, { 'Content-Type': 'application/json', 'PAYMENT-REQUIRED': encode(paymentRequired) })
      .end('{"error":"Payment required"}');
    return;
  }

  try {
    const payment = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8'));
    const requirements = accepts.find(
      ({ asset }) => asset.toLowerCase() === String(payment.accepted?.asset).toLowerCase()
    );
    if (!requirements) throw new Error(`Payment in an asset this gateway does not accept: ${payment.accepted?.asset}`);

    const verification = await facilitator.verify(payment, requirements);
    if (!verification.isValid) throw new Error(`Facilitator rejected the payment: ${verification.invalidReason}`);
    log(`payment from ${verification.payer} verified`);

    // Like an Airnode, perform the call before settling, and do not charge for a call that fails upstream
    const upstream = await fetch(PANDASCORE_AIRNODE_DIRECT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const upstreamBody = await upstream.text();
    if (!upstream.ok) {
      log(`upstream answered ${upstream.status}; not charging`);
      response.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(upstreamBody);
      return;
    }

    const settlement = await facilitator.settle(payment, requirements);
    if (!settlement.success) throw new Error(`Settlement failed: ${settlement.errorReason}`);
    log(`settled ${formatDollars(price)}: https://sepolia.basescan.org/tx/${settlement.transaction}`);
    response
      .writeHead(200, { 'Content-Type': 'application/json', 'PAYMENT-RESPONSE': encode(settlement) })
      .end(upstreamBody);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(message);
    response.writeHead(402, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: message }));
  }
});

server.listen(port, '127.0.0.1', () =>
  log(`charging ${formatDollars(price)} per call in aUSD or USDC, paid to ${payTo}, on http://127.0.0.1:${port}/`)
);
