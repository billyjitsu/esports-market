import { formatEther, parseEther, parseEventLogs } from 'viem';
import { expectedRequestHash, trySettle } from './keeper.ts';
import {
  createClient,
  formatTime,
  marketAbi,
  readMarket,
  readMarketAddress,
  readOption,
  readPrivateKey,
  sleep,
} from './market.ts';
import { listMatches } from './pandascore.ts';
import { runTamperTest } from './tamper.ts';

// The whole flow in one run, for rehearsing or presenting on a local chain:
// open a market on a match that just finished, two people stake, staking closes, the tamper test runs, the keeper
// agent settles with the signed result, and the winner claims.
const closesInSeconds = 20;
// Bob stakes this much ETH and Alice twice as much. Use a small amount on a testnet: pnpm demo --stake 0.002
const stake = parseEther(readOption('--stake') ?? '1');

const creator = createClient();
const alice = createClient(readPrivateKey('alice'));
const bob = createClient(readPrivateKey('bob'));
const agent = createClient(readPrivateKey('agent'));
const address = readMarketAddress();
if (!(await creator.getCode({ address }))) throw new Error(`No contract at ${address}. Deploy it first (see README).`);

const step = (text: string) => console.log(`\n== ${text}`);

step('1. Pick a match that has finished and has a winner');
const match = (await listMatches('past', 10)).find(({ teams, winnerId }) => teams.length === 2 && winnerId);
const [teamA, teamB] = match?.teams ?? [];
if (!match || !teamA || !teamB) throw new Error('Found no finished match with a winner');
console.log(`${match.name} (match ${match.id}), ${match.videogame}, ${match.league}`);
console.log(`Team A: ${teamA.name} (${teamA.id})   Team B: ${teamB.name} (${teamB.id})`);
console.log('A real market closes before the match starts. This demo uses a finished match so it can settle now.');

step('2. Open a market');
const closesAt = BigInt(Math.floor(Date.now() / 1000) + closesInSeconds);
const { request: createRequest } = await creator.simulateContract({
  address,
  abi: marketAbi,
  functionName: 'createMarket',
  args: [
    expectedRequestHash(match.id),
    BigInt(match.id),
    BigInt(teamA.id),
    BigInt(teamB.id),
    closesAt,
    closesAt + 86_400n,
  ],
});
const createReceipt = await creator.waitForTransactionReceipt({
  hash: await creator.writeContract({ ...createRequest, chain: null }),
});
const marketId = parseEventLogs({ abi: marketAbi, eventName: 'MarketCreated', logs: createReceipt.logs })[0]?.args
  .marketId;
if (!marketId) throw new Error('No MarketCreated event');
console.log(
  `Market ${marketId}, request hash ${expectedRequestHash(match.id)}, staking closes ${formatTime(closesAt)}`
);

step(`3. Alice stakes ${formatEther(stake * 2n)} ETH on team A, Bob stakes ${formatEther(stake)} ETH on team B`);
for (const [client, team, amount] of [
  [alice, teamA.id, stake * 2n],
  [bob, teamB.id, stake],
] as const) {
  const { request } = await client.simulateContract({
    address,
    abi: marketAbi,
    functionName: 'stake',
    args: [marketId, BigInt(team)],
    value: amount,
  });
  await client.waitForTransactionReceipt({ hash: await client.writeContract({ ...request, chain: null }) });
  console.log(`${client.account.address} staked ${formatEther(amount)} ETH on ${team}`);
}

// The Airnode stamps its responses with its own clock, and a response signed before closesAt cannot settle, so wait a
// few seconds past closesAt in case this computer's clock runs ahead of the Airnode's.
const clockMarginSeconds = 10;
step(`4. Wait for staking to close (${closesInSeconds + clockMarginSeconds}s)`);
while (Date.now() / 1000 <= Number(closesAt) + clockMarginSeconds) await sleep(1000);
// A new block, so the chain's time moves past closesAt too
await creator.request({ method: 'evm_mine' as never, params: [] as never }).catch(() => undefined);

step('5. Tamper test: what the judges run');
await runTamperTest(agent, address, marketId);

step('6. The keeper agent buys the signed result and settles');
const agentBalanceBefore = await agent.getBalance({ address: agent.account.address });
const outcome = await trySettle(agent, address, await readMarket(agent, address, marketId));
console.log(`${outcome.kind}: ${outcome.detail}`);

step('7. The winners claim');
const market = await readMarket(agent, address, marketId);
for (const [name, client] of [
  ['Alice', alice],
  ['Bob', bob],
] as const) {
  const claimable = await client.readContract({
    address,
    abi: marketAbi,
    functionName: 'claimable',
    args: [marketId, client.account.address],
  });
  if (claimable === 0n) {
    console.log(`${name} has nothing to claim`);
    continue;
  }
  const { request } = await client.simulateContract({
    address,
    abi: marketAbi,
    functionName: 'claim',
    args: [marketId],
  });
  await client.waitForTransactionReceipt({ hash: await client.writeContract({ ...request, chain: null }) });
  console.log(`${name} claimed ${formatEther(claimable)} ETH`);
}
const agentBalanceAfter = await agent.getBalance({ address: agent.account.address });
console.log(
  `\nMarket ${marketId} is ${market.status}${market.status === 'Settled' ? `, winner ${market.winner}` : ''}.`
);
console.log(
  `The agent's balance changed by ${formatEther(agentBalanceAfter - agentBalanceBefore)} ETH (fee minus gas).`
);
