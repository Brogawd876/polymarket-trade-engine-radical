import { describe, expect, test } from "bun:test";
import {
  ChainlinkResolutionAdapter,
  type ChainlinkFeedReader,
} from "../../engine/bot-core/chainlink-resolution-adapter.ts";
import { VirtualClock } from "../../engine/bot-core/replay-runner.ts";

class MockReader implements ChainlinkFeedReader {
  round = {
    roundId: 10n,
    answer: 100_123_456_789n,
    startedAt: 1778891400n,
    updatedAt: 1778891401n,
    answeredInRound: 10n,
  };
  decimalsValue = 8;
  descriptionValue = "BTC / USD";
  fail = false;

  async latestRoundData() {
    if (this.fail) throw new Error("rpc down");
    return this.round;
  }
  async decimals() {
    return this.decimalsValue;
  }
  async description() {
    return this.descriptionValue;
  }
}

describe("ChainlinkResolutionAdapter", () => {
  test("parses latestRoundData, decimals, lag, and metadata", async () => {
    const clock = new VirtualClock();
    clock.setNowMs(1778891405_000);
    const reader = new MockReader();
    const adapter = new ChainlinkResolutionAdapter({
      reader,
      clock,
      staleAfterMs: 60_000,
    });

    const event = await adapter.pollOnce();

    expect(event?.sourceType).toBe("chainlink_polygon");
    expect(event?.price).toBe(1001.23456789);
    expect(event?.rawOracleAnswer).toBe("100123456789");
    expect(event?.roundId).toBe("10");
    expect(event?.chainUpdatedAtMs).toBe(1778891401_000);
    expect(event?.localReceivedAtMs).toBe(1778891405_000);
    expect(event?.oracleLagMs).toBe(4000);
    expect(event?.quality).toBe("live");
    expect(event?.metadata?.contractAddress).toBe("0xc907E116054Ad103354f2D350FD2514433D57F6f");
  });

  test("emits only when round data changes meaningfully", async () => {
    const clock = new VirtualClock();
    clock.setNowMs(1778891405_000);
    const reader = new MockReader();
    const adapter = new ChainlinkResolutionAdapter({ reader, clock });
    const events: string[] = [];
    adapter.subscribe((event) => events.push(event.roundId ?? "none"));

    await adapter.pollOnce();
    await adapter.pollOnce();
    reader.round = { ...reader.round, roundId: 11n, answeredInRound: 11n };
    await adapter.pollOnce();

    expect(events).toEqual(["10", "11"]);
  });

  test("marks stale oracle data and degraded RPC health fail-closed", async () => {
    const clock = new VirtualClock();
    clock.setNowMs(1778891500_000);
    const reader = new MockReader();
    const adapter = new ChainlinkResolutionAdapter({
      reader,
      clock,
      staleAfterMs: 10_000,
      maxRpcFailures: 1,
    });

    const stale = await adapter.pollOnce();
    expect(stale?.quality).toBe("stale");
    expect(adapter.isReady()).toBe(false);

    reader.fail = true;
    await adapter.pollOnce();
    expect(adapter.health().status).toBe("degraded");
    expect(adapter.latest()?.stalenessStatus).toBe("degraded");
  });

  // Phase 8U: priceToBeat anchor sentinel tests

  test("priceToBeat returns null when no observed events exist before round start", async () => {
    const clock = new VirtualClock();
    clock.setNowMs(1_000_000_000);
    const reader = new MockReader();
    // Round start is in the PAST (before any observed events)
    reader.round = { ...reader.round, updatedAt: 1_000_000_002n }; // after round start

    const adapter = new ChainlinkResolutionAdapter({ reader, clock, staleAfterMs: 60_000 });
    await adapter.pollOnce(); // records event with updatedAt = 1_000_000_002s = after round start

    const round = {
      slug: "test-round",
      asset: "btc" as const,
      window: "5m" as const,
      startTimeMs: 1_000_000_001_000, // round start is before the observed event's chainUpdatedAtMs
      endTimeMs: 1_000_000_301_000,
    };

    // The observed event updatedAt (1_000_000_002s = 1_000_000_002_000ms) is AFTER round.startTimeMs (1_000_000_001_000ms)
    // So no qualifying anchor should exist
    const anchor = await adapter.priceToBeat(round);
    expect(anchor).toBeNull();
  });

  test("priceToBeat returns null when all observed events are stale", async () => {
    const clock = new VirtualClock();
    clock.setNowMs(1_778_891_500_000); // very far in the future
    const reader = new MockReader();
    // Event is from much earlier
    reader.round = { ...reader.round, updatedAt: 1_778_891_401n };

    const adapter = new ChainlinkResolutionAdapter({
      reader,
      clock,
      staleAfterMs: 10_000, // 10s stale threshold
    });
    await adapter.pollOnce(); // records stale event (lagMs >> 10s)

    const round = {
      slug: "stale-round",
      asset: "btc" as const,
      window: "5m" as const,
      // Round started before the event, so timestamp filter passes
      startTimeMs: 1_778_891_402_000,
      endTimeMs: 1_778_891_702_000,
    };

    // Event quality is "stale" so findOpeningAnchor should exclude it
    const anchor = await adapter.priceToBeat(round);
    expect(anchor).toBeNull();
  });

  test("priceToBeat returns anchor when a valid event exists before round start", async () => {
    const clock = new VirtualClock();
    clock.setNowMs(1_778_891_405_000);
    const reader = new MockReader();
    reader.round = { ...reader.round, updatedAt: 1_778_891_401n }; // 4s lag, fresh

    const adapter = new ChainlinkResolutionAdapter({ reader, clock, staleAfterMs: 60_000 });
    await adapter.pollOnce();

    const round = {
      slug: "fresh-round",
      asset: "btc" as const,
      window: "5m" as const,
      startTimeMs: 1_778_891_402_000, // round start AFTER event updatedAt (1_778_891_401_000ms)
      endTimeMs: 1_778_891_702_000,
    };

    const anchor = await adapter.priceToBeat(round);
    expect(anchor).not.toBeNull();
    expect(anchor?.kind).toBe("open");
    expect(anchor?.priceToBeat).toBeDefined();
    expect(anchor?.round?.slug).toBe("fresh-round");
  });
});
