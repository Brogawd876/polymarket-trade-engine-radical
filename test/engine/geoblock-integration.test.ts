import { describe, expect, test, spyOn, afterEach } from "bun:test";
import { EarlyBird } from "../../engine/early-bird.ts";
import { TerminalAccessError } from "../../utils/errors";
import { TickerTracker } from "../../tracker/ticker";
import { PolymarketResolutionAdapter } from "../../engine/bot-core/polymarket-resolution-adapter";

describe("Engine-Level Geoblock Shutdown", () => {
  afterEach(() => {
    spyOn(TickerTracker.prototype, "waitForReady").mockRestore();
    spyOn(PolymarketResolutionAdapter.prototype, "start").mockRestore();
  });

  test("EarlyBird start() fails fast on terminal resolution block", async () => {
    spyOn(TickerTracker.prototype, "waitForReady").mockImplementation(async () => {});
    spyOn(PolymarketResolutionAdapter.prototype, "start").mockImplementation(async () => {
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
    
    // Minimal mocks to allow _tick to run without crashing on init
    (bot as any)._userChannelFactory = () => ({});
    (bot as any)._tracker = {};
    (bot as any)._ticker = { price: 100 };
    (bot as any)._roundsCreated = 1; // Prevent creating new lifecycles in this test

    const mockLifecycle: any = {
        slug: "test-slug",
        state: "RUNNING",
        tick: async () => {
            throw new TerminalAccessError("Ticking Blocked", 403);
        },
        shutdown: () => {},
        destroy: () => {}
    };
    
    (bot as any)._lifecycles.set("test-slug", mockLifecycle);
    const shutdownSpy = spyOn(bot as any, "_startShutdown");

    try {
        await (bot as any)._tick();
    } catch (e: any) {
        expect(e).toBeInstanceOf(TerminalAccessError);
    }

    expect(shutdownSpy).toHaveBeenCalledWith("Terminal Access Error");
  });
});
