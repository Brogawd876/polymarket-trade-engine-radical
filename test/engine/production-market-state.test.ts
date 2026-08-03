import { describe, expect, test } from "bun:test";
import {
  MarketRegistry,
  createFeedObservation,
  observationAges,
  proveAnchor,
  type OfficialMarketMetadata,
} from "../../engine/production/market-state.ts";
import { PredictiveFeedService } from "../../engine/production/predictive-state.ts";
import { VenueBookService } from "../../engine/production/venue-book.ts";

const START = 1_800_000_000_000;

function metadata(
  overrides: Partial<OfficialMarketMetadata> = {},
): OfficialMarketMetadata {
  return {
    marketId: "market-1",
    eventId: "event-1",
    conditionId: "condition-1",
    slug: `btc-updown-5m-${START / 1000}`,
    windowStartMs: START,
    windowEndMs: START + 300_000,
    acceptingOrders: true,
    outcomes: [
      { name: "Down", tokenId: "token-down" },
      { name: "Up", tokenId: "token-up" },
    ],
    tickSize: "0.01",
    minimumOrderSize: "5",
    feeDetails: {
      makerRateBps: "0",
      takerBaseRateBps: "25",
      exponent: "2",
      effectiveAtMs: START - 1000,
      sourceEvidenceId: "market-info-1",
    },
    resolutionSource: "Chainlink BTC/USD on Polygon",
    equalityResolvesUp: true,
    rulesText: "UP wins when end is greater than or equal to start.",
    rawMetadata: { id: "market-1", outcomes: ["Down", "Up"] },
    ...overrides,
  };
}

describe("canonical market registry and exact anchor proof", () => {
  test("maps outcomes by official labels rather than token position", () => {
    const registry = new MarketRegistry();
    const contract = registry.register(metadata());
    expect(contract.upTokenId).toBe("token-up");
    expect(contract.downTokenId).toBe("token-down");
    expect(contract.outcomeMapping["token-down"]).toBe("DOWN");
  });

  test("rejects an adjacent slot even when other metadata looks plausible", () => {
    const registry = new MarketRegistry();
    expect(() =>
      registry.register(
        metadata({ windowStartMs: START + 300_000, windowEndMs: START + 600_000 }),
      ),
    ).toThrow(/does not exactly match/);
  });

  test("blocks predictive-source anchors and exact Price-to-Beat mismatches", () => {
    const registry = new MarketRegistry();
    const contract = registry.register(metadata());
    const proof = proveAnchor({
      contract,
      designatedSource: "BINANCE",
      exactPrice: "100000.123456",
      sourceTimestampMs: START,
      ingestTimestampMs: START + 10,
      sourceEndpoint: "binance",
      sourceTopic: "btcusdt",
      rawPayload: { p: "100000.123456" },
      comparisonEvidenceId: "polymarket-open-1",
      comparisonExactPrice: "100000.123455",
      maximumSourceAgeAtWindowMs: 1_000,
    });
    expect(proof.approved).toBe(false);
    expect(proof.comparisonResult).toBe("MISMATCH");
    expect(() => registry.attachAnchor(contract.marketId, proof)).toThrow(
      /anchor proof is blocked/,
    );
  });

  test("attaches an exact designated anchor and requires the intended slot", () => {
    const registry = new MarketRegistry();
    const contract = registry.register(metadata());
    const proof = proveAnchor({
      contract,
      designatedSource: "CHAINLINK_POLYGON_BTC_USD",
      exactPrice: "100000.123456",
      sourceTimestampMs: START,
      ingestTimestampMs: START + 10,
      sourceEndpoint: "polygon-rpc",
      sourceTopic: "chainlink-round-10",
      rawPayload: { answer: "10000012345600", decimals: 8 },
      comparisonEvidenceId: "polymarket-open-1",
      comparisonExactPrice: "100000.123456",
      maximumSourceAgeAtWindowMs: 1_000,
    });
    registry.attachAnchor(contract.marketId, proof);
    expect(registry.requireTradable(contract.marketId, START).anchorVerified).toBe(
      true,
    );
    expect(() =>
      registry.requireTradable(contract.marketId, START + 300_000),
    ).toThrow(/not the intended/);
  });

  test("rejects a stale Chainlink source timestamp despite fresh ingestion", () => {
    const registry = new MarketRegistry();
    const contract = registry.register(metadata());
    const proof = proveAnchor({
      contract,
      designatedSource: "CHAINLINK_POLYGON_BTC_USD",
      exactPrice: "100000.123456",
      sourceTimestampMs: START - 2_000,
      ingestTimestampMs: START,
      sourceEndpoint: "polygon-rpc",
      sourceTopic: "chainlink-round-stale",
      rawPayload: { answer: "10000012345600", decimals: 8 },
      comparisonEvidenceId: "polymarket-open-stale",
      comparisonExactPrice: "100000.123456",
      maximumSourceAgeAtWindowMs: 1_000,
    });
    expect(proof.approved).toBe(false);
    expect(proof.blockingReason).toContain("stale");
    expect(() => registry.attachAnchor(contract.marketId, proof)).toThrow(
      /anchor proof is blocked/,
    );
  });

  test("replaces dynamic tick, minimum-size, fee, and accepting-order state", () => {
    const registry = new MarketRegistry();
    registry.register(metadata());
    const updated = registry.updateDynamicInfo("market-1", {
      acceptingOrders: false,
      tickSize: "0.001",
      minimumOrderSize: "10",
      feeDetails: {
        makerRateBps: "1",
        takerBaseRateBps: "30",
        exponent: "2",
        effectiveAtMs: START + 1,
        sourceEvidenceId: "market-info-2",
      },
    });
    expect(updated.acceptingOrders).toBe(false);
    expect(updated.tickSize).toBe("0.001");
    expect(updated.minimumOrderSize).toBe("10");
    expect(updated.feeDetails.sourceEvidenceId).toBe("market-info-2");
    expect(registry.get("market-1")?.feeDetails.takerBaseRateBps).toBe("30");
    expect(() =>
      registry.updateDynamicInfo("market-1", {
        acceptingOrders: true,
        tickSize: "0",
        minimumOrderSize: "10",
        feeDetails: updated.feeDetails,
      }),
    ).toThrow(/must be positive/);
  });
});

