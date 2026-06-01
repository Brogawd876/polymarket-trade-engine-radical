import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  ReplayLogReader,
  ReplayResolutionAdapter,
  ReplayRunner,
  VirtualClock,
  type ReplayBot,
} from "../../engine/bot-core/index.ts";

async function withTempLog<T>(contents: string, fn: (path: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "replay-log-"));
  try {
    const path = join(dir, "events.log");
    writeFileSync(path, contents, "utf8");
    return await fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("VirtualClock", () => {
  test("runs due timeouts in target-time and insertion order", () => {
    const clock = new VirtualClock();
    const seen: string[] = [];
    clock.setTimeout(() => seen.push("b"), 20);
    clock.setTimeout(() => seen.push("a"), 10);
    clock.setTimeout(() => seen.push("c"), 20);

    clock.setNowMs(20);

    expect(seen).toEqual(["a", "b", "c"]);
  });

  test("runs nested timers due at the current virtual time", () => {
    const clock = new VirtualClock();
    const seen: string[] = [];
    clock.setTimeout(() => {
      seen.push("outer");
      clock.setTimeout(() => seen.push("inner"), 0);
    }, 10);

    clock.setNowMs(10);

    expect(seen).toEqual(["outer", "inner"]);
  });

  test("supports intervals and self-cancellation inside the callback", () => {
    const clock = new VirtualClock();
    const seen: number[] = [];
    const handle = clock.setInterval(() => {
      seen.push(clock.nowMs());
      if (seen.length === 2) clock.clearInterval(handle);
    }, 5);

    clock.setNowMs(5);
    clock.setNowMs(10);
    clock.setNowMs(30);

    expect(seen).toEqual([5, 10]);
  });

  test("clearTimeout prevents a pending timeout", () => {
    const clock = new VirtualClock();
    let fired = false;
    const handle = clock.setTimeout(() => {
      fired = true;
    }, 1);
    clock.clearTimeout(handle);

    clock.setNowMs(1);

    expect(fired).toBe(false);
  });
});

describe("ReplayLogReader", () => {
  test("loads and dispatches sorted valid log events", async () => {
    await withTempLog(
      [
        JSON.stringify({ ts: 20, type: "ticker", assetPrice: 2 }),
        JSON.stringify({
          ts: 10,
          type: "slot",
          action: "start",
          slug: "btc-updown-5m-10",
          startTime: 10,
          endTime: 300010,
          strategy: "simulation",
        }),
      ].join("\n"), async (path) => {
        const reader = new ReplayLogReader(path);
        await reader.init();
        const seen: string[] = [];
        reader.subscribe((evt) => seen.push(evt.type));

        await reader.advanceTo(20);

        expect(reader.eventCount).toBe(2);
        expect(reader.round?.slug).toBe("btc-updown-5m-10");
        expect(seen).toEqual(["ticker", "slot"]);
        expect(reader.isDone()).toBe(true);
      },
    );
  });

  test("fails fast on malformed rows by default", async () => {
    await withTempLog("{ bad json", async (path) => {
      const reader = new ReplayLogReader(path);
      await expect(reader.init()).rejects.toThrow(/Replay log parse failed/);
    });
  });

  test("rejects empty logs as unusable", async () => {
    await withTempLog("\n", async (path) => {
      const reader = new ReplayLogReader(path);
      await expect(reader.init()).rejects.toThrow(/contains no usable events/);
    });
  });

  test("replays Chainlink settlement truth deterministically", async () => {
    await withTempLog(
      [
        JSON.stringify({
          ts: 1000,
          type: "slot",
          action: "start",
          slug: "btc-updown-5m-1000",
          startTime: 1000,
          endTime: 301000,
          strategy: "simulation",
        }),
        JSON.stringify({
          ts: 1100,
          type: "chainlink_resolution",
          source: "chainlink-polygon-btc-usd",
          sourceType: "chainlink_polygon",
          price: 100000.25,
          rawOracleAnswer: "10000025000000",
          roundId: "42",
          answeredInRound: "42",
          chainUpdatedAtMs: 1050,
          localReceivedAtMs: 1100,
          oracleLagMs: 50,
          quality: "live",
          stalenessStatus: "fresh",
          contractAddress: "0xc907E116054Ad103354f2D350FD2514433D57F6f",
        }),
      ].join("\n"), async (path) => {
        const reader = new ReplayLogReader(path);
        await reader.init();
        const adapter = new ReplayResolutionAdapter(reader);
        await reader.advanceTo(1100);

        const latest = adapter.latest();
        expect(latest?.sourceType).toBe("chainlink_polygon");
        expect(latest?.roundId).toBe("42");
        expect(latest?.price).toBe(100000.25);
        expect(latest?.oracleLagMs).toBe(50);
        expect(latest?.metadata?.contractAddress).toBe("0xc907E116054Ad103354f2D350FD2514433D57F6f");
      },
    );
  });
});

describe("ReplayRunner", () => {
  test("dispatches events, ticks the bot, and reports clean completion", async () => {
    await withTempLog(
        [
          JSON.stringify({
            ts: 1000,
            type: "slot",
            action: "start",
            slug: "btc-updown-5m-1000",
            startTime: 1000,
            endTime: 301000,
            strategy: "simulation",
          }),
          JSON.stringify({
            ts: 1001,
            type: "orderbook_snapshot",
            up: { bids: [], asks: [] },
            down: { bids: [], asks: [] },
          }),
          JSON.stringify({ ts: 1100, type: "ticker", assetPrice: 100 }),
        ].join("\n"),
        async (path) => {
          const reader = new ReplayLogReader(path);
        await reader.init();
          const clock = new VirtualClock();
          let ticks = 0;
          let activeLifecycleCount = 1;
          let isShuttingDown = false;
          const bot: ReplayBot = {
            get activeLifecycleCount() {
              return activeLifecycleCount;
            },
            get isShuttingDown() {
              return isShuttingDown;
            },
            replayStateSummary: () => `fixture:RUNNING(pending=${ticks})`,
            start: async () => {},
            tickOnce: async () => {
              ticks++;
              if (ticks >= 10) {
                activeLifecycleCount = 0;
                isShuttingDown = true;
              }
            },
            startShutdown: () => {},
          };

          const result = await new ReplayRunner(reader, bot, clock).run();

          expect(result.completed).toBe(true);
          expect(result.ticks).toBeGreaterThanOrEqual(10);
          expect(reader.isDone()).toBe(true);
        },
    );
  });

  test("applies replay resolution so STOPPING with pending=0 completes", async () => {
    await withTempLog(
      [
        JSON.stringify({
          ts: 1000,
          type: "slot",
          action: "start",
          slug: "btc-updown-5m-1000",
          startTime: 1000,
          endTime: 1300,
          strategy: "simulation",
        }),
        JSON.stringify({
          ts: 1001,
          type: "orderbook_snapshot",
          up: { bids: [], asks: [] },
          down: { bids: [], asks: [] },
        }),
        JSON.stringify({
          ts: 1301,
          type: "resolution",
          direction: "UP",
          openPrice: 100,
          closePrice: 101,
          unfilledShares: 0,
          payout: 0,
          pnl: 0,
        }),
        JSON.stringify({
          ts: 1302,
          type: "slot",
          action: "end",
          slug: "btc-updown-5m-1000",
          startTime: 1000,
          endTime: 1300,
          strategy: "simulation",
        }),
      ].join("\n"),
      async (path) => {
        const reader = new ReplayLogReader(path);
        await reader.init();
        const clock = new VirtualClock();
        const applied: unknown[] = [];
        let activeLifecycleCount = 1;
        let isShuttingDown = false;
        let shutdownCalls = 0;
        const bot: ReplayBot = {
          get activeLifecycleCount() {
            return activeLifecycleCount;
          },
          get isShuttingDown() {
            return isShuttingDown;
          },
          replayStateSummary: () => "btc-updown-5m-1000:STOPPING(pending=0)",
          start: async () => {},
          tickOnce: async () => {
            if (applied.length > 0) {
              activeLifecycleCount = 0;
              isShuttingDown = true;
            }
          },
          startShutdown: () => {
            shutdownCalls++;
            isShuttingDown = true;
          },
          applyReplayMarketResult: (result) => {
            applied.push(result);
          },
        };

        const result = await new ReplayRunner(reader, bot, clock).run();

        expect(result.completed).toBe(true);
        expect(applied).toEqual([
          {
            slug: "btc-updown-5m-1000",
            startTime: 1_000_000,
            endTime: 1_300_000,
            completed: true,
            openPrice: 100,
            closePrice: 101,
          },
        ]);
        expect(shutdownCalls).toBe(1);
      },
    );
  });

  test("does not emit STALL DETECTED when STOPPING pending=0 finalizes from replay resolution", async () => {
    await withTempLog(
      [
        JSON.stringify({
          ts: 1000,
          type: "slot",
          action: "start",
          slug: "btc-updown-5m-1000",
          startTime: 1000,
          endTime: 1300,
          strategy: "simulation",
        }),
        JSON.stringify({
          ts: 1001,
          type: "orderbook_snapshot",
          up: { bids: [], asks: [] },
          down: { bids: [], asks: [] },
        }),
        JSON.stringify({
          ts: 1301,
          type: "resolution",
          openPrice: 100,
          closePrice: 101,
        }),
      ].join("\n"),
      async (path) => {
        const reader = new ReplayLogReader(path);
        await reader.init();
        const clock = new VirtualClock();
        let settled = false;
        let activeLifecycleCount = 1;
        let isShuttingDown = false;
        const errors: string[] = [];
        const originalError = console.error;
        console.error = (...args: unknown[]) => {
          errors.push(args.map(String).join(" "));
        };
        try {
          const bot: ReplayBot = {
            get activeLifecycleCount() {
              return activeLifecycleCount;
            },
            get isShuttingDown() {
              return isShuttingDown;
            },
            replayStateSummary: () => "btc-updown-5m-1000:STOPPING(pending=0)",
            start: async () => {},
            tickOnce: async () => {
              if (settled) {
                activeLifecycleCount = 0;
                isShuttingDown = true;
              }
            },
            startShutdown: () => {
              isShuttingDown = true;
            },
            applyReplayMarketResult: () => {
              settled = true;
            },
          };

          await new ReplayRunner(reader, bot, clock).run();
        } finally {
          console.error = originalError;
        }

        expect(errors.some((line) => line.includes("STALL DETECTED"))).toBe(false);
      },
    );
  });

  test("still emits STALL DETECTED when STOPPING has pending work and no progress", async () => {
    await withTempLog(
      [
        JSON.stringify({
          ts: 1000,
          type: "slot",
          action: "start",
          slug: "btc-updown-5m-1000",
          startTime: 1000,
          endTime: 1300,
          strategy: "simulation",
        }),
        JSON.stringify({
          ts: 1001,
          type: "orderbook_snapshot",
          up: { bids: [], asks: [] },
          down: { bids: [], asks: [] },
        }),
      ].join("\n"),
      async (path) => {
        const reader = new ReplayLogReader(path);
        await reader.init();
        const clock = new VirtualClock();
        const errors: string[] = [];
        const originalError = console.error;
        console.error = (...args: unknown[]) => {
          errors.push(args.map(String).join(" "));
        };
        try {
          const bot: ReplayBot = {
            get activeLifecycleCount() {
              return 1;
            },
            get isShuttingDown() {
              return false;
            },
            replayStateSummary: () => "btc-updown-5m-1000:STOPPING(pending=1)",
            nextReplayDeadlineMs: () => null,
            start: async () => {},
            tickOnce: async () => {},
            startShutdown: () => {},
          };

          await expect(
            new ReplayRunner(reader, bot, clock, undefined, {
              stallTimeoutMs: 0,
              stallCheckEveryTicks: 1,
            }).run(),
          ).rejects.toThrow("Replay stalled");
        } finally {
          console.error = originalError;
        }

        expect(errors.some((line) => line.includes("STALL DETECTED"))).toBe(true);
      },
    );
  });
});



