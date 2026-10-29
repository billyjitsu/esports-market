import { type Address, encodePacked, keccak256, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { SignedResponse } from './airnode-v2.ts';
import { fetchResult } from './keeper.ts';
import { type Client, describeRevert, marketAbi, readMarket } from './market.ts';
import { listMatches } from './pandascore.ts';

interface TamperCase {
  name: string;
  response: SignedResponse;
  shouldAccept: boolean;
  // Simulates the call at a later block time, to make a real result too old
  blockTime?: bigint;
}

// The tamper test from the hackathon brief, run against a deployed market without changing it: every case is an
// eth_call of settle(). A valid result must go through, and the four tampered ones must revert before anything happens.
// The Airnode charges for each call, so fetchFunction pays for them, as createScriptFetch in x402.ts does.
export const runTamperTest = async (
  client: Client,
  address: Address,
  marketId: bigint,
  fetchFunction: typeof fetch
) => {
  const market = await readMarket(client, address, marketId);
  const result = await fetchResult(market.matchId, fetchFunction);
  const maxResponseAge = await client.readContract({ address, abi: marketAbi, functionName: 'MAX_RESPONSE_AGE' });

  // One value edited: the winner swapped to the other team
  const data = JSON.parse(result.data) as { winnerId: number | null };
  data.winnerId = data.winnerId === Number(market.teamA) ? Number(market.teamB) : Number(market.teamA);
  const editedData = JSON.stringify(data);

  // A real result for another match, with the same projection
  const [otherMatch] = (await listMatches('past', 5, fetchFunction)).filter(({ id }) => BigInt(id) !== market.matchId);
  if (!otherMatch) throw new Error('Found no other match to take a result from');
  const otherResult = await fetchResult(otherMatch.id, fetchFunction);

  // The same result, signed the way an Airnode signs but with a key that is not the Airnode's
  const impostor = privateKeyToAccount(generatePrivateKey());
  const digest = keccak256(
    encodePacked(['bytes32', 'uint256', 'bytes'], [market.requestHash, BigInt(result.timestamp), toHex(result.data)])
  );
  const forgedSignature = await impostor.signMessage({ message: { raw: digest } });

  const cases: TamperCase[] = [
    { name: 'Valid result from the PandaScore Airnode', response: result, shouldAccept: true },
    { name: 'One value edited (winner swapped)', response: { ...result, data: editedData }, shouldAccept: false },
    {
      name: `Too old (checked ${maxResponseAge}s + 1s after signing)`,
      response: result,
      shouldAccept: false,
      blockTime: BigInt(result.timestamp) + maxResponseAge + 1n,
    },
    { name: `Answer to another request (match ${otherMatch.id})`, response: otherResult, shouldAccept: false },
    {
      name: 'Signed by a key that is not the Airnode',
      response: { ...result, signature: forgedSignature },
      shouldAccept: false,
    },
  ];

  console.log(`Tamper test on market ${marketId}, match ${market.matchId}, signed result ${result.data}\n`);
  let passed = true;
  for (const { name, response, shouldAccept, blockTime } of cases) {
    let outcome: string;
    let accepted: boolean;
    try {
      await client.simulateContract({
        address,
        abi: marketAbi,
        functionName: 'settle',
        args: [marketId, BigInt(response.timestamp), toHex(response.data), response.signature],
        ...(blockTime ? { blockOverrides: { time: blockTime } } : {}),
      });
      accepted = true;
      outcome = 'accepted';
    } catch (error) {
      accepted = false;
      outcome = `rejected: ${describeRevert(error)}`;
    }
    const ok = accepted === shouldAccept;
    passed &&= ok;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(48)} ${outcome}`);
  }
  console.log(passed ? '\nThe market passes the tamper test.' : '\nThe market FAILS the tamper test.');
  return passed;
};