describe("feed clocks, predictive normalization, and venue continuity", () => {
  test("keeps source age distinct from fresh ingestion age", () => {
    const observation = createFeedObservation({
      source: "chainlink",
      instrument: "BTC/USD",
      sourceTimestampMs: START,
      ingestTimestampMs: START + 9_000,
      monotonicIngestNs: "1",
      value: "100000",
      bid: null,
      ask: null,
      size: null,
      valid: true,
      exclusionReason: null,
      rawPayload: { answer: "10000000000000" },
    });
    expect(observationAges(observation, START + 10_000)).toEqual({
      sourceAgeMs: 10_000,
      ingestAgeMs: 1_000,
      transportLagMs: 9_000,
    });
  });

  test("excludes stale venues and computes volatility-normalized disagreement", () => {
    const service = new PredictiveFeedService({
      binance: { basisLog: 0.001, reliability: 1, maximumSourceAgeMs: 2_000 },
      coinbase: { basisLog: 0, reliability: 0.5, maximumSourceAgeMs: 2_000 },
    });
    service.update(
      createFeedObservation({
        source: "binance",
        instrument: "BTC/USDT",
        sourceTimestampMs: START + 9_500,
        ingestTimestampMs: START + 9_550,
        monotonicIngestNs: "2",
        value: "101000",
        bid: "100999",
        ask: "101001",
        size: "1",
        valid: true,
        exclusionReason: null,
        rawPayload: { p: "101000" },
      }),
    );
    service.update(
      createFeedObservation({
        source: "coinbase",
        instrument: "BTC/USD",
        sourceTimestampMs: START,
        ingestTimestampMs: START + 9_900,
        monotonicIngestNs: "3",
        value: "100000",
        bid: "99999",
        ask: "100001",
        size: "1",
        valid: true,
        exclusionReason: null,
        rawPayload: { price: "100000" },
      }),
    );
    const state = service.snapshot({
      decisionTimestampMs: START + 10_000,
      predictedOraclePrice: 100_000,
      expectedIntegratedVariance: 0.0001,
      minimumVenueCount: 1,
    });
    expect(state.availableVenueCount).toBe(1);
    expect(state.venues.coinbase?.included).toBe(false);
    expect(state.disagreementStatistic).toBeGreaterThan(0);
  });

  test("marks a sequence gap and refuses to use the book", () => {
    const service = new VenueBookService();
    service.applySnapshot({
      tokenId: "UP",
      sequence: "10",
      continuity: "CONTINUOUS",
      sourceTimestampMs: START,
      ingestTimestampMs: START + 1,
      bids: [{ price: "0.49", quantity: "10" }],
      asks: [{ price: "0.51", quantity: "10" }],
      originalPayloadHash: "hash-1",
    });
    expect(() =>
      service.applyDelta({
        tokenId: "UP",
        sequence: "12",
        continuity: "CONTINUOUS",
        sourceTimestampMs: START + 10,
        ingestTimestampMs: START + 11,
        bids: [{ price: "0.5", quantity: "10" }],
        asks: [{ price: "0.52", quantity: "10" }],
        originalPayloadHash: "hash-2",
      }),
    ).toThrow(/sequence gap/);
    expect(() => service.requireFreshContinuous("UP", START + 12, 1000)).toThrow(
      /sequence gap/,
    );
  });
});
