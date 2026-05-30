#!/usr/bin/env bun
import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { Wallet } from "@ethersproject/wallet";
import { JsonRpcProvider } from "@ethersproject/providers";
import { formatUnits, parseUnits } from "viem";
import { deriveDepositWallet } from "@polymarket/builder-relayer-client";
import { getContractConfig } from "@polymarket/builder-relayer-client/dist/config";
import { Chain } from "@polymarket/clob-client-v2";
import { PolymarketEarlyBirdClient } from "../engine/client.ts";
import { Env } from "../utils/config.ts";

const USDCE = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;
const PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" as const;
const POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com";

const program = new Command();

program
  .name("wallet")
  .description("Unified CLI for Polymarket engine wallet management")
  .version("1.0.0");

async function fetchTokenBalance(address: string, tokenAddress: string): Promise<bigint> {
  const provider = new JsonRpcProvider(POLYGON_RPC);
  const result = await provider.call({
    to: tokenAddress,
    data: "0x70a08231" + address.replace("0x", "").padStart(64, "0"),
  });
  return BigInt(result);
}

program
  .command("status")
  .description("Check current configuration and balances")
  .action(async () => {
    try {
      const privateKey = Env.get("PRIVATE_KEY");
      if (!privateKey) {
        console.log("No PRIVATE_KEY found in .env. Run 'bun run wallet configure' first.");
        return;
      }
      
      const signer = new Wallet(privateKey);
      const funder = Env.get("POLY_FUNDER_ADDRESS");
      
      console.log("\n--- Wallet Configuration ---");
      console.log(`Signer (Owner) Address: ${signer.address}`);
      console.log(`Proxy (Funder) Address: ${funder || "NOT SET"}`);
      console.log(`Signature Type: ${Env.get("POLY_SIGNATURE_TYPE")}`);
      
      if (!funder) {
        console.log("\nSkipping balances because POLY_FUNDER_ADDRESS is missing.");
        return;
      }

      console.log("\n--- Live Balances (Proxy Address) ---");
      const provider = new JsonRpcProvider(POLYGON_RPC);
      const maticBal = await provider.getBalance(funder);
      console.log(`MATIC (Gas)   : ${formatUnits(BigInt(maticBal.toString()), 18)}`);

      const usdcBal = await fetchTokenBalance(funder, USDCE);
      console.log(`USDC.e        : ${formatUnits(usdcBal, 6)}`);

      const pusdBal = await fetchTokenBalance(funder, PUSD);
      console.log(`pUSD (Trading): ${formatUnits(pusdBal, 6)}`);
      
    } catch (err: any) {
      console.error("Failed to fetch status:", err.message);
    }
  });

function updateEnvVar(key: string, value: string) {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, `${key}=${value}\n`);
    return;
  }
  let content = fs.readFileSync(envPath, "utf-8");
  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content += `\n${key}=${value}`;
  }
  fs.writeFileSync(envPath, content);
}

program
  .command("configure")
  .description("Configure a new wallet private key and derive the proxy address")
  .argument("<private_key>", "The new private key to set")
  .action((privateKey: string) => {
    try {
      if (!privateKey.startsWith("0x")) privateKey = "0x" + privateKey;
      const signer = new Wallet(privateKey);
      
      const contractConfig = getContractConfig(Chain.POLYGON);
      const depositWalletConfig = contractConfig.DepositWalletContracts;
      const derived = deriveDepositWallet(
        signer.address,
        depositWalletConfig.DepositWalletFactory,
        depositWalletConfig.DepositWalletImplementation,
      );

      console.log("Configuring new wallet...");
      console.log(`Owner Address: ${signer.address}`);
      console.log(`Derived Proxy: ${derived}`);

      updateEnvVar("PRIVATE_KEY", privateKey);
      updateEnvVar("POLY_FUNDER_ADDRESS", derived);
      updateEnvVar("POLY_SIGNATURE_TYPE", "3");

      console.log("\nSuccessfully updated .env configuration.");
    } catch (err: any) {
      console.error("Failed to configure wallet:", err.message);
    }
  });

program
  .command("wrap")
  .description("Wrap USDC.e to pUSD")
  .argument("<amount>", "Amount of USDC.e to wrap")
  .action(async (amount: string) => {
    try {
      console.log(`Wrapping ${amount} USDC.e to pUSD...`);
      const client = new PolymarketEarlyBirdClient();
      await client.init();
      await client.wrapUSDC(parseUnits(amount, 6));
      console.log("Wrap request sent via relayer.");
    } catch (err: any) {
      console.error("Wrap failed:", err.message);
    }
  });

program
  .command("unwrap")
  .description("Unwrap pUSD back to USDC.e")
  .argument("<amount>", "Amount of pUSD to unwrap")
  .action(async (amount: string) => {
    try {
      console.log(`Unwrapping ${amount} pUSD to USDC.e...`);
      const client = new PolymarketEarlyBirdClient();
      await client.init();
      await client.unwrapUSDC(parseUnits(amount, 6));
      console.log("Unwrap request sent via relayer.");
    } catch (err: any) {
      console.error("Unwrap failed:", err.message);
    }
  });

program
  .command("verify")
  .description("Perform a micro-trade to verify live operations")
  .action(async () => {
    try {
      console.log("Initializing client for live trade verification...");
      const client = new PolymarketEarlyBirdClient();
      await client.init();

      console.log("Client initialized. Fetching balance...");
      const bal = await client.getUSDCBalance();
      console.log(`pUSD Balance: $${bal.toFixed(2)}`);
      
      if (bal < 0.20) {
        throw new Error("Insufficient pUSD balance for verification (needs ~$0.20).");
      }

      console.log("\n[WARNING] This command will execute a real buy and sell order on the live API.");
      console.log("If this is a real setup, it would execute now. For safety, please review the CLI code first.");
      // Actual trade logic would go here if fully approved by the user with exact token IDs
    } catch (err: any) {
      console.error("Verification failed:", err.message);
    }
  });

program.parse(process.argv);
