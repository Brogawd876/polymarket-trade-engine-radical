import { describe, expect, test } from "bun:test";
import {
  appendSettlementReference,
  calculateMarkout,
  calculateMarkouts,
  extractReferencePricesFromReplayEvents,
} from "../../engine/replay/markout.ts";

describe("markout calculator", () => {
  test("computes favorable buy markouts from token-side future midpoints", () => {
    const result = calculateMarkout(
      {
        orderId: "o1",
        tsMs: 1000,
        side: "UP",
        action: "buy",
        price: 0.48,
      },
      [
        { tsMs: 1500, upBid: 0.47, upAsk: 0.49 },
        { tsMs: 2000, upBid: 0.51, upAsk: 0.53 },
      ],
      1000,
    );

    expect(result.referencePrice).toBe(0.52);
    expect(result.value).toBe(0.04);
    expect(result.available).toBe(true);
    expect(result.referenceTsMs).toBe(2000);
    expect(result.distanceFromTargetMs).toBe(0);
  });

  test("computes adverse buy markouts from token-side future midpoints", () => {
    const result = calculateMarkout(
      { orderId: "o1", tsMs: 1000, side: "UP", action: "buy", price: 0.5 },
      [{ tsMs: 2000, upBid: 0.45, upAsk: 0.47 }],
      1000,
    );

    expect(result.referencePrice).toBe(0.46);
    expect(result.value).toBe(-0.04);
  });

  test("computes favorable sell markouts from token-side future midpoints", () => {
    const result = calculateMarkout(
      { orderId: "s1", tsMs: 1000, side: "DOWN", action: "sell", price: 0.55 },
      [{ tsMs: 2000, downBid: 0.4, downAsk: 0.42 }],
      1000,
    );

    expect(result.referencePrice).toBe(0.41);
    expect(result.value).toBe(0.14);
  });

  test("computes adverse sell markouts from token-side future midpoints", () => {
    const result = calculateMarkout(
      { orderId: "s1", tsMs: 1000, side: "DOWN", action: "sell", price: 0.45 },
      [{ tsMs: 2000, downBid: 0.5, downAsk: 0.52 }],
      1000,
    );

    expect(result.referencePrice).toBe(0.51);
    expect(result.value).toBe(-0.06);
  });

  test("computes signed sell markouts against settlement", () => {
    const result = calculateMarkout(
      {
        orderId: "o1",
        tsMs: 1000,
        side: "DOWN",
        action: "sell",
        price: 0.44,
      },
      [{ tsMs: 2000, settlementUpValue: 1 }],
      "settlement",
    );

    expect(result.referencePrice).toBe(0);
    expect(result.value).toBe(0.44);
  });

  test("computes settlement markout for winning and losing BUY fills", () => {
    const winning = calculateMarkout(
      { orderId: "b1", tsMs: 1000, side: "UP", action: "buy", price: 0.55 },
      [{ tsMs: 10_000, settlementUpValue: 1 }],
      "settlement",
    );
    const losing = calculateMarkout(
      { orderId: "b2", tsMs: 1000, side: "UP", action: "buy", price: 0.55 },
      [{ tsMs: 10_000, settlementUpValue: 0 }],
      "settlement",
    );

    expect(winning.value).toBe(0.45);
    expect(losing.value).toBe(-0.55);
  });

  test("uses nearest observation within tolerance and ignores observations before fill", () => {
    const result = calculateMarkout(
      { orderId: "o1", tsMs: 1000, side: "UP", action: "buy", price: 0.5 },
      [
        { tsMs: 900, upBid: 0.9, upAsk: 0.92 },
        { tsMs: 1850, upBid: 0.54, upAsk: 0.56 },
      ],
      1000,
      { maxObservationDistanceMs: 200 },
    );

    expect(result.referenceTsMs).toBe(1850);
    expect(result.distanceFromTargetMs).toBe(-150);
    expect(result.value).toBe(0.05);
  });

  test("missing horizon observations return explicit unavailable results", () => {
    const missing = calculateMarkout(
      { orderId: "o1", tsMs: 1000, side: "UP", action: "buy", price: 0.5 },
      [{ tsMs: 10_000, upBid: 0.54, upAsk: 0.56 }],
      1000,
    );

    expect(missing.available).toBe(false);
    expect(missing.value).toBeNull();
    expect(missing.reason).toBe("missing_horizon");
  });

  test("returns explicit null reasons instead of fake values", () => {
    const results = calculateMarkouts(null, []);
    expect(results.every((result) => result.value === null)).toBe(true);
    expect(results.every((result) => result.reason === "missing_fill")).toBe(true);

    const missing = calculateMarkout(
      {
        orderId: "o2",
        tsMs: 1000,
        side: "UP",
        action: "buy",
        price: 0.5,
      },
      [{ tsMs: 2000, downBid: 0.5, downAsk: 0.52 }],
      1000,
    );
    expect(missing.reason).toBe("missing_reference");
    expect(missing.value).toBeNull();
  });

  test("extracts token-side prices from replay orderbook snapshots and ignores BTC ticker data", () => {
    const references = extractReferencePricesFromReplayEvents([
      { ts: 1000, type: "ticker", assetPrice: 80_000 },
      {
        ts: 1100,
        type: "orderbook_snapshot",
        up: { bids: [[0.49, 10]], asks: [[0.51, 10]] },
        down: { bids: [[0.48, 10]], asks: [[0.5, 10]] },
      },
      { ts: 1200, type: "market_price", openPrice: 80_000, gap: 5 },
    ]);

    expect(references).toHaveLength(1);
    expect(references[0]).toMatchObject({
      tsMs: 1100,
      upBid: 0.49,
      upAsk: 0.51,
      downBid: 0.48,
      downAsk: 0.5,
    });
  });

  test("appends settlement reference using resolved direction", () => {
    const refs = appendSettlementReference([], { tsMs: 5000, direction: "DOWN" });
    const result = calculateMarkout(
      { orderId: "b1", tsMs: 1000, side: "DOWN", action: "buy", price: 0.4 },
      refs,
      "settlement",
    );

    expect(result.referencePrice).toBe(1);
    expect(result.value).toBe(0.6);
  });
});
