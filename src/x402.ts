import { ExactEvmScheme } from '@x402/evm';
import { decodePaymentResponseHeader, wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { formatUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// Pays for priced Airnode calls over x402 with the official @x402/fetch client, the way the hackathon starter does
// (https://github.com/api3dao/airnodehub-hackathon-starter/blob/main/src/x402.ts), with two spending limits on top for
// an agent that runs on its own: a most per call and a most per run.

// Base Sepolia, a testnet, where the Airnodes take payment, so a priced call costs nothing real.
export const BASE_SEPOLIA = 'eip155:84532';

// The Airnodes accept both and charge the same amount in each. USDC comes from https://faucet.circle.com, and AirnodeHub
// USD (aUSD) from https://api3dao.github.io/airnodehub-hackathon/faucet/. Both have 6 decimals.
export const PAYMENT_ASSET_ADDRESSES = {
  USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  aUSD: '0xbeA34973e5f67F18F656A2C6070C64326C791808',
} as const;
export const PAYMENT_ASSET_DECIMALS = 6;

export type PaymentAsset = keyof typeof PAYMENT_ASSET_ADDRESSES;

export const isPaymentAsset = (asset: string): asset is PaymentAsset => Object.hasOwn(PAYMENT_ASSET_ADDRESSES, asset);

export const formatDollars = (amount: bigint) => `$${formatUnits(amount, PAYMENT_ASSET_DECIMALS)}`;

export interface PayingFetchOptions {
  payerPrivateKey: Hex;
  // The asset that the payer holds. The Airnode offers every asset it accepts, and the payer pays only in this one.
  asset: PaymentAsset;
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

// Returns a fetch that answers a 402 by signing the payment that the Airnode asks for and sending the call again. The
// payer needs the asset on Base Sepolia but no ETH, because the x402 facilitator submits the transfer and pays its gas.
// A call that would go over either limit is not paid, and fails instead.
export const createPayingFetch = (options: PayingFetchOptions, fetchFunction: typeof fetch = fetch) => {
  const assetAddress = PAYMENT_ASSET_ADDRESSES[options.asset].toLowerCase();
  let spent = 0n;
  let chosenAmount: bigint | undefined;

  const payingFetch = wrapFetchWithPaymentFromConfig(fetchFunction, {
    schemes: [{ network: BASE_SEPOLIA, client: new ExactEvmScheme(privateKeyToAccount(options.payerPrivateKey)) }],
    // The client pays only in assets that it knows, such as USDC, unless it is told to accept another, so aUSD is
    // listed here. Both caps match the per-call limit.
    spendControls: {
      maxAmountPerPayment: formatDollars(options.maxAmountPerCall),
      allowedAssets: [
        {
          network: BASE_SEPOLIA,
          asset: PAYMENT_ASSET_ADDRESSES.aUSD,
          maxAmountPerPayment: options.maxAmountPerCall.toString(),
        },
      ],
    },
    policies: [
      (_x402Version, requirements) => {
        const affordable = requirements.filter(
          ({ asset, amount }) =>
            asset.toLowerCase() === assetAddress &&
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
