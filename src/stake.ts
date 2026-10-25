import { formatEther, parseEther } from 'viem';
import { createClient, marketAbi, positionalArguments, readMarket, readMarketAddress } from './market.ts';

// Stakes ETH on a team: pnpm stake <market id> <A|B|team id> <ETH> [--as alice]
const [marketIdArgument, teamArgument, amountArgument] = positionalArguments();
if (!marketIdArgument || !teamArgument || !amountArgument) {
  throw new Error('Usage: pnpm stake <market id> <A|B|team id> <ETH> [--as alice]');
}
const marketId = BigInt(marketIdArgument);

const client = createClient();
const address = readMarketAddress();
const market = await readMarket(client, address, marketId);
const team =
  teamArgument.toUpperCase() === 'A'
    ? market.teamA
    : teamArgument.toUpperCase() === 'B'
      ? market.teamB
      : BigInt(teamArgument);

const { request } = await client.simulateContract({
  address,
  abi: marketAbi,
  functionName: 'stake',
  args: [marketId, team],
  value: parseEther(amountArgument),
});
const transactionHash = await client.writeContract({ ...request, chain: null });
await client.waitForTransactionReceipt({ hash: transactionHash });

const updated = await readMarket(client, address, marketId);
console.log(`${client.account.address} staked ${amountArgument} ETH on team ${team} in market ${marketId}`);
console.log(
  `  Pot: ${formatEther(updated.totalA)} ETH on ${updated.teamA}, ${formatEther(updated.totalB)} ETH on ${updated.teamB}`
);
