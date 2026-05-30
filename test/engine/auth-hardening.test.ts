import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { PolymarketEarlyBirdClient } from "../../engine/client.ts";

describe("Production Auth Hardening", () => {
  const originalEnv = { ...process.env };

  beforeAll(() => {
    process.env.PRIVATE_KEY = "0x1234567890123456789012345678901234567890123456789012345678901234";
    process.env.BUILDER_KEY = "builder-key";
    process.env.BUILDER_SECRET = "builder-secret";
    process.env.BUILDER_PASSPHRASE = "builder-passphrase";
    process.env.POLY_SIGNATURE_TYPE = "1";
    process.env.POLY_FUNDER_ADDRESS = "0x1234567890123456789012345678901234567890";
    process.env.MARKET_ASSET = "btc";
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test("accepts valid POLY_SIGNATURE_TYPE 0, 1, 2, 3", () => {
    [0, 1, 2, 3].forEach((type) => {
      process.env.POLY_SIGNATURE_TYPE = type.toString();
      expect(() => new PolymarketEarlyBirdClient()).not.toThrow();
    });
  });

  test("rejects invalid POLY_SIGNATURE_TYPE", () => {
    ["-1", "4", "foo"].forEach((type) => {
      process.env.POLY_SIGNATURE_TYPE = type;
      expect(() => new PolymarketEarlyBirdClient()).toThrow(/POLY_SIGNATURE_TYPE is required/);
    });
  });

  test("requires POLY_FUNDER_ADDRESS for types 1, 2, 3", () => {
    [1, 2, 3].forEach((type) => {
      process.env.POLY_SIGNATURE_TYPE = type.toString();
      delete process.env.POLY_FUNDER_ADDRESS;
      expect(() => new PolymarketEarlyBirdClient()).toThrow(/POLY_FUNDER_ADDRESS is required/);
    });
    // Restore for other tests
    process.env.POLY_FUNDER_ADDRESS = "0x1234567890123456789012345678901234567890";
  });

  test("derives POLY_FUNDER_ADDRESS from signer for type 0", () => {
    process.env.POLY_SIGNATURE_TYPE = "0";
    delete process.env.POLY_FUNDER_ADDRESS;
    const client = new PolymarketEarlyBirdClient();
    expect((client as any)._funder).toBeDefined();
    expect((client as any)._funder).toBe((client as any)._signer.address);
    // Restore for other tests
    process.env.POLY_FUNDER_ADDRESS = "0x1234567890123456789012345678901234567890";
  });

  test("rejects partial builder credentials", () => {
    process.env.POLY_SIGNATURE_TYPE = "1";
    // Set only KEY
    delete process.env.BUILDER_SECRET;
    delete process.env.BUILDER_PASSPHRASE;
    expect(() => new PolymarketEarlyBirdClient()).toThrow(/Partial BUILDER credentials detected/);
    
    // Set KEY and SECRET
    process.env.BUILDER_SECRET = "builder-secret";
    expect(() => new PolymarketEarlyBirdClient()).toThrow(/Partial BUILDER credentials detected/);

    // Restore for other tests
    process.env.BUILDER_PASSPHRASE = "builder-passphrase";
  });

  test("works without any builder credentials", () => {
    delete process.env.BUILDER_KEY;
    delete process.env.BUILDER_SECRET;
    delete process.env.BUILDER_PASSPHRASE;
    
    const client = new PolymarketEarlyBirdClient();
    expect((client as any)._builderConfig).toBeNull();

    // Restore for other tests
    process.env.BUILDER_KEY = "builder-key";
    process.env.BUILDER_SECRET = "builder-secret";
    process.env.BUILDER_PASSPHRASE = "builder-passphrase";
  });

  test("relay methods throw error if builder credentials are missing", async () => {
    delete process.env.BUILDER_KEY;
    delete process.env.BUILDER_SECRET;
    delete process.env.BUILDER_PASSPHRASE;
    
    const client = new PolymarketEarlyBirdClient();
    
    await expect(client.wrapUSDC(100n)).rejects.toThrow(/Relay operations .* require BUILDER_KEY/);
    await expect(client.unwrapUSDC(100n)).rejects.toThrow(/Relay operations .* require BUILDER_KEY/);
    await expect(client.redeemPositions("0x123")).rejects.toThrow(/Relay operations .* require BUILDER_KEY/);

    // Restore for other tests
    process.env.BUILDER_KEY = "builder-key";
    process.env.BUILDER_SECRET = "builder-secret";
    process.env.BUILDER_PASSPHRASE = "builder-passphrase";
  });
});
