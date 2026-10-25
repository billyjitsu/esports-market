import { type Address, encodePacked, type Hex, isAddressEqual, keccak256, recoverMessageAddress, toHex } from 'viem';

// The body of a POST to an Airnode v2, as https://airnodehub-docs.api3.org/airnode/http-interface describes it.
export interface AirnodeV2Request {
  operation: string;
  parameters: Record<string, unknown>;
  // Maps each field of the projected response to the JSON Pointer of its value in the full response.
  responseProjection?: Record<string, string>;
}

// A signed response with `data` as the exact string that the Airnode signed. A contract receives it as bytes.
export interface SignedResponse {
  airnode: Address;
  requestHash: Hex;
  timestamp: string;
  data: string;
  signature: Hex;
}

// The body that an Airnode answers a POST with, where `data` is the parsed JSON.
type AirnodeV2Response = Omit<SignedResponse, 'data'> & { data: unknown };

// Sorts object keys the way the Airnode does, with localeCompare, so the same request always has the same hash.
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.entries(value)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => [key, canonicalize(nested)]);
};

// Needs no call to the Airnode, so a contract can store the hash before any response exists.
export const deriveRequestHash = ({ operation, parameters, responseProjection }: AirnodeV2Request): Hex => {
  const request = [operation, canonicalize(parameters)];
  const hashedRequest = responseProjection ? [...request, canonicalize(responseProjection)] : request;
  return keccak256(toHex(JSON.stringify(hashedRequest)));
};

// `fetchFunction` lets a caller that pays for priced operations, such as the keeper agent, swap in a fetch that answers
// a 402 with an x402 payment.
export const fetchSignedResponse = async (
  airnodeUrl: string,
  request: AirnodeV2Request,
  fetchFunction: typeof fetch = fetch
): Promise<SignedResponse> => {
  const response = await fetchFunction(airnodeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(`The Airnode responded with ${response.status}: ${await response.text()}`);

  const { airnode, requestHash, timestamp, data, signature } = (await response.json()) as AirnodeV2Response;
  // The Airnode signs JSON data as JSON.stringify writes it, and JSON.parse keeps the key order, so this gives back the
  // signed bytes exactly.
  return { airnode, requestHash, timestamp, data: typeof data === 'string' ? data : JSON.stringify(data), signature };
};

export const recoverSigner = ({ requestHash, timestamp, data, signature }: SignedResponse): Promise<Address> =>
  recoverMessageAddress({
    message: {
      raw: keccak256(encodePacked(['bytes32', 'uint256', 'bytes'], [requestHash, BigInt(timestamp), toHex(data)])),
    },
    signature,
  });

// Makes the same signer and request checks as AirnodeV2Attestation.verify, so a bad response fails before it costs gas.
export const verifySignedResponse = async (response: SignedResponse, airnode: Address, requestHash: Hex) => {
  if (response.requestHash !== requestHash) {
    throw new Error(`The response answers the request ${response.requestHash}, not ${requestHash}`);
  }
  const signer = await recoverSigner({ ...response, requestHash });
  if (!isAddressEqual(signer, airnode)) throw new Error(`The response is signed by ${signer}, not by ${airnode}`);
};
