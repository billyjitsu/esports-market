import { createWalletClient, formatEther, http, parseAbi, parseUnits, publicActions } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { readOption, readPrivateKey } from './market.ts';
import { AUSD_ADDRESS, AUSD_DECIMALS, formatDollars, readPayerPrivateKey } from './x402.ts';

// Shows the x402 payer's wallet on Base Sepolia, where Airnodes take payment, whatever chain the market is on:
//   pnpm payer                 balances, and how much aUSD the faucet still gives this account
//   pnpm payer --mint 5        mints aUSD from the faucet, which costs a little Base Sepolia ETH for gas
// The payer is PAYER_PRIVATE_KEY if set, or else the agent's key, unless --as names another.
const tokenAbi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function faucetLimit() view returns (uint256)',
  'function faucetMintedAmount(address account) view returns (uint256)',
  'function mintFromFaucet(uint256 amount)',
]);

const client = createWalletClient({
  account: privateKeyToAccount(readOption('--as') ? readPrivateKey() : readPayerPrivateKey()),
  chain: baseSepolia,
  transport: http(process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org'),
}).extend(publicActions);
const payer = client.account.address;
const aUsd = AUSD_ADDRESS;

const mintAmount = readOption('--mint');
if (mintAmount) {
  const { request } = await client.simulateContract({
    address: aUsd,
    abi: tokenAbi,
    functionName: 'mintFromFaucet',
    args: [parseUnits(mintAmount, AUSD_DECIMALS)],
  });
  const hash = await client.writeContract(request);
  await client.waitForTransactionReceipt({ hash });
  console.log(`Minted ${mintAmount} aUSD to ${payer}: https://sepolia.basescan.org/tx/${hash}`);
}

const [eth, ausd, faucetLimit, faucetMinted] = await Promise.all([
  client.getBalance({ address: payer }),
  client.readContract({ address: aUsd, abi: tokenAbi, functionName: 'balanceOf', args: [payer] }),
  client.readContract({ address: aUsd, abi: tokenAbi, functionName: 'faucetLimit' }),
  client.readContract({ address: aUsd, abi: tokenAbi, functionName: 'faucetMintedAmount', args: [payer] }),
]);
const faucetLeft = faucetLimit > faucetMinted ? faucetLimit - faucetMinted : 0n;

console.log(`x402 payer ${payer} on Base Sepolia`);
console.log(`  ETH   ${formatEther(eth)}   (only for minting from the faucet; x402 payments need none)`);
console.log(`  aUSD  ${formatDollars(ausd)}   (https://api3dao.github.io/airnodehub-hackathon/faucet/)`);
console.log(
  `  The faucet gives this account ${formatDollars(faucetLeft)} more aUSD (limit ${formatDollars(faucetLimit)})`
);
