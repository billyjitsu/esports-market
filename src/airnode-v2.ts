import { type Address, encodePacked, type Hex, isAddressEqual, keccak256, recoverMessageAddress, toHex } from 'viem';

// The body of a POST to an Airnode v2, as https://airnodehub-docs.api3.org/airnode/http-interface describes it.
export interface AirnodeV2Request {
  operation: string;
  parameters: Record<string, unknown>;
  // Maps each field of the projected response to the JSON Pointer of its value in the full response.
  responseProjection?: Record<string, string>;
}

// The same request through the passthrough: the provider's own method, path, query and body, sent under /api.
export interface AirnodeV2PassthroughRequest {
  method: 'GET' | 'POST';
  // The hash covers the path as sent, so encode each value in it with encodeURIComponent, as AirnodeHub does.
  path: string;
  // The hash covers the query in the order sent.
  query: [name: string, value: string][];
  // Only the header parameters that the Airnode declares, such as eBay's X-EBAY-C-MARKETPLACE-ID. The hash covers them.
  headers: [name: string, value: string][];
  // The hash covers the body byte for byte. Empty for a GET.
  body: string;
  responseProjection?: Record<string, string>;
}

export type AirnodeV2Route = 'post' | 'passthrough';

// A signed response with `data` as the exact string that the Airnode signed. A contract receives it as bytes.
export interface SignedResponse {
  airnode: Address;
  requestHash: Hex;
  timestamp: string;
  data: string;
  signature: Hex;
}

// The order in which the Airnode and Solidity compare strings: UTF-8 byte order, which is code point order.
const compareUtf8 = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

// Sorts object keys so that the same request always has the same hash.
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.entries(value)
    .toSorted(([a], [b]) => compareUtf8(a, b))
    .map(([key, nested]) => [key, canonicalize(nested)]);
};

// Needs no call to the Airnode, so a contract can store the hash before any response exists.
export const deriveRequestHash = ({ operation, parameters, responseProjection }: AirnodeV2Request): Hex => {
  const request = [operation, canonicalize(parameters)];
  const hashedRequest = responseProjection ? [...request, canonicalize(responseProjection)] : request;
  return keccak256(toHex(JSON.stringify(hashedRequest)));
};

// Header names ignore case and their order means nothing, so the Airnode lower-cases and sorts them. The query keeps its
// order, since the upstream receives it in that order.
export const derivePassthroughRequestHash = ({
  method,
  path,
  query,
  headers,
  body,
  responseProjection,
}: AirnodeV2PassthroughRequest): Hex => {
  const sortedHeaders = headers
    .map(([name, value]): [string, string] => [name.toLowerCase(), value])
    .toSorted(([a], [b]) => compareUtf8(a, b));
  const request = ['passthrough', method, path, query, sortedHeaders, body];
  const hashedRequest = responseProjection ? [...request, canonicalize(responseProjection)] : request;
  return keccak256(toHex(JSON.stringify(hashedRequest)));
};

// Both fetch functions take the fetch to call the Airnode with. Pass one from createPayingFetch in x402.ts to pay for a
// priced operation.
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

  return (await response.json()) as SignedResponse;
};

const buildPassthroughUrl = (
  airnodeUrl: string,
  { path, query, responseProjection = {} }: AirnodeV2PassthroughRequest
) => {
  const projectedFields = Object.entries(responseProjection).map(([field, pointer]) => [
    'x-airnode-project',
    `${field}:${pointer}`,
  ]);
  const url = new URL(`api${path}`, airnodeUrl);
  url.search = new URLSearchParams([...query, ...projectedFields]).toString();
  return url;
};

export const fetchSignedPassthroughResponse = async (
  airnodeUrl: string,
  request: AirnodeV2PassthroughRequest,
  fetchFunction: typeof fetch = fetch
): Promise<SignedResponse> => {
  const hasBody = request.body !== '';
  const response = await fetchFunction(buildPassthroughUrl(airnodeUrl, request), {
    method: request.method,
    // The hash leaves out Content-Type, so it is not one of the request's headers.
    headers: hasBody ? [...request.headers, ['Content-Type', 'application/json']] : request.headers,
    body: hasBody ? request.body : undefined,
  });
  if (!response.ok) throw new Error(`The Airnode responded with ${response.status}: ${await response.text()}`);

  const readHeader = (name: string) => {
    const value = response.headers.get(name);
    if (!value) throw new Error(`The response has no ${name} header, so it is not signed`);
    return value;
  };
  return {
    airnode: readHeader('X-Airnode-Address') as Address,
    requestHash: readHeader('X-Airnode-Request-Hash') as Hex,
    timestamp: readHeader('X-Airnode-Timestamp'),
    // The body is the data, and the signature covers it as received.
    data: await response.text(),
    signature: readHeader('X-Airnode-Signature') as Hex,
  };
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
