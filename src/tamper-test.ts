import { createClient, positionalArguments, readMarketAddress } from './market.ts';
import { runTamperTest } from './tamper.ts';

// Runs the hackathon's tamper test against an open market, without changing it: pnpm tamper-test <market id>
const [marketIdArgument] = positionalArguments();
if (!marketIdArgument) throw new Error('Usage: pnpm tamper-test <market id>');

const passed = await runTamperTest(createClient(), readMarketAddress(), BigInt(marketIdArgument));
process.exitCode = passed ? 0 : 1;
