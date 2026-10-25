import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { deriveRequestHash, type SignedResponse, verifySignedResponse } from './airnode-v2.ts';
import { buildResultRequest, PANDASCORE_AIRNODE_ADDRESS } from './pandascore.ts';

// Saved with `pnpm --silent fetch-result <match id>`.
const readFixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), 'utf8')) as SignedResponse;

const result = readFixture('match-1200600.json');
const requestHash = deriveRequestHash(buildResultRequest(1200600));

test('derives the request hash that the Airnode signed', () => {
  assert.equal(requestHash, result.requestHash);
  assert.equal(deriveRequestHash(buildResultRequest(1760362)), readFixture('match-1760362.json').requestHash);
});

test('accepts a result that the Airnode signed', async () => {
  await verifySignedResponse(result, PANDASCORE_AIRNODE_ADDRESS, requestHash);
});

test('rejects a result with an edited winner', async () => {
  const editedResult = { ...result, data: result.data.replace('"winnerId":135505', '"winnerId":135743') };
  assert.notEqual(editedResult.data, result.data);
  await assert.rejects(verifySignedResponse(editedResult, PANDASCORE_AIRNODE_ADDRESS, requestHash), /signed by/);
});

test('rejects a result for another match', async () => {
  const otherResult = readFixture('match-1760362.json');
  await assert.rejects(verifySignedResponse(otherResult, PANDASCORE_AIRNODE_ADDRESS, requestHash), /answers/);
  const relabeledResult = { ...otherResult, requestHash };
  await assert.rejects(verifySignedResponse(relabeledResult, PANDASCORE_AIRNODE_ADDRESS, requestHash), /signed by/);
});
