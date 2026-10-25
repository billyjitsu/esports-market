import { trySettle } from './keeper.ts';
import { createClient, positionalArguments, readMarket, readMarketAddress } from './market.ts';

// Fetches the signed result of a market's match and settles it: pnpm settle <market id> [--as agent]
const [marketIdArgument] = positionalArguments();
if (!marketIdArgument) throw new Error('Usage: pnpm settle <market id> [--as agent]');

const client = createClient();
const address = readMarketAddress();
const market = await readMarket(client, address, BigInt(marketIdArgument));
const outcome = await trySettle(client, address, market);
console.log(`Market ${market.marketId}: ${outcome.kind}, ${outcome.detail}`);
if ('transactionHash' in outcome) console.log(`  Transaction ${outcome.transactionHash}`);
