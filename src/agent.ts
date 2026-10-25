import { formatEther, parseEventLogs, parseUnits } from 'viem';
import { expectedRequestHash, trySettle } from './keeper.ts';
import {
  createClient,
  formatTime,
  marketAbi,
  readAllMarkets,
  readMarketAddress,
  readOption,
  readPrivateKey,
  sleep,
} from './market.ts';
import { listMatches } from './pandascore.ts';
import { createPayingFetch, formatDollars, isPaymentAsset, PAYMENT_ASSET_DECIMALS } from './x402.ts';

// The keeper agent: it watches every market, buys the signed result of each match once staking has closed, and
// settles the markets whose match is over. The settler fee is its pay, and nobody has to trust it, because the
// contract checks the Airnode's signature itself.
//
//   pnpm agent                 run until stopped, checking every 60 seconds
//   pnpm agent --once          check every market once and exit
//   pnpm agent --open 3        first open markets on the next 3 upcoming matches
//
// Priced operations are paid over x402 from the agent's own key, in X402_ASSET, up to X402_MAX_PAYMENT dollars per
// call and X402_BUDGET dollars per run.
const once = process.argv.includes('--once');
const intervalSeconds = Number(readOption('--interval') ?? 60);
// A match that is not over yet is checked again only after this long, because every team shares the upstream quota
const recheckSeconds = Number(readOption('--recheck') ?? 300);
const marketsToOpen = Number(readOption('--open') ?? 0);

const privateKey = readPrivateKey(readOption('--as') ?? 'agent');
const client = createClient(privateKey);
const address = readMarketAddress();

const paymentAsset = process.env.X402_ASSET ?? 'aUSD';
if (!isPaymentAsset(paymentAsset)) throw new Error('X402_ASSET must be aUSD or USDC');
const maxAmountPerCall = parseUnits(process.env.X402_MAX_PAYMENT ?? '0.10', PAYMENT_ASSET_DECIMALS);
const budget = parseUnits(process.env.X402_BUDGET ?? '1.00', PAYMENT_ASSET_DECIMALS);
const paying = createPayingFetch({
  payerPrivateKey: privateKey,
  asset: paymentAsset,
  maxAmountPerCall,
  budget,
  onPayment: ({ amount, spent, transaction }) =>
    log(
      `paid ${formatDollars(amount)} in ${paymentAsset} (spent ${formatDollars(spent)} of ${formatDollars(budget)})` +
        (transaction ? `: https://sepolia.basescan.org/tx/${transaction}` : '')
    ),
});

const log = (message: string) => console.log(`[agent ${new Date().toISOString().slice(11, 19)}] ${message}`);

// The market creator role: opens markets on upcoming matches that have both teams and no market yet
const openMarkets = async (count: number) => {
  const openedMatchIds = new Set((await readAllMarkets(client, address)).map(({ matchId }) => matchId));
  const candidates = (await listMatches('upcoming', 25)).filter(
    ({ id, teams, beginAt }) =>
      teams.length === 2 && beginAt && Date.parse(beginAt) > Date.now() + 60_000 && !openedMatchIds.has(BigInt(id))
  );
  for (const match of candidates.slice(0, count)) {
    const [teamA, teamB] = match.teams;
    if (!teamA || !teamB || !match.beginAt) continue;
    const closesAt = BigInt(Math.floor(Date.parse(match.beginAt) / 1000));
    const { request } = await client.simulateContract({
      address,
      abi: marketAbi,
      functionName: 'createMarket',
      args: [
        expectedRequestHash(match.id),
        BigInt(match.id),
        BigInt(teamA.id),
        BigInt(teamB.id),
        closesAt,
        closesAt + 7n * 24n * 60n * 60n,
      ],
    });
    const receipt = await client.waitForTransactionReceipt({
      hash: await client.writeContract({ ...request, chain: null }),
    });
    const [created] = parseEventLogs({ abi: marketAbi, eventName: 'MarketCreated', logs: receipt.logs });
    log(`opened market ${created?.args.marketId}: ${match.name}, staking closes ${formatTime(closesAt)}`);
  }
};

const lastChecked = new Map<bigint, number>();
let earned = 0n;

const checkMarkets = async () => {
  const markets = (await readAllMarkets(client, address)).filter(({ status }) => status === 'Open');
  for (const market of markets) {
    const now = Date.now() / 1000;
    if (now < Number(market.closesAt)) continue;
    if (now - (lastChecked.get(market.marketId) ?? 0) < recheckSeconds) continue;
    lastChecked.set(market.marketId, now);

    try {
      const outcome = await trySettle(client, address, market, paying.fetch);
      if (outcome.kind === 'settled') earned += outcome.fee;
      log(`market ${market.marketId} (match ${market.matchId}): ${outcome.kind}, ${outcome.detail}`);
      if (outcome.kind === 'settled') log(`earned ${formatEther(earned)} ETH in settler fees so far`);
    } catch (error) {
      log(`market ${market.marketId}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  }
  return markets.length;
};

log(`watching ${address} as ${client.account.address}`);
log(`schedule: check every ${intervalSeconds}s, ask about an unfinished match again after ${recheckSeconds}s`);
log(
  `x402: pays in ${paymentAsset} on Base Sepolia, at most ${formatDollars(maxAmountPerCall)} per call and ` +
    `${formatDollars(budget)} per run`
);
if (marketsToOpen > 0) await openMarkets(marketsToOpen);
do {
  // A failed check, such as an RPC or Airnode outage, is logged and retried on the next cycle rather than stopping
  // the agent. A market that failed waits --recheck seconds before it is tried again.
  try {
    const openCount = await checkMarkets();
    if (once) break;
    log(`${openCount} open market(s); next check in ${intervalSeconds}s`);
  } catch (error) {
    if (once) throw error;
    log(`check failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}; retrying`);
  }
  await sleep(intervalSeconds * 1000);
} while (true);
