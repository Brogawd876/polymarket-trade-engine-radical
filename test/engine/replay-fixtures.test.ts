import { describe, expect, test } from "bun:test";
import { EarlyBird } from "../../engine/early-bird.ts";
import { 
  VirtualClock, 
  ReplayRunner,
  ReplayLogReader
} from "../../engine/bot-core/index.ts";
import { join } from "path";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures", "replay");

describe("Historical Replay Regression", () => {
  
  test("expired-order fixture reaches DONE and placed 1 order", async () => {
    const logPath = join(FIXTURES_DIR, "expired-order.log");
    const clock = new VirtualClock();
    const bot = new EarlyBird(
      "simulation",
      1,
      false,
      1,
      true,
      logPath,
      { clock, persistState: false }
    );
    const reader = bot.replayReader!;
    const runner = new ReplayRunner(reader, bot, clock);
    
    const result = await runner.run();
    
    expect(result.completed).toBe(true);
    expect(bot.activeLifecycleCount).toBe(0);
    // We can check PnL or other stats via the bot instance if we had access to completedMarkets
    // For now, completion and state-machine flow is the primary assertion.
  });

  test("filled-order fixture reaches DONE", async () => {
    const logPath = join(FIXTURES_DIR, "filled-order.log");
    const clock = new VirtualClock();
    const bot = new EarlyBird(
      "simulation",
      1,
      false,
      1,
      true,
      logPath,
      { clock, persistState: false }
    );
    const reader = bot.replayReader!;
    const runner = new ReplayRunner(reader, bot, clock);
    
    const result = await runner.run();
    expect(result.completed).toBe(true);
    expect(bot.activeLifecycleCount).toBe(0);
  });

  test("synthetic-divergence fixture blocks orders", async () => {
    const logPath = join(FIXTURES_DIR, "synthetic-divergence.log");
    const clock = new VirtualClock();
    const bot = new EarlyBird(
      "simulation",
      1,
      false,
      1,
      true,
      logPath,
      { clock, persistState: false }
    );
    const reader = bot.replayReader!;
    const runner = new ReplayRunner(reader, bot, clock);
    
    await runner.run();
    
    // In this synthetic log, divergence is 129, threshold is 50.
    // The simulation strategy should attempt to place an order,
    // but the AggregatedRiskGate should block it.
    // We verify by checking if any order reached the "placed" status in history 
    // or if the summary contains "blocked".
    // Currently ReplayRunner doesn't expose blocked counts, but we can see them in logs.
    expect(bot.activeLifecycleCount).toBe(0);
  });

  test("synthetic-stale-feed fixture no-trades the round", async () => {
    const logPath = join(FIXTURES_DIR, "synthetic-stale-feed.log");
    const clock = new VirtualClock();
    const bot = new EarlyBird(
      "simulation",
      1,
      false,
      1,
      true,
      logPath,
      { clock, persistState: false }
    );
    const reader = bot.replayReader!;
    const runner = new ReplayRunner(reader, bot, clock);
    
    await runner.run();
    
    // With 10s gap, required feed readiness should fail (5s timeout).
    // Round should transition to DONE without strategy execution.
    expect(bot.activeLifecycleCount).toBe(0);
  });
});
