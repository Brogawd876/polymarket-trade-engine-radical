import { OrderType, Side } from "@polymarket/clob-client-v2";
import { PolymarketEarlyBirdClient } from "../engine/client.ts";
import { Env } from "../utils/config.ts";
import { resolveTradableBtc5mMarket } from "./btc-5m-market.ts";
import { Wallet } from "@ethersproject/wallet";
import { extractOrderId, responseError } from "../utils/clob-response.ts";

const EXPECTED_OWNER = "0x3528764a45bB13eC6BD8Deb1a73b5034742E6329";
const EXPECTED_FUNDER = "0x9bB7C3aafCeb82665293f9cd784F61112fFa4c51";
const TEST_PRICE = 0.01;
const TEST_SIZE = 100;
const ORDER_VERSION = 2;

function sameAddress(a: string | undefined, b: string): boolean {
  return (a ?? "").toLowerCase() === b.toLowerCase();
}

async function main() {
  console.log("--- FINAL BTC 5M TYPE 3 ACCEPTANCE TEST ---");

  const client = new PolymarketEarlyBirdClient();
  await client.init();

  const owner = new Wallet(Env.get("PRIVATE_KEY")).address;
  const funder = Env.get("POLY_FUNDER_ADDRESS");
  if (!sameAddress(owner, EXPECTED_OWNER)) {
    throw new Error(`Owner mismatch: expected ${EXPECTED_OWNER}, got ${owner}`);
  }
  if (!sameAddress(funder, EXPECTED_FUNDER)) {
    throw new Error(`Funder mismatch: expected ${EXPECTED_FUNDER}, got ${funder}`);
  }

  const balance = await client.getUSDCBalance();
  if (balance < 1) {
    throw new Error(`Insufficient CLOB balance for live test: ${balance}`);
  }

  const market = await resolveTradableBtc5mMarket();
  console.log(`Market slug: ${market.slug}`);
  console.log(`Market question: ${market.question}`);
  console.log(`Condition ID: ${market.conditionId}`);
  console.log(`acceptingOrders: ${market.acceptingOrders}`);
  console.log(`closed: ${market.closed}`);
  console.log(`tick size: ${market.tickSize}`);
  console.log(`negRisk: ${market.negRisk}`);
  console.log(`UP token ID: ${market.upTokenId}`);
  console.log(`DOWN token ID: ${market.downTokenId}`);
  console.log(`chosen token ID: ${market.chosenTokenId}`);

  const signedOrder = await client.clob.orderBuilder.buildOrder(
    {
      tokenID: market.chosenTokenId,
      price: TEST_PRICE,
      size: TEST_SIZE,
      side: Side.BUY,
    },
    { tickSize: market.tickSize as any, negRisk: market.negRisk },
    ORDER_VERSION,
  );

  console.log("--- RAW LIVE TEST ORDER ---");
  console.log(`maker: ${signedOrder.maker}`);
  console.log(`signer: ${signedOrder.signer}`);
  console.log(`signatureType: ${signedOrder.signatureType}`);
  console.log(`tokenId: ${market.chosenTokenId}`);
  console.log(`price: ${TEST_PRICE}`);
  console.log(`size: ${TEST_SIZE}`);
  console.log(`order version: ${ORDER_VERSION}`);

  if (!sameAddress(signedOrder.maker, EXPECTED_FUNDER)) {
    throw new Error(`Raw order maker mismatch: ${signedOrder.maker}`);
  }
  if (!sameAddress(signedOrder.signer, EXPECTED_FUNDER)) {
    throw new Error(`Raw order signer mismatch: ${signedOrder.signer}`);
  }
  if (Number(signedOrder.signatureType) !== 3) {
    throw new Error(`Raw order signatureType mismatch: ${signedOrder.signatureType}`);
  }
  if (ORDER_VERSION !== 2) {
    throw new Error(`Raw order version mismatch: ${ORDER_VERSION}`);
  }

  console.log("Submitting post-only GTC order...");
  const postResp = await client.clob.postOrder(signedOrder, OrderType.GTC, true);
  const postError = responseError(postResp);
  const orderId = extractOrderId(postResp);
  if (postError || !orderId) {
    throw new Error(`Order rejected: ${postError ?? JSON.stringify(postResp)}`);
  }
  console.log(`Accepted order ID: ${orderId}`);

  console.log("Canceling accepted order...");
  const cancelResp = await client.clob.cancelOrder({ orderID: orderId });
  const cancelError = responseError(cancelResp);
  if (cancelError) {
    throw new Error(`Cancel rejected: ${cancelError}`);
  }
  console.log(`Cancel response: ${JSON.stringify(cancelResp)}`);

  const openOrders = await client.clob.getOpenOrders({ market: market.conditionId });
  const stillOpen = openOrders.some((order: any) => order.id === orderId || order.orderID === orderId);
  if (stillOpen) {
    throw new Error(`Canceled order still appears in open orders: ${orderId}`);
  }
  console.log(`Open orders after cancellation: ${openOrders.length}`);
  console.log("FINAL RESULT: PASS");
}

main().catch((err) => {
  console.error("FINAL RESULT: FAIL");
  console.error(err.response?.data ?? err.message ?? err);
  process.exit(1);
});
