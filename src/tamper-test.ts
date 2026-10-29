import { createClient, positionalArguments, readMarketAddress } from './market.ts';
import { runTamperTest } from './tamper.ts';
import { createScriptFetch } from './x402.ts';

// Runs the hackathon's tamper test against an open market, without changing it: pnpm tamper-test <market id>
// It pays for three Airnode calls over x402.
const [marketIdArgument] = positionalArguments();
if (!marketIdArgument) throw new Error('Usage: pnpm tamper-test <market id>');

const passed = await runTamperTest(createClient(), readMarketAddress(), BigInt(marketIdArgument), createScriptFetch());
process.exitCode = passed ? 0 : 1;
