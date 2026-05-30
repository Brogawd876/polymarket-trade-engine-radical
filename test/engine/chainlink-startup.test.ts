import { describe, expect, test } from "bun:test";
import { ChainlinkResolutionAdapter } from "../../engine/bot-core/chainlink-resolution-adapter.ts";
import { VirtualClock } from "../../engine/bot-core/replay-runner.ts";
import { createEventClock } from "../../engine/bot-core/data-sources.ts";

describe("Chainlink Mid-Round Startup Hardening", () => {
  const BTC_USD_POLYGON = "0xc907E116054Ad103354f2D350FD2514433D57F6f";

  test("blocks anchor if started mid-round without history", async () => {
    const clock = new VirtualClock();
    
    // Scenario: Round starts at T=100,000. Bot starts at T=110,000 (10s late).
    const roundStart = 100_000;
    clock.setNowMs(110_000);
    
    const adapter = new ChainlinkResolutionAdapter({
        clock,
        contractAddress: BTC_USD_POLYGON
    });

    // Inject data from T=110,000 (current spot)
    (adapter as any).latestEvent = {
        id: "ev1",
        role: "resolution",
        price: 60000,
        clock: createEventClock({ 
            sourceTimestampMs: 110_000,
            receivedAtMs: 110_000 
        }),
        quality: "live",
        stalenessStatus: "fresh"
    };

    const round = {
        slug: "btc-updown-5m-100",
        startTimeMs: roundStart,
        endTimeMs: roundStart + 300_000
    } as any;

    const anchor = await adapter.priceToBeat(round);
    
    // SHOULD BE NULL: We missed the true start price
    expect(anchor).toBeNull();
    expect(adapter.latestAnchor()).toBeNull();
  });

  test("allows anchor if started mid-round but current data predates round", async () => {
    const clock = new VirtualClock();
    
    // Scenario: Round starts at T=100,000. Bot starts at T=102,000 (2s late).
    // Chainlink hasn't updated yet (last update at T=95,000).
    const roundStart = 100_000;
    clock.setNowMs(102_000);
    
    const adapter = new ChainlinkResolutionAdapter({
        clock,
        contractAddress: BTC_USD_POLYGON
    });

    (adapter as any).latestEvent = {
        id: "ev1",
        role: "resolution",
        price: 59000,
        clock: createEventClock({ 
            sourceTimestampMs: 95_000,
            receivedAtMs: 95_000 
        }),
        quality: "live",
        stalenessStatus: "fresh",
        chainUpdatedAtMs: 95_000
    };

    const round = {
        slug: "btc-updown-5m-100",
        startTimeMs: roundStart,
        endTimeMs: roundStart + 300_000
    } as any;

    const anchor = await adapter.priceToBeat(round);
    
    // SHOULD BE ALLOWED: The current price is the same price that was active at start
    expect(anchor?.price).toBe(59000);
    expect(adapter.latestAnchor()?.price).toBe(59000);
  });

  test("allows anchor if Chainlink updated exactly at round open", async () => {
    const clock = new VirtualClock();
    const roundStart = 100_000;
    clock.setNowMs(100_000);

    const adapter = new ChainlinkResolutionAdapter({
        clock,
        contractAddress: BTC_USD_POLYGON
    });

    (adapter as any).latestEvent = {
        id: "ev1",
        role: "resolution",
        price: 59100,
        clock: createEventClock({
            sourceTimestampMs: roundStart,
            receivedAtMs: roundStart
        }),
        quality: "live",
        stalenessStatus: "fresh",
        chainUpdatedAtMs: roundStart
    };

    const round = {
        slug: "btc-updown-5m-100",
        startTimeMs: roundStart,
        endTimeMs: roundStart + 300_000
    } as any;

    const anchor = await adapter.priceToBeat(round);
    expect(anchor?.price).toBe(59100);
    expect(anchor?.priceToBeat).toBe(59100);
  });

  test("blocks anchor if only observed Chainlink state is after round open", async () => {
    const clock = new VirtualClock();
    const roundStart = 100_000;
    clock.setNowMs(100_000);

    const adapter = new ChainlinkResolutionAdapter({
        clock,
        contractAddress: BTC_USD_POLYGON
    });

    (adapter as any).latestEvent = {
        id: "ev1",
        role: "resolution",
        price: 60200,
        clock: createEventClock({
            sourceTimestampMs: roundStart + 1,
            receivedAtMs: roundStart + 1
        }),
        quality: "live",
        stalenessStatus: "fresh",
        chainUpdatedAtMs: roundStart + 1
    };

    const round = {
        slug: "btc-updown-5m-100",
        startTimeMs: roundStart,
        endTimeMs: roundStart + 300_000
    } as any;

    expect(await adapter.priceToBeat(round)).toBeNull();
    expect(adapter.latestAnchor()).toBeNull();
  });

  test("later Chainlink updates do not mutate a latched opening anchor", async () => {
    const clock = new VirtualClock();
    const roundStart = 100_000;
    clock.setNowMs(99_000);

    const adapter = new ChainlinkResolutionAdapter({
        clock,
        contractAddress: BTC_USD_POLYGON
    });

    (adapter as any).latestEvent = {
        id: "ev1",
        role: "resolution",
        price: 59900,
        clock: createEventClock({
            sourceTimestampMs: 99_000,
            receivedAtMs: 99_000
        }),
        quality: "live",
        stalenessStatus: "fresh",
        chainUpdatedAtMs: 99_000
    };

    const round = {
        slug: "btc-updown-5m-100",
        startTimeMs: roundStart,
        endTimeMs: roundStart + 300_000
    } as any;

    expect((await adapter.priceToBeat(round))?.price).toBe(59900);

    (adapter as any).latestEvent = {
        id: "ev2",
        role: "resolution",
        price: 61000,
        clock: createEventClock({
            sourceTimestampMs: 101_000,
            receivedAtMs: 101_000
        }),
        quality: "live",
        stalenessStatus: "fresh",
        chainUpdatedAtMs: 101_000
    };

    expect((await adapter.priceToBeat(round))?.price).toBe(59900);
    expect(adapter.latestAnchor()?.priceToBeat).toBe(59900);
  });

  test("allows anchor if started before round", async () => {
    const clock = new VirtualClock();
    
    // Bot starts at T=90,000. Round starts at T=100,000.
    clock.setNowMs(90_000);
    const adapter = new ChainlinkResolutionAdapter({ clock });

    (adapter as any).latestEvent = {
        id: "ev1",
        role: "resolution",
        price: 58000,
        clock: createEventClock({ sourceTimestampMs: 90_000, receivedAtMs: 90_000 }),
        quality: "live",
        stalenessStatus: "fresh",
        chainUpdatedAtMs: 90_000
    };

    const round = {
        slug: "btc-updown-5m-100",
        startTimeMs: 100_000,
        endTimeMs: 400_000
    } as any;

    const anchor = await adapter.priceToBeat(round);
    expect(anchor?.price).toBe(58000);
  });
});
