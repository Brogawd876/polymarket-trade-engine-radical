import { describe, expect, test, spyOn, afterEach } from "bun:test";
import { PolymarketResolutionAdapter } from "../../engine/bot-core/polymarket-resolution-adapter.ts";
import * as fetchRetry from "../../utils/fetch-retry";
import { type RoundWindow } from "../../engine/bot-core/data-sources";

describe("PolymarketResolutionAdapter", () => {
  afterEach(() => {
    spyOn(fetchRetry, "fetchWithRetry").mockRestore();
  });

  test("implements the ResolutionSourceAdapter interface", () => {
    const adapter = new PolymarketResolutionAdapter();
    expect(adapter.role).toBe("resolution");
    expect(adapter.source).toBe("polymarket-combined");
  });

  test("priceToBeat fetches and normalizes open price", async () => {
    const round: RoundWindow = {
      slug: "btc-updown-5m-1778891400",
      asset: "btc",
      window: "5m",
      startTimeMs: 1778891400_000,
      endTimeMs: 1778891700_000,
    };

    const mockResponse = {
      json: async () => ({ openPrice: 100000.5, closePrice: null }),
      ok: true,
    };

    spyOn(fetchRetry, "fetchWithRetry").mockImplementation(async () => mockResponse as any);

    const adapter = new PolymarketResolutionAdapter();
    const event = await adapter.priceToBeat(round);

    expect(event).not.toBeNull();
    expect(event?.kind).toBe("open");
    expect(event?.price).toBe(100000.5);
    expect(event?.source).toBe("polymarket-crypto-price-api");
    expect(event?.round?.slug).toBe(round.slug);
  });

  test("closePrice fetches and normalizes close price", async () => {
    const round: RoundWindow = {
      slug: "btc-updown-5m-1778891400",
      asset: "btc",
      window: "5m",
      startTimeMs: 1778891400_000,
      endTimeMs: 1778891700_000,
    };

    const mockResponse = {
      json: async () => ({ openPrice: 100000.5, closePrice: 100100.2 }),
      ok: true,
    };

    spyOn(fetchRetry, "fetchWithRetry").mockImplementation(async () => mockResponse as any);

    const adapter = new PolymarketResolutionAdapter();
    const event = await adapter.closePrice(round);

    expect(event).not.toBeNull();
    expect(event?.kind).toBe("close");
    expect(event?.price).toBe(100100.2);
    expect(event?.source).toBe("polymarket-crypto-price-api");
  });

  test("isStale detection logic correctly identifies old data", () => {
    const adapter = new PolymarketResolutionAdapter() as any;
    const now = 1778891400_000;

    // Not stale (within 1000ms limit)
    expect(adapter.isStale({ sourceTimestampMs: now - 500, receivedAtMs: now })).toBe(false);

    // Stale (exceeds 1000ms limit)
    expect(adapter.isStale({ sourceTimestampMs: now - 1500, receivedAtMs: now })).toBe(true);

    // Missing source timestamp should not be marked stale by time alone
    expect(adapter.isStale({ sourceTimestampMs: null, receivedAtMs: now })).toBe(false);
  });
});
