import { describe, expect, test } from "bun:test";
import { SessionManager, type ActivePresetContext } from "../../engine/session-manager.ts";
import { TelemetryBus } from "../../engine/telemetry/bus.ts";

const preset: ActivePresetContext = {
  id: "simulation",
  moduleId: "simulation",
  label: "simulation",
  configHash: "abc123",
  strategyVersion: "1.0.0",
};

describe("SessionManager paper evidence collection", () => {
  test("collects preset paper evidence from telemetry without running a session", async () => {
    const bus = new TelemetryBus();
    const manager = new SessionManager(bus);
    const rows: any[] = [];
    manager.setPaperEvidenceRecorder(row => rows.push(row));

    (manager as any)._startPaperEvidence(preset);
    bus.push({ ts: 1, type: "RISK_DECISION", payload: { slug: "s", approved: false, reasons: ["gate"], intent: {} as any } });
    bus.push({ ts: 2, type: "ORDER_LIFECYCLE", payload: { slug: "s", status: "filled", side: "UP", action: "buy", price: 0.5, shares: 1 } });
    bus.push({ ts: 3, type: "DECISION_FEATURE_SNAPSHOT", payload: { event: "filled" } as any });
    bus.push({ ts: 4, type: "SESSION_PNL", payload: { pnl: 0.4, loss: 0 } });

    await (manager as any)._finalizePaperEvidence("completed");

    expect(rows).toHaveLength(1);
    expect(rows[0].presetId).toBe("simulation");
    expect(rows[0].configHash).toBe("abc123");
    expect(rows[0].status).toBe("completed");
    expect(rows[0].fills).toBe(1);
    expect(rows[0].blocked).toBe(1);
    expect(rows[0].decisionSnapshots).toBe(1);
    expect(rows[0].pnl).toBe(0.4);
  });

  test("stopped sessions finalize as canceled evidence", async () => {
    const bus = new TelemetryBus();
    const manager = new SessionManager(bus);
    const rows: any[] = [];
    manager.setPaperEvidenceRecorder(row => rows.push(row));

    (manager as any)._startPaperEvidence(preset);
    await (manager as any)._finalizePaperEvidence("canceled");

    expect(rows[0].status).toBe("canceled");
  });
});
