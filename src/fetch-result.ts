import { deriveRequestHash, fetchSignedResponse, verifySignedResponse } from './airnode-v2.ts';
import { buildResultRequest, PANDASCORE_AIRNODE_ADDRESS, PANDASCORE_AIRNODE_URL } from './pandascore.ts';

// Prints the signed result of a match, with `data` as the exact string that the Airnode signed, for example to save it
// as a test fixture: pnpm --silent fetch-result 1200600 > test/fixtures/match-1200600.json
const matchId = Number(process.argv[2]);
if (!Number.isSafeInteger(matchId) || matchId <= 0) throw new Error('Usage: pnpm fetch-result <PandaScore match id>');

const request = buildResultRequest(matchId);
const signedResponse = await fetchSignedResponse(PANDASCORE_AIRNODE_URL, request);
await verifySignedResponse(signedResponse, PANDASCORE_AIRNODE_ADDRESS, deriveRequestHash(request));
console.log(JSON.stringify(signedResponse, null, 2));
