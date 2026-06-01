import { describe, expect, test } from "bun:test";
import { MarketSpawner } from "../../engine/bot-core/market-spawner.ts";
import { TerminalAccessError } from "../../utils/errors.ts";

describe("MarketSpawner Shutdown Semantics", () => {
  const mockClock: any = {
    nowMs: () => Date.now(),
    setInterval: (cb: any) => setInterval(cb, 10),
    clearInterval: (id: any) => clearInterval(id)
  };
  
  const createSpawner = () => {
    return new MarketSpawner({
      botContext: { replayReader: null } as any,
      apiQueue: { prefetchFutureRounds: async () => {} } as any,
      clock: mockClock,
      rounds: 0,
      onLifecycleDone: () => {},
      onTerminalError: () => {},
      onRoundsExhausted: () => {},
    } as any);
  };

  test("stop() does not hang when a lifecycle has a terminal error and clears it cleanly", async () => {
    const spawner = createSpawner();
    
    // Inject a mock lifecycle that throws TerminalAccessError
    const mockLifecycle: any = {
      state: "RUNNING",
      tick: async () => {
        throw new TerminalAccessError("Simulated Terminal Error", 403);
      },
      shutdown: () => {
        mockLifecycle.state = "DONE";
      }
    };
    spawner.injectRecoveredLifecycle("test-slug", mockLifecycle);
    
    expect(spawner.activeLifecycleCount).toBe(1);
    
    // Running tickOnce() should catch the terminal error, call shutdown(), and mark as DONE.
    await spawner.tickOnce();
    
    expect(spawner.activeLifecycleCount).toBe(0);
    
    // And stop() should be fast and clean
    const startTime = Date.now();
    await spawner.stop();
    const duration = Date.now() - startTime;
    expect(duration).toBeLessThan(100);
  });

  test("stop() applies a bounded timeout and force clears if a lifecycle hangs", async () => {
    const spawner = createSpawner();
    
    // Inject a mock lifecycle that refuses to transition to DONE
    const mockLifecycle: any = {
      state: "RUNNING",
      tick: async () => {},
      shutdown: () => {
        mockLifecycle.state = "STOPPING"; // Never transitions to DONE
      }
    };
    spawner.injectRecoveredLifecycle("hanging-slug", mockLifecycle);
    
    expect(spawner.activeLifecycleCount).toBe(1);
    
    // Override setTimeout to run fast for the test
    const originalSetTimeout = global.setTimeout;
    let timeoutsCalled = 0;
    (global as any).setTimeout = (cb: any, ms: number) => {
      timeoutsCalled++;
      return originalSetTimeout(cb, 1);
    };
    
    const startTime = Date.now();
    await spawner.stop(); // Should loop 20 times then force clear
    
    (global as any).setTimeout = originalSetTimeout;
    
    expect(timeoutsCalled).toBeGreaterThanOrEqual(20);
    expect(spawner.activeLifecycleCount).toBe(0); // Force cleared!
  });
});
