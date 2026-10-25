import { formatEther, parseEventLogs } from 'viem';
import { createClient, marketAbi, positionalArguments, readMarketAddress } from './market.ts';

// Claims winnings, or a refund from a voided market: pnpm claim <market id> [--as alice]
const [marketIdArgument] = positionalArguments();
if (!marketIdArgument) throw new Error('Usage: pnpm claim <market id> [--as alice]');

const client = createClient();
const address = readMarketAddress();
const { request } = await client.simulateContract({
  address,
  abi: marketAbi,
  functionName: 'claim',
  args: [BigInt(marketIdArgument)],
});
const transactionHash = await client.writeContract({ ...request, chain: null });
const receipt = await client.waitForTransactionReceipt({ hash: transactionHash });
const [claimed] = parseEventLogs({ abi: marketAbi, eventName: 'Claimed', logs: receipt.logs });
console.log(
  `${client.account.address} claimed ${formatEther(claimed?.args.amount ?? 0n)} ETH from market ${marketIdArgument}`
);
