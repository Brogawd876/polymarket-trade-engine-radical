import "dotenv/config";
import { Wallet } from "@ethersproject/wallet";
import { ClobClient, Chain, AssetType } from "@polymarket/clob-client-v2";
import {
  deriveDepositWallet,
} from "@polymarket/builder-relayer-client";
import { getContractConfig } from "@polymarket/builder-relayer-client/dist/config";

const OWNER = "0x3528764a45bB13eC6BD8Deb1a73b5034742E6329";
const EXPECTED_FUNDER = "0x9bB7C3aafCeb82665293f9cd784F61112fFa4c51";
const CLOB_HOST = "https://clob.polymarket.com";

const staticCredentialVars = [
  "POLY_API_KEY",
  "POLY_API_SECRET",
  "POLY_API_PASSPHRASE",
  "BUILDER_KEY",
  "BUILDER_SECRET",
  "BUILDER_PASSPHRASE",
] as const;

for (const key of staticCredentialVars) {
  delete process.env[key];
}

function sameAddress(a: string | undefined, b: string): boolean {
  return (a ?? "").toLowerCase() === b.toLowerCase();
}

async function main() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk?.startsWith("0x")) {
    throw new Error("PRIVATE_KEY must be set and 0x-prefixed");
  }

  const signer = new Wallet(pk);
  if (!sameAddress(signer.address, OWNER)) {
    throw new Error(
      `PRIVATE_KEY owner mismatch: expected ${OWNER}, got ${signer.address}`,
    );
  }

  const contractConfig = getContractConfig(Chain.POLYGON);
  const depositWalletConfig = contractConfig.DepositWalletContracts;
  const officiallyDerivedDepositWallet = deriveDepositWallet(
    signer.address,
    depositWalletConfig.DepositWalletFactory,
    depositWalletConfig.DepositWalletImplementation,
  );

  const apiKeyNonce = Number.parseInt(process.env.POLY_API_KEY_NONCE ?? "1", 10);
  if (Number.isNaN(apiKeyNonce)) {
    throw new Error("POLY_API_KEY_NONCE must be an integer when set");
  }

  const apiKeyClient = new ClobClient({
    host: CLOB_HOST,
    chain: Chain.POLYGON,
    signer,
  });
  const creds = await apiKeyClient.createOrDeriveApiKey(apiKeyNonce);

  console.log(`Owner signer: ${signer.address}`);
  console.log(
    `DepositWalletFactory: ${depositWalletConfig.DepositWalletFactory}`,
  );
  console.log(
    `DepositWalletImplementation: ${depositWalletConfig.DepositWalletImplementation}`,
  );
  console.log(
    `Officially derived POLY_1271 deposit wallet: ${officiallyDerivedDepositWallet}`,
  );
  console.log(`Canonical env POLY_FUNDER_ADDRESS: ${process.env.POLY_FUNDER_ADDRESS ?? ""}`);
  console.log(
    sameAddress(EXPECTED_FUNDER, officiallyDerivedDepositWallet) &&
      sameAddress(process.env.POLY_FUNDER_ADDRESS, officiallyDerivedDepositWallet)
      ? "MATCH: current POLY_FUNDER_ADDRESS is correct"
      : "NO MATCH: current POLY_FUNDER_ADDRESS is wrong and must be replaced",
  );
  console.log("Credential source: freshly derived from owner signer");
  console.log(`Derived CLOB API key ID: ${creds.key}`);

  const clob = new ClobClient({
    host: CLOB_HOST,
    chain: Chain.POLYGON,
    signer,
    creds,
    signatureType: 3,
    funderAddress: officiallyDerivedDepositWallet,
  });

  const collateral = await clob.getBalanceAllowance({
    asset_type: AssetType.COLLATERAL,
  });
  console.log("CLOB collateral balance/allowance:", JSON.stringify(collateral));

  const openOrders = await clob.getOpenOrders();
  console.log(`Open orders count: ${openOrders.length}`);
}

main().catch((err) => {
  console.error("Diagnostic failed:", err.response?.data ?? err.message);
  process.exitCode = 1;
});
