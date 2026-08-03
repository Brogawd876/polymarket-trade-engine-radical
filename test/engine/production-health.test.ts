import { describe, expect, test } from "bun:test";
import {
  buildBlockedHealthReport,
  validateHealthReport,
} from "../../engine/production/health.ts";

describe("production health contract", () => {
  test("reports every dependency separately and never equates liveness with readiness", () => {
    const report = buildBlockedHealthReport({
      checkedAtMs: 42,
      engineRunning: true,
      evidenceHealthy: true,
      completionProven: false,
    });
    expect(report.controlPlane).toBe("HEALTHY");
    expect(report.tradingReadiness).toBe("BLOCKED");
    expect(report.dependencies.engine.status).toBe("HEALTHY");
    expect(report.dependencies.eventJournal.status).toBe("UNKNOWN");
    expect(report.dependencies.reconciliation.status).toBe("UNKNOWN");
    expect(validateHealthReport(report)).toEqual(report);
  });

  test("rejects a false READY report", () => {
    const report = buildBlockedHealthReport({
      engineRunning: false,
      evidenceHealthy: false,
      completionProven: false,
    });
    report.tradingReadiness = "READY";
    expect(() => validateHealthReport(report)).toThrow(
      "trading cannot be READY",
    );
  });
});
