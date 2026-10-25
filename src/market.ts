import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  type Hex,
  http,
  isAddress,
  isHex,
  parseAbi,
  publicActions,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const marketAbi = parseAbi([
  'function createMarket(bytes32 requestHash, uint64 matchId, uint64 teamA, uint64 teamB, uint64 closesAt, uint64 deadline) returns (uint256 marketId)',
  'function stake(uint256 marketId, uint64 team) payable',
  'function settle(uint256 marketId, uint256 timestamp, bytes data, bytes signature)',
  'function voidAfterDeadline(uint256 marketId)',
  'function claim(uint256 marketId)',
  'function claimable(uint256 marketId, address staker) view returns (uint256)',
  'function marketCount() view returns (uint256)',
  'function markets(uint256 marketId) view returns (bytes32 requestHash, uint64 matchId, uint64 teamA, uint64 teamB, uint64 closesAt, uint64 deadline, uint64 winner, uint8 status, uint256 totalA, uint256 totalB, uint256 payout)',
  'function airnode() view returns (address)',
  'function MAX_RESPONSE_AGE() view returns (uint256)',
  'event MarketCreated(uint256 indexed marketId, uint64 indexed matchId, bytes32 requestHash, uint64 teamA, uint64 teamB, uint64 closesAt, uint64 deadline)',
  'event Staked(uint256 indexed marketId, address indexed staker, uint64 team, uint256 amount)',
  'event MarketSettled(uint256 indexed marketId, uint64 winner, address indexed settler, uint256 fee)',
  'event MarketVoided(uint256 indexed marketId, string reason)',
  'event Claimed(uint256 indexed marketId, address indexed staker, uint256 amount)',
  'error NotSignedByAirnode(address signer)',
  'error InvalidTeams()',
  'error InvalidTimes()',
  'error MarketNotOpen(uint256 marketId)',
  'error StakingClosed(uint256 marketId)',
  'error UnknownTeam(uint64 team)',
  'error NoStake()',
  'error ResponseTooOld(uint256 responseTimestamp)',
  'error SignedBeforeClose(uint256 responseTimestamp)',
  'error TeamsDoNotMatch(uint256 teamA, uint256 teamB)',
  'error MatchNotOver(string status)',
  'error UnknownWinner(uint256 winner)',
  'error DeadlineNotReached(uint256 marketId)',
  'error NothingToClaim(uint256 marketId)',
  'error TransferFailed()',
  'error FieldNotFound(string key)',
  'error UnexpectedValue(string key)',
]);

export const MARKET_STATUSES = ['None', 'Open', 'Settled', 'Voided'] as const;

export const readEnvironmentVariable = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in .env or in the environment`);
  return value;
};

export const readMarketAddress = (): Address => {
  const address = readEnvironmentVariable('MARKET_ADDRESS');
  if (!isAddress(address)) throw new Error('MARKET_ADDRESS is not an address');
  return address;
};

// Scripts act as the account whose key is in PRIVATE_KEY, or with `--as alice` in ALICE_PRIVATE_KEY, so a demo can
// switch between the people in it.
export const readPrivateKey = (role = readOption('--as')): Hex => {
  const name = role ? `${role.toUpperCase()}_PRIVATE_KEY` : 'PRIVATE_KEY';
  const privateKey = readEnvironmentVariable(name);
  if (!isHex(privateKey)) throw new Error(`${name} is not a 0x-prefixed hex string`);
  return privateKey;
};

export const createClient = (privateKey: Hex = readPrivateKey()) =>
  createWalletClient({
    account: privateKeyToAccount(privateKey),
    transport: http(readEnvironmentVariable('RPC_URL')),
  }).extend(publicActions);

export type Client = ReturnType<typeof createClient>;

export const readMarket = async (client: Client, address: Address, marketId: bigint) => {
  const [requestHash, matchId, teamA, teamB, closesAt, deadline, winner, status, totalA, totalB, payout] =
    await client.readContract({ address, abi: marketAbi, functionName: 'markets', args: [marketId] });
  return {
    marketId,
    requestHash,
    matchId,
    teamA,
    teamB,
    closesAt,
    deadline,
    winner,
    status: MARKET_STATUSES[status] ?? 'None',
    totalA,
    totalB,
    payout,
  };
};

export type Market = Awaited<ReturnType<typeof readMarket>>;

export const readAllMarkets = async (client: Client, address: Address) => {
  const count = await client.readContract({ address, abi: marketAbi, functionName: 'marketCount' });
  return Promise.all(
    Array.from({ length: Number(count) }, (_, index) => readMarket(client, address, BigInt(index + 1)))
  );
};

// Turns a revert into its custom error, such as NotSignedByAirnode(0x…), which is what the tamper test shows.
export const describeRevert = (error: unknown) => {
  if (error instanceof BaseError) {
    const revert = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data) {
      const args = (revert.data.args ?? []).map(String).join(', ');
      return `${revert.data.errorName}(${args})`;
    }
    return error.shortMessage;
  }
  return String(error);
};

// Reads `--name value` from the command line.
export function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export const positionalArguments = () => {
  const values: string[] = [];
  for (let index = 2; index < process.argv.length; index++) {
    const argument = process.argv[index] ?? '';
    if (argument.startsWith('--')) index++;
    else values.push(argument);
  }
  return values;
};

export const formatTime = (seconds: bigint | number) => new Date(Number(seconds) * 1000).toISOString();

export const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
