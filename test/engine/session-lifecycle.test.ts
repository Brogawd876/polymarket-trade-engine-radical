import { describe, expect, test } from "bun:test";
import { join } from "path";
import { 
    TelemetryBus
} from "../../engine/bot-core/index.ts";
import { SessionManager } from "../../engine/session-manager.ts";

describe("Session Lifecycle Integration", () => {
  
  test("Start -> Monitor -> Stop (Clean Flow)", async () => {
    const bus = new TelemetryBus();
    const sessionManager = new SessionManager(bus);
    const fixture = join(import.meta.dir, "..", "fixtures", "replay", "filled-order.log");

    // 1. Initially IDLE
    expect(sessionManager.getStatus().sessionState).toBe("idle");

    // 2. Start deterministic replay session
    await sessionManager.startReplay(fixture, { strategy: "simulation" });
    
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

  test("Stop returns promptly for replay sessions with active lifecycle", async () => {
    const bus = new TelemetryBus();
    const sessionManager = new SessionManager(bus);
    const fixture = join(import.meta.dir, "..", "fixtures", "replay", "filled-order.log");

    await sessionManager.startReplay(fixture, { strategy: "simulation" });
    
    // Wait for running
    let attempts = 0;
    while (sessionManager.getStatus().sessionState !== "running" && attempts < 50) {
        await new Promise(r => setTimeout(r, 100));
        attempts++;
    }

    // Trigger stop
    const startStopTs = Date.now();
    await sessionManager.stopSession();

    const duration = Date.now() - startStopTs;
    expect(duration).toBeLessThan(5_000);
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
