import { type Address, formatEther, parseEventLogs, toHex } from 'viem';
import { deriveRequestHash, fetchSignedResponse, type SignedResponse, verifySignedResponse } from './airnode-v2.ts';
import { type Client, type Market, marketAbi } from './market.ts';
import { buildResultRequest, PANDASCORE_AIRNODE_ADDRESS, PANDASCORE_AIRNODE_URL } from './pandascore.ts';

export const expectedRequestHash = (matchId: bigint | number) => deriveRequestHash(buildResultRequest(matchId));

// Fetches the signed result of a match and makes the contract's signer and request checks off-chain, so a bad response
// fails before it costs gas.
export const fetchResult = async (matchId: bigint | number, fetchFunction?: typeof fetch): Promise<SignedResponse> => {
  const request = buildResultRequest(matchId);
  const result = await fetchSignedResponse(PANDASCORE_AIRNODE_URL, request, fetchFunction);
  await verifySignedResponse(result, PANDASCORE_AIRNODE_ADDRESS, deriveRequestHash(request));
  return result;
};

export type SettleOutcome =
  | { kind: 'settled'; detail: string; transactionHash: string; fee: bigint }
  | { kind: 'voided'; detail: string; transactionHash: string }
  | { kind: 'waiting'; detail: string }
  | { kind: 'skipped'; detail: string };

// Settles one market if its match is over: what a person runs with `pnpm settle`, and what the keeper agent runs for
// every open market.
export const trySettle = async (
  client: Client,
  address: Address,
  market: Market,
  fetchFunction?: typeof fetch
): Promise<SettleOutcome> => {
  if (market.status !== 'Open') return { kind: 'skipped', detail: `market is ${market.status}` };
  // Anyone can open a market, so only settle one whose request hash really is the result request for its match.
  if (expectedRequestHash(market.matchId) !== market.requestHash) {
    return { kind: 'skipped', detail: `request hash is not the result request for match ${market.matchId}` };
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now < market.closesAt) return { kind: 'waiting', detail: 'staking is still open' };
  if (now > market.deadline) {
    const transactionHash = await client.writeContract({
      address,
      abi: marketAbi,
      functionName: 'voidAfterDeadline',
      args: [market.marketId],
      chain: null,
    });
    await client.waitForTransactionReceipt({ hash: transactionHash });
    return { kind: 'voided', detail: 'deadline passed', transactionHash };
  }

  const result = await fetchResult(market.matchId, fetchFunction);
  const { status } = JSON.parse(result.data) as { status: string };
  if (status !== 'finished' && status !== 'canceled') return { kind: 'waiting', detail: `match is ${status}` };

  const args = [market.marketId, BigInt(result.timestamp), toHex(result.data), result.signature] as const;
  // Simulating first turns a revert into its custom error instead of a failed transaction
  const { request } = await client.simulateContract({ address, abi: marketAbi, functionName: 'settle', args });
  const transactionHash = await client.writeContract({ ...request, chain: null });
  const receipt = await client.waitForTransactionReceipt({ hash: transactionHash });

  const [settled] = parseEventLogs({ abi: marketAbi, eventName: 'MarketSettled', logs: receipt.logs });
  if (settled) {
    const { winner, fee } = settled.args;
    return {
      kind: 'settled',
      detail: `team ${winner} won, settler fee ${formatEther(fee)} ETH, signed result ${result.data}`,
      transactionHash,
      fee,
    };
  }
  const [voided] = parseEventLogs({ abi: marketAbi, eventName: 'MarketVoided', logs: receipt.logs });
  return { kind: 'voided', detail: voided?.args.reason ?? 'voided', transactionHash };
};
