import { ClobClient, Chain, AssetType } from "@polymarket/clob-client-v2";
import { Wallet } from "@ethersproject/wallet";
import * as dotenv from "dotenv";
import path from "path";
import { createPublicClient, http } from "viem";
import { polygon } from "viem/chains";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function run() {
    const pk = process.env.PRIVATE_KEY;
    const funder = process.env.POLY_FUNDER_ADDRESS;
    const sigType = parseInt(process.env.POLY_SIGNATURE_TYPE || "3");

    if (!pk) throw new Error("No PK");
    const signer = new Wallet(pk);

    console.log("EOA Address:", signer.address);
    console.log("Funder Address:", funder);
    console.log("Signature Type:", sigType);

    const client = new ClobClient({
        host: "https://clob.polymarket.com",
        chain: Chain.POLYGON,
        signer: signer,
        signatureType: sigType as any,
        funderAddress: funder
    });

    try {
        console.log("\nDeriving API Key...");
        const creds = await client.createOrDeriveApiKey(0);
        console.log("Derived API Key:", creds.key);

        const authClient = new ClobClient({
            host: "https://clob.polymarket.com",
            chain: Chain.POLYGON,
            signer: signer,
            creds: creds,
            signatureType: sigType as any,
            funderAddress: funder
        });

        console.log("\nFetching all API keys for this signer...");
        const keys = await authClient.getApiKeys();
        console.log("API Keys:", JSON.stringify(keys, null, 2));

        console.log("\nChecking Balance Allowance...");
        const balance = await authClient.getBalanceAllowance({
            asset_type: AssetType.COLLATERAL
        });
        console.log("Balance Allowance:", JSON.stringify(balance, null, 2));

        console.log("\nChecking On-chain pUSD Balance...");
        const publicClient = createPublicClient({
            chain: polygon,
            transport: http(process.env.POLYGON_RPC_URL)
        });
        const erc20Abi = [
            {
                name: "balanceOf",
                type: "function",
                stateMutability: "view",
                inputs: [{ name: "owner", type: "address" }],
                outputs: [{ name: "balance", type: "uint256" }]
            }
        ] as const;
        const bal = await publicClient.readContract({
            address: "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb",
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [funder as `0x${string}`]
        });
        console.log("On-chain pUSD Balance:", Number(bal) / 1e6, "pUSD");

    } catch (e: any) {
        console.error("Error:", e.response?.data || e.message);
    }
}

run();
