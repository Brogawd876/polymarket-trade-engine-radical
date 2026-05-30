import { Env } from "../utils/config.ts";
import { PolymarketEarlyBirdClient } from "../engine/client.ts";
import { formatUnits } from "viem";

const USDCE = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;
const PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" as const;

async function check() {
  const client = new PolymarketEarlyBirdClient();
  await client.init();
  const funder = Env.get("POLY_FUNDER_ADDRESS") || "not set";
  console.log(`POLY_FUNDER_ADDRESS: ${funder}`);
  const signatureType = Env.get("POLY_SIGNATURE_TYPE");
  console.log(`POLY_SIGNATURE_TYPE: ${signatureType}`);
  
  try {
    const usdce = await client.getTokenBalance(USDCE);
    console.log(`USDC.e balance: ${formatUnits(usdce, 6)}`);
  } catch (err) {
    console.error("Error reading USDC.e balance:", err);
  }

  try {
    const pusd = await client.getTokenBalance(PUSD);
    console.log(`pUSD balance: ${formatUnits(pusd, 6)}`);
  } catch (err) {
    console.error("Error reading pUSD balance:", err);
  }

  try {
    const clobUsdc = await client.getUSDCBalance();
    console.log(`CLOB USDC balance (allowance/balance): ${clobUsdc}`);
  } catch (err) {
    console.error("Error reading CLOB USDC balance:", err);
  }
}

check().catch(console.error);
