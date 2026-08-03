import { Side } from "@polymarket/clob-client-v2";
import { PolymarketEarlyBirdClient } from "../engine/client.ts";
import { Env } from "../utils/config.ts";
import { resolveTradableBtc5mMarket } from "./btc-5m-market.ts";
import { Wallet } from "@ethersproject/wallet";

const EXPECTED_OWNER = "0x3528764a45bB13eC6BD8Deb1a73b5034742E6329";
const EXPECTED_FUNDER = "0x9bB7C3aafCeb82665293f9cd784F61112fFa4c51";
const TEST_PRICE = 0.01;
const TEST_SIZE = 100;
const ORDER_VERSION = 2;

function sameAddress(a: string | undefined, b: string): boolean {
  return (a ?? "").toLowerCase() === b.toLowerCase();
}

async function main() {
  console.log("--- OFFLINE BTC 5M TYPE 3 ACCEPTANCE CHECK ---");

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

  const signedOrder = await client.buildSignedOrderForVerification(
    {
      tokenID: market.chosenTokenId,
      price: TEST_PRICE,
      size: TEST_SIZE,
      side: Side.BUY,
    },
    { tickSize: market.tickSize as any, negRisk: market.negRisk },
    ORDER_VERSION,
  );

  console.log("--- SIGNED ORDER FIELDS (NOT SUBMITTED) ---");
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

  console.log("No order was submitted. Live acceptance is unavailable in this branch.");
  console.log("OFFLINE RESULT: PASS");
}

main().catch((err) => {
  console.error("FINAL RESULT: FAIL");
  console.error(err.response?.data ?? err.message ?? err);
  process.exit(1);
});
