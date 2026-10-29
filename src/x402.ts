import { ExactEvmScheme } from '@x402/evm';
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { formatUnits, type Hex, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readPrivateKey } from './market.ts';

// Pays for priced Airnode calls over x402 with the official @x402/fetch client, the way the hackathon starter does
// (https://github.com/api3dao/airnodehub-hackathon-starter/blob/main/src/x402.ts), with two spending limits on top for
// an agent that runs on its own: a most per call and a most per run.

// Base Sepolia, a testnet, where the Airnodes take payment, so a priced call costs nothing real.
export const BASE_SEPOLIA = 'eip155:84532' as const;

// AirnodeHub USD (aUSD), the only asset that the Airnodes accept. It has 6 decimals and comes from the faucet at
// https://api3dao.github.io/airnodehub-hackathon/faucet/, or from `pnpm payer --mint`.
export const AUSD_ADDRESS = '0xbeA34973e5f67F18F656A2C6070C64326C791808';
export const AUSD_DECIMALS = 6;

export const formatDollars = (amount: bigint) => `$${formatUnits(amount, AUSD_DECIMALS)}`;

// The key that pays for priced calls: PAYER_PRIVATE_KEY when set, as in the starter, or else the agent's key. On anvil,
// set PAYER_PRIVATE_KEY to a key that holds aUSD on Base Sepolia, because the payments happen there whatever chain the
// market is on.
export const readPayerPrivateKey = (fallbackName = 'agent') =>
  process.env.PAYER_PRIVATE_KEY ? readPrivateKey('payer') : readPrivateKey(fallbackName);

export interface PayingFetchOptions {
  payerPrivateKey: Hex;
  // Most that one call may cost, in atomic units, so 100_000n is $0.10
  maxAmountPerCall: bigint;
  // Most that all calls together may cost, in atomic units
  budget: bigint;
  onPayment?: (payment: { amount: bigint; spent: bigint; transaction: string | undefined }) => void;
}

// The Airnode answers a paid call with the settlement of the payment in the PAYMENT-RESPONSE header, such as the
// transaction that moved the payment. A call that was not paid has no settlement.
export const readPaymentSettlement = (response: Response) => {
  const header = response.headers.get('PAYMENT-RESPONSE');
  return header ? decodePaymentResponseHeader(header) : undefined;
};

// Returns a fetch that answers a 402 by signing the aUSD payment that the Airnode asks for and sending the call again.
// The payer needs aUSD on Base Sepolia but no ETH, because the x402 facilitator submits the transfer and pays its gas.
// A call that would go over either limit is not paid, and fails instead.
export const createPayingFetch = (options: PayingFetchOptions, fetchFunction: typeof fetch = fetch) => {
  let spent = 0n;
  let chosenAmount: bigint | undefined;

  const payingFetch = wrapFetchWithPaymentFromConfig(fetchFunction, {
    schemes: [{ network: BASE_SEPOLIA, client: new ExactEvmScheme(privateKeyToAccount(options.payerPrivateKey)) }],
    // The client pays only in assets that it knows, such as USDC, unless it is told to accept another, so aUSD is
    // listed here. Both caps match the per-call limit.
    spendControls: {
      maxAmountPerPayment: formatDollars(options.maxAmountPerCall),
      allowedAssets: [
        { network: BASE_SEPOLIA, asset: AUSD_ADDRESS, maxAmountPerPayment: options.maxAmountPerCall.toString() },
      ],
    },
    // The client would also pay in the assets that it knows, so keep only aUSD, within both limits
    policies: [
      (_x402Version, requirements) => {
        const affordable = requirements.filter(
          ({ asset, amount }) =>
            asset.toLowerCase() === AUSD_ADDRESS.toLowerCase() &&
            BigInt(amount) <= options.maxAmountPerCall &&
            spent + BigInt(amount) <= options.budget
        );
        chosenAmount = affordable[0] ? BigInt(affordable[0].amount) : undefined;
        return affordable;
      },
    ],
  });

  const fetchWithinBudget: typeof fetch = async (input, init) => {
    chosenAmount = undefined;
    const response = await payingFetch(input, init);
    const settlement = readPaymentSettlement(response);
    if (settlement?.success && chosenAmount !== undefined) {
      spent += chosenAmount;
      options.onPayment?.({ amount: chosenAmount, spent, transaction: settlement.transaction });
    }
    return response;
  };

  return { fetch: fetchWithinBudget, spent: () => spent };
};

// The limits from X402_MAX_PAYMENT and X402_BUDGET, in dollars
export const readSpendingLimits = () => ({
  maxAmountPerCall: parseUnits(process.env.X402_MAX_PAYMENT ?? '0.10', AUSD_DECIMALS),
  budget: parseUnits(process.env.X402_BUDGET ?? '1.00', AUSD_DECIMALS),
});

// The fetch that the scripts call the Airnode with: it pays from the payer key within the limits above, prints each
// payment, and explains a 402 that it could not pay.
export const createScriptFetch = (log: (message: string) => void = console.error): typeof fetch => {
  const payerPrivateKey = readPayerPrivateKey();
  const payer = privateKeyToAccount(payerPrivateKey).address;
  const limits = readSpendingLimits();
  const paying = createPayingFetch({
    payerPrivateKey,
    ...limits,
    onPayment: ({ amount, spent, transaction }) =>
      log(
        `x402: paid ${formatDollars(amount)} in aUSD (spent ${formatDollars(spent)} of ${formatDollars(limits.budget)})` +
          (transaction ? `: https://sepolia.basescan.org/tx/${transaction}` : '')
      ),
  });
  return async (input, init) => {
    const response = await paying.fetch(input, init);
    if (response.status === 402) {
      throw new Error(
        `The Airnode asked for payment, and ${payer} did not pay it. That account needs aUSD on Base Sepolia ` +
          '(check with `pnpm payer`, mint with `pnpm payer --mint 5`), and the price must be within X402_MAX_PAYMENT ' +
          'and what is left of X402_BUDGET. Set PAYER_PRIVATE_KEY to pay from another account.'
      );
    }
    return response;
  };
};
