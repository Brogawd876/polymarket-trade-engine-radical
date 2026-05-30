import { ClobClient, Chain } from "@polymarket/clob-client-v2";
import { Wallet } from "@ethersproject/wallet";
import * as dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function run() {
    const pk = process.env.PRIVATE_KEY;
    const funder = process.env.POLY_FUNDER_ADDRESS;
    const sigType = parseInt(process.env.POLY_SIGNATURE_TYPE || "3");

    if (!pk) throw new Error("No PRIVATE_KEY in env");
    const signer = new Wallet(pk);

    console.log("EOA Signer Address:", signer.address);
    console.log("Funder Address:", funder);
    console.log("Signature Type:", sigType);

    const client = new ClobClient({
        host: "https://clob.polymarket.com",
        chain: Chain.POLYGON,
        signer: signer,
        signatureType: sigType as any,
        funderAddress: funder
    });

    for (let nonce = 0; nonce <= 10; nonce++) {
        console.log(`\n========================================`);
        console.log(`Sweeping Nonce: ${nonce}...`);
        try {
            const creds = await client.createOrDeriveApiKey(nonce);
            console.log(`Derived Key: ${creds.key}`);

            const authClient = new ClobClient({
                host: "https://clob.polymarket.com",
                chain: Chain.POLYGON,
                signer: signer,
                creds: creds,
                signatureType: sigType as any,
                funderAddress: funder
            });

            console.log("Checking open orders under this profile...");
            const openOrders = await authClient.getOpenOrders();
            let orders: any[] = [];
            
            if (Array.isArray(openOrders)) {
                orders = openOrders;
            } else if (openOrders && typeof openOrders === 'object') {
                orders = (openOrders as any).orders || [];
            }

            console.log(`Open orders found: ${orders.length}`);
            if (orders.length > 0) {
                console.log("Orders:", JSON.stringify(orders, null, 2));
                console.log("Canceling orders...");
                const ids = orders.map((o: any) => o.orderID);
                const cancelResp = await authClient.cancelOrders(ids);
                console.log("Cancel Response:", JSON.stringify(cancelResp, null, 2));
            }

            console.log("Running cancelAll fallback on this profile...");
            const cancelAllResp = await authClient.cancelAll();
            console.log("cancelAll Response:", JSON.stringify(cancelAllResp, null, 2));

        } catch (e: any) {
            console.error(`Error at nonce ${nonce}:`, e.response?.data || e.message);
        }
    }
}

run();
