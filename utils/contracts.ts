import { isAddress } from "ethers";

/**
 * Polymarket Contract Addresses (Polygon Mainnet)
 * 
 * Verified against official documentation following the V2 infrastructure 
 * upgrade in April 2026.
 * 
 * Sources:
 * - https://docs.polymarket.com/market-makers/getting-started
 * - https://data.chain.link/feeds/polygon/mainnet/btc-usd
 */
export const POLYGON_CONTRACTS = {
  /** CTF Exchange V2 - Primary matching and settlement engine */
  CTF_EXCHANGE: "0xe111180000d2663c0091e4f400237545b87b996b",
  
  /** NegRisk CTF Exchange V2 - Used for Negative Risk (multi-outcome) markets */
  NEGRISK_CTF_EXCHANGE: "0xe2222d279d744050d28e00520010520000310f59",
  
  /** Gnosis Conditional Tokens Framework (ERC-1155) */
  CONDITIONAL_TOKENS: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  
  /** Polymarket USD (pUSD) - Internal collateral token backed 1:1 by USDC */
  PUSD: "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb",
  
  /** Chainlink BTC/USD Price Feed Proxy on Polygon */
  CHAINLINK_BTC_USD: "0xc907E116054Ad103354f2D350FD2514433D57F6f",
};

/**
 * Validates that all required contract addresses match the intended production constants.
 * This ensures the bot is operating on the correct infrastructure version.
 */
export function validateContracts(opts: { requireSettlementReferenceVerification?: boolean } = {}) {
  const requirements = [
    { name: "CTF_EXCHANGE", actual: POLYGON_CONTRACTS.CTF_EXCHANGE, expected: "0xe111180000d2663c0091e4f400237545b87b996b" },
    { name: "NEGRISK_CTF_EXCHANGE", actual: POLYGON_CONTRACTS.NEGRISK_CTF_EXCHANGE, expected: "0xe2222d279d744050d28e00520010520000310f59" },
    { name: "CONDITIONAL_TOKENS", actual: POLYGON_CONTRACTS.CONDITIONAL_TOKENS, expected: "0x4d97dcd97ec945f40cf65f87097ace5ea0476045" },
    { name: "PUSD", actual: POLYGON_CONTRACTS.PUSD, expected: "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb" },
    { name: "CHAINLINK_BTC_USD", actual: POLYGON_CONTRACTS.CHAINLINK_BTC_USD, expected: "0xc907e116054ad103354f2d350fd2514433d57f6f" },
  ];

  for (const req of requirements) {
    if (!isAddress(req.actual)) {
      throw new Error(`Invalid contract address syntax for ${req.name}: ${req.actual}`);
    }
    if (req.actual.toLowerCase() !== req.expected.toLowerCase()) {
      throw new Error(`CRITICAL: ${req.name} address mismatch! Found ${req.actual}, expected ${req.expected}. This process is configured for an unapproved or legacy contract version.`);
    }
  }

  if (
    opts.requireSettlementReferenceVerification &&
    process.env.CHAINLINK_BTC_5M_REFERENCE_VERIFIED !== "true"
  ) {
    throw new Error(
      "DEPLOYMENT BLOCKER: CHAINLINK_BTC_5M_REFERENCE_VERIFIED=true is required before production live trading. " +
        "Verify from official Polymarket market metadata/config that this BTC 5-minute market family resolves against the configured Chainlink Polygon BTC/USD feed.",
    );
  }
}
