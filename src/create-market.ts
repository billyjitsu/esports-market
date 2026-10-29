import { parseEventLogs } from 'viem';
import { expectedRequestHash } from './keeper.ts';
import { createClient, formatTime, marketAbi, positionalArguments, readMarketAddress, readOption } from './market.ts';
import { getMatch } from './pandascore.ts';
import { createScriptFetch } from './x402.ts';

// Opens a market on a PandaScore match: pnpm create-market <match id> [--closes-in <seconds>] [--deadline-days <days>]
// Staking closes when the match begins. --closes-in overrides that, which lets a demo open a market on a match that has
// already finished and settle it a minute later.
const [matchIdArgument] = positionalArguments();
const matchId = BigInt(matchIdArgument ?? Number.NaN);
const closesIn = readOption('--closes-in');
const deadlineDays = Number(readOption('--deadline-days') ?? 7);

// Paid over x402
const match = await getMatch(matchId, createScriptFetch());
const [teamA, teamB] = match.teams;
if (!teamA || !teamB) throw new Error(`Match ${matchId} does not have both teams yet`);

const now = Math.floor(Date.now() / 1000);
const beginsAt = match.beginAt ? Math.floor(Date.parse(match.beginAt) / 1000) : undefined;
const closesAt = closesIn ? now + Number(closesIn) : beginsAt;
if (!closesAt || closesAt <= now) {
  throw new Error(
    `Match ${matchId} began at ${match.beginAt}. Pass --closes-in <seconds> to open a demo market anyway.`
  );
}
const deadline = closesAt + deadlineDays * 24 * 60 * 60;

// The request hash fixes the match and the fields that settle it, so derive it here rather than trust anyone else's.
const requestHash = expectedRequestHash(matchId);
const client = createClient();
const address = readMarketAddress();
const { request } = await client.simulateContract({
  address,
  abi: marketAbi,
  functionName: 'createMarket',
  args: [requestHash, matchId, BigInt(teamA.id), BigInt(teamB.id), BigInt(closesAt), BigInt(deadline)],
});
const transactionHash = await client.writeContract({ ...request, chain: null });
const receipt = await client.waitForTransactionReceipt({ hash: transactionHash });
const [created] = parseEventLogs({ abi: marketAbi, eventName: 'MarketCreated', logs: receipt.logs });

console.log(`Opened market ${created?.args.marketId} on ${match.name} (match ${matchId}, ${match.status})`);
console.log(`  Team A: ${teamA.name} (${teamA.id})`);
console.log(`  Team B: ${teamB.name} (${teamB.id})`);
console.log(`  Staking closes ${formatTime(closesAt)}, refunds open after ${formatTime(deadline)}`);
console.log(`  Request hash ${requestHash}`);
console.log(`  Transaction ${transactionHash}`);
