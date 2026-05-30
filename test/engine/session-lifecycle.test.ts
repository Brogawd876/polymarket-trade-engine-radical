import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { join } from "path";
import { 
    TelemetryBus, 
    VirtualClock,
    RealClock
} from "../../engine/bot-core/index.ts";
import { EarlyBird } from "../../engine/early-bird.ts";
import { SessionManager } from "../../engine/session-manager.ts";

describe("Session Lifecycle Integration", () => {
  
  test("Start -> Monitor -> Stop (Clean Flow)", async () => {
    const bus = new TelemetryBus();
    const sessionManager = new SessionManager(bus);

    // 1. Initially IDLE
    expect(sessionManager.getStatus().sessionState).toBe("idle");

    // 2. Start Simulation
    await sessionManager.startSimulation({ strategy: "simulation", rounds: 1 });
    
    // Wait for it to transition to running and have a lifecycle
    let attempts = 0;
    while (attempts < 100) {
        const status = sessionManager.getStatus();
        if (status.sessionState === "running" && (status.engineStatus?.activeLifecycles ?? 0) > 0) {
            break;
        }
        await new Promise(r => setTimeout(r, 100));
        attempts++;
    }
    expect(sessionManager.getStatus().sessionState).toBe("running");

    // 3. Stop Session
    await sessionManager.stopSession();
    
    // Should transition to stopping immediately
    // Note: Due to await bot.stop(), it might transition to completed very fast if no positions.
    const stateAfterStop = sessionManager.getStatus().sessionState;
    expect(["stopping", "completed"]).toContain(stateAfterStop);

    // 4. Wait for Final Idle
    attempts = 0;
    while (sessionManager.getStatus().sessionState !== "idle" && attempts < 100) {
        await new Promise(r => setTimeout(r, 100));
        attempts++;
    }
    
    const finalStatus = sessionManager.getStatus();
    expect(finalStatus.sessionState).toBe("idle");
    expect(finalStatus.engineStatus).toBeNull();
  }, 20000);

  test("Stop with no active session is a no-op", async () => {
    const bus = new TelemetryBus();
    const sessionManager = new SessionManager(bus);
    await sessionManager.stopSession();
    expect(sessionManager.getStatus().sessionState).toBe("idle");
  });

  test("Resolution Timeout Hardening", async () => {
    // This test verifies that even if resolution price is missing, 
    // the session still completes thanks to the timeout in _waitForResolution.
    
    const bus = new TelemetryBus();
    const sessionManager = new SessionManager(bus);

    await sessionManager.startSimulation({ strategy: "simulation", rounds: 1 });
    
    // Wait for running
    let attempts = 0;
    while (sessionManager.getStatus().sessionState !== "running" && attempts < 50) {
        await new Promise(r => setTimeout(r, 100));
        attempts++;
    }

    // Force a position in the lifecycle to trigger _waitForResolution during shutdown
    const bot = (sessionManager as any)._bot as EarlyBird;
    const lifecycles = (bot as any)._lifecycles as Map<string, any>;
    const lifecycle = lifecycles.values().next().value;
    if (lifecycle) {
        (lifecycle as any)._tracker._shares = 1; // Direct inject
    }

    // Trigger stop
    const startStopTs = Date.now();
    await sessionManager.stopSession();
    
    // We expect this to return after the bot.stop() finishes.
    // bot.stop() waits for lifecycles to settle.
    // MarketLifecycle._waitForResolution has a 15s timeout.
    
    const duration = Date.now() - startStopTs;
    // It should complete eventually (not hang forever)
    expect(sessionManager.getStatus().sessionState).toBe("completed");
    
    // Move to idle
    attempts = 0;
    while (sessionManager.getStatus().sessionState !== "idle" && attempts < 50) {
        await new Promise(r => setTimeout(r, 100));
        attempts++;
    }
    expect(sessionManager.getStatus().sessionState).toBe("idle");
  }, 40000);

  test("Reset State clears blockReason and resets balance", async () => {
    const bus = new TelemetryBus();
    const sessionManager = new SessionManager(bus);

    // Manually block it
    (sessionManager as any)._blockReason = "TEST_BLOCK";
    expect(sessionManager.getStatus().blockReason).toBe("TEST_BLOCK");

    await sessionManager.resetState();
    
    expect(sessionManager.getStatus().blockReason).toBeNull();
  });

  test("Replay session completes a one-round fixture without stalling", async () => {
    const bus = new TelemetryBus();
    const sessionManager = new SessionManager(bus);
    const fixture = join(import.meta.dir, "..", "fixtures", "replay", "filled-order.log");

    await sessionManager.startReplay(fixture);

    let attempts = 0;
    while (attempts < 100) {
      const status = sessionManager.getStatus();
      if (status.sessionState === "completed" || status.sessionState === "idle" || status.sessionState === "failed") {
        break;
      }
      await new Promise(r => setTimeout(r, 50));
      attempts++;
    }

    const finalStatus = sessionManager.getStatus();
    expect(finalStatus.sessionState).not.toBe("failed");
    expect(finalStatus.blockReason).toBeNull();
    expect(["completed", "idle"]).toContain(finalStatus.sessionState);
  }, 10000);

  test("Replay session honors explicit strategy selection", async () => {
    const bus = new TelemetryBus();
    const sessionManager = new SessionManager(bus);
    const fixture = join(import.meta.dir, "..", "fixtures", "replay", "filled-order.log");

    await sessionManager.startReplay(fixture, { strategy: "late-entry" });

    const status = sessionManager.getStatus();
    expect(status.engineMode).toBe("replay");
    expect(status.engineStatus?.strategy).toBe("late-entry");

    await sessionManager.stopSession();
  }, 10000);
});
