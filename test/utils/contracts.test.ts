import { describe, expect, test } from "bun:test";
import { POLYGON_CONTRACTS, validateContracts } from "../../utils/contracts.ts";

describe("Polymarket Contract Validation", () => {
  test("mainnet addresses match official 2026 V2 constants", () => {
    // These are the verified production addresses as of the April 2026 migration.
    // Reference: https://docs.polymarket.com/
    expect(POLYGON_CONTRACTS.CTF_EXCHANGE.toLowerCase()).toBe("0xe111180000d2663c0091e4f400237545b87b996b");
    expect(POLYGON_CONTRACTS.NEGRISK_CTF_EXCHANGE.toLowerCase()).toBe("0xe2222d279d744050d28e00520010520000310f59");
    expect(POLYGON_CONTRACTS.CONDITIONAL_TOKENS.toLowerCase()).toBe("0x4d97dcd97ec945f40cf65f87097ace5ea0476045");
    expect(POLYGON_CONTRACTS.PUSD.toLowerCase()).toBe("0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb");
    expect(POLYGON_CONTRACTS.CHAINLINK_BTC_USD.toLowerCase()).toBe("0xc907e116054ad103354f2d350fd2514433d57f6f");
  });

  test("validateContracts() succeeds for approved constants", () => {
    expect(() => validateContracts()).not.toThrow();
  });

  test("production Chainlink market-family verification is an explicit deployment blocker", () => {
    const original = process.env.CHAINLINK_BTC_5M_REFERENCE_VERIFIED;
    delete process.env.CHAINLINK_BTC_5M_REFERENCE_VERIFIED;
    expect(() =>
      validateContracts({ requireSettlementReferenceVerification: true }),
    ).toThrow(/DEPLOYMENT BLOCKER/);
    process.env.CHAINLINK_BTC_5M_REFERENCE_VERIFIED = "true";
    expect(() =>
      validateContracts({ requireSettlementReferenceVerification: true }),
    ).not.toThrow();
    if (original === undefined) {
      delete process.env.CHAINLINK_BTC_5M_REFERENCE_VERIFIED;
    } else {
      process.env.CHAINLINK_BTC_5M_REFERENCE_VERIFIED = original;
    }
  });
});
