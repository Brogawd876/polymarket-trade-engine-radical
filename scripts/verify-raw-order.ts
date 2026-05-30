import { Side } from "@polymarket/clob-client-v2";
import { PolymarketEarlyBirdClient } from "../engine/client.ts";
import { Env } from "../utils/config.ts";
import { resolveTradableBtc5mMarket } from "./btc-5m-market.ts";
import { Wallet } from "@ethersproject/wallet";

const EXPECTED_OWNER = "0x3528764a45bB13eC6BD8Deb1a73b5034742E6329";
const EXPECTED_FUNDER = "0x9bB7C3aafCeb82665293f9cd784F61112fFa4c51";
const ORDER_VERSION = 2;

function sameAddress(a: string | undefined, b: string): boolean {
  return (a ?? "").toLowerCase() === b.toLowerCase();
}

async function main() {
  console.log("--- RAW ORDER VERIFICATION ---");

  const client = new PolymarketEarlyBirdClient();
  await client.init();

  const owner = new Wallet(Env.get("PRIVATE_KEY")).address;
  const funder = Env.get("POLY_FUNDER_ADDRESS");
  const market = await resolveTradableBtc5mMarket({ minSecondsRemaining: 30 });

  console.log(`EOA Address: ${owner}`);
  console.log(`Funder Address: ${funder}`);
  console.log(`Market slug: ${market.slug}`);
  console.log(`Token ID: ${market.chosenTokenId}`);

  const order = await client.clob.orderBuilder.buildOrder(
    {
      tokenID: market.chosenTokenId,
      price: 0.01,
      size: 100,
      side: Side.BUY,
    },
    {
      tickSize: market.tickSize as any,
      negRisk: market.negRisk,
    },
    ORDER_VERSION,
  );

  console.log("\n--- RAW ORDER FIELDS ---");
  console.log(`Maker:         ${order.maker}`);
  console.log(`Signer:        ${order.signer}`);
  console.log(`SignatureType: ${order.signatureType}`);
  console.log(`Order Version: ${ORDER_VERSION}`);

  const pass =
    sameAddress(owner, EXPECTED_OWNER) &&
    sameAddress(funder, EXPECTED_FUNDER) &&
    sameAddress(order.maker, EXPECTED_FUNDER) &&
    sameAddress(order.signer, EXPECTED_FUNDER) &&
    Number(order.signatureType) === 3 &&
    ORDER_VERSION === 2;

  console.log(`\nVerification Result: ${pass ? "PASS" : "FAIL"}`);
  if (!pass) process.exit(1);
}

main().catch((err) => {
  console.error(err.response?.data ?? err.message ?? err);
  process.exit(1);
});
