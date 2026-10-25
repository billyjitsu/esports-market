import { formatEther } from 'viem';
import { createClient, formatTime, marketAbi, readAllMarkets, readMarketAddress } from './market.ts';

// Lists every market, and what the current account can claim from each: pnpm markets [--as alice]
const client = createClient();
const address = readMarketAddress();
const markets = await readAllMarkets(client, address);
if (markets.length === 0) console.log(`No markets yet on ${address}`);

for (const market of markets) {
  const claimable = await client.readContract({
    address,
    abi: marketAbi,
    functionName: 'claimable',
    args: [market.marketId, client.account.address],
  });
  const winner = market.status === 'Settled' ? `, winner ${market.winner}` : '';
  console.log(`Market ${market.marketId}  match ${market.matchId}  ${market.status}${winner}`);
  console.log(
    `  ${formatEther(market.totalA)} ETH on team ${market.teamA}, ${formatEther(market.totalB)} ETH on team ${market.teamB}`
  );
  console.log(`  Staking closes ${formatTime(market.closesAt)}, deadline ${formatTime(market.deadline)}`);
  if (claimable > 0n) console.log(`  ${client.account.address} can claim ${formatEther(claimable)} ETH`);
}
