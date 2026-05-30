import { ClobClient, Chain } from "@polymarket/clob-client-v2";
import { Wallet } from "@ethersproject/wallet";
import * as dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function run() {
    const pk = process.env.PRIVATE_KEY;
    const funder = process.env.POLY_FUNDER_ADDRESS;
    const sigType = parseInt(process.env.POLY_SIGNATURE_TYPE || "3");

    if (!pk) throw new Error("No PK");
    const signer = new Wallet(pk);

    console.log("EOA Signer Address:", signer.address);
    console.log("Funder Address:", funder);

    const client = new ClobClient({
        host: "https://clob.polymarket.com",
        chain: Chain.POLYGON,
        signer: signer,
        signatureType: sigType as any,
        funderAddress: funder
    });

    try {
        const creds = await client.createOrDeriveApiKey(0);
        console.log(`Derived Key: ${creds.key}`);

        const authClient = new ClobClient({
            host: "https://clob.polymarket.com",
            chain: Chain.POLYGON,
            signer: signer,
            creds: creds,
            signatureType: sigType as any,
            funderAddress: funder
        });

        console.log("\nChecking available methods on ClobClient...");
        const proto = Object.getPrototypeOf(authClient);
        const methods = Object.getOwnPropertyNames(proto).filter(m => typeof (authClient as any)[m] === 'function');
        console.log("Available ClobClient methods:", methods);

        if (typeof (authClient as any).getTrades === 'function') {
            console.log("\nFetching trades from CLOB...");
            const trades = await (authClient as any).getTrades();
            console.log("Trades:", JSON.stringify(trades, null, 2));
        }

    } catch (e: any) {
        console.error("Error:", e.response?.data || e.message);
    }
}

run();
