import { describe, expect, test, spyOn, afterEach } from "bun:test";
import { EarlyBird } from "../../engine/early-bird.ts";
import { TerminalAccessError } from "../../utils/errors";
import { TickerTracker } from "../../tracker/ticker";
import { ChainlinkResolutionAdapter } from "../../engine/bot-core/chainlink-resolution-adapter";

describe("Engine-Level Geoblock Shutdown", () => {
  afterEach(() => {
    spyOn(TickerTracker.prototype, "waitForReady").mockRestore();
    spyOn(ChainlinkResolutionAdapter.prototype, "start").mockRestore();
  });

  test("EarlyBird start() fails fast on terminal resolution block", async () => {
    spyOn(TickerTracker.prototype, "waitForReady").mockImplementation(async () => {});
    spyOn(ChainlinkResolutionAdapter.prototype, "start").mockImplementation(async () => {
      throw new TerminalAccessError("Geoblocked", 403);
    });

    const bot = new EarlyBird("simulation", 1, false, 1, true);
    const mockExit = spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`process.exit(${code})`);
    });

    try {
        await bot.start();
        expect(false).toBe(true);
    } catch (e: any) {
        expect(e.message).toContain("Terminal Access Error");
    }
    mockExit.mockRestore();
  });

  test("EarlyBird _tick catches terminal error from lifecycle and triggers shutdown", async () => {
    const bot = new EarlyBird("simulation", 1, false, 1, true);
    
    (bot as any)._userChannelFactory = () => ({});
    (bot as any)._tracker = {};
    (bot as any)._ticker = { schedule: () => {}, waitForReady: async () => {} };
    (bot as any)._resolution = { start: async () => {}, isReady: () => true, subscribe: () => {}, stop: () => {} };
    (bot as any)._binance = { start: async () => {}, stop: () => {} };
    (bot as any)._coinbase = { start: async () => {}, stop: () => {} };
    (bot as any)._quant = { start: async () => {} };
    (bot as any)._aggregator = { start: async () => {} };
    (bot as any)._tradeTape = { start: async () => {} };
    (bot as any)._apiQueue = { prefetchFutureRounds: async () => {} };
    (bot as any)._eventWriter = { append: async () => {}, close: async () => {} };
    (bot as any)._client = { start: async () => {}, init: async () => {} };
    (bot as any)._telemetry = { push: () => {} };
    (bot as any)._replayReader = { init: async () => {} };

    await bot.start();
    
    const mockLifecycle: any = {
        slug: "test-slug",
        state: "RUNNING",
        tick: async () => {
            throw new TerminalAccessError("Ticking Blocked", 403);
        },
        shutdown: () => {
            mockLifecycle.state = "DONE";
        },
        destroy: () => {}
    };
    
    (bot as any)._spawner.getActiveLifecycles().set("test-slug", mockLifecycle);
    const shutdownSpy = spyOn(bot as any, "_startShutdown");

    try {
        await (bot as any).tickOnce();
    } catch (e: any) {
        expect(e).toBeInstanceOf(TerminalAccessError);
    }

    expect(shutdownSpy).toHaveBeenCalledWith("Terminal Access Error");
    await bot.stop();
  });
});
