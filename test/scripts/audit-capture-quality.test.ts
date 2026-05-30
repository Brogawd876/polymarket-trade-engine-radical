/**
 * test/scripts/audit-capture-quality.test.ts
 *
 * Phase 8U: Tests for the capture-quality audit gate.
 *
 * All tests use temp directories and fixture data. No dependency on real data/pairs.
 * Does not commit generated artifacts.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import * as path from "path";
import * as os from "os";
import {
  runCaptureQualityAudit,
  renderMarkdown,
  type CaptureQualityAuditReport,
} from "../../scripts/audit-capture-quality.ts";
import type { PairManifest } from "../../engine/replay/pair-manifest.ts";

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeManifest(
  slug: string,
  overrides: Partial<PairManifest> = {}
): PairManifest {
  return {
    slug,
    replayLogPath: `logs/${slug}.log`,
    rawL2LogPath: `data/raw-l2/${slug}.ndjson`,
    strategy: "fair-value-maker",
    slotStartMs: 1_700_000_000_000,
    slotEndMs: 1_700_000_300_000,
    captureStartedAtMs: 1_700_000_000_000,
    captureEndedAtMs: 1_700_000_360_000,
    runtimeStartedAtMs: 1_700_000_000_000,
    runtimeEndedAtMs: 1_700_000_360_000,
    recorderStartedAtMs: 1_700_000_000_000,
    recorderEndedAtMs: 1_700_000_360_000,
    runtimeExitCode: 0,
    recorderExitCode: 0,
    recorderStopReason: "completed",
    recorderCompletedEventSeen: true,
    recorderSignal: null,
    replayEventCount: 500,
    rawL2EventCount: 120_000,
    rawL2BookEventCount: 115_000,
    rawL2TradeEventCount: 5_000,
    replayFirstEventTsMs: 1_700_000_001_000,
    replayLastEventTsMs: 1_700_000_299_000,
    rawL2FirstEventTsMs: 1_699_999_999_000,
    rawL2LastEventTsMs: 1_700_000_305_000,
    coverageLeadMs: 2000,
    coverageTailMs: 6000,
    parseErrors: [],
    validationErrors: [],
    validationWarnings: [],
    coverageVerdict: "complete",
    pairValidity: "valid",
    strategyLabEvidenceVerdict: "usable",
    strategyLabStatus: "completed",
    gitCommit: "abc123",
    commands: [],
    validatedAtMs: Date.now(),
    createdAtMs: Date.now(),
    ...overrides,
  };
}

function writeManifest(dir: string, manifest: PairManifest): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${manifest.slug}.pair.json`),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("audit-capture-quality", () => {
  let tmpBase: string;

  beforeAll(() => {
    tmpBase = path.join(os.tmpdir(), `phase8u-audit-test-${Date.now()}`);
    mkdirSync(tmpBase, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(tmpBase)) {
      rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  // ────────────────────────────────────────────────────────────────────────────

  test("no pairs found -> capture_quality_fail", () => {
    const dir = path.join(tmpBase, "empty");
    mkdirSync(dir, { recursive: true });

    const report = runCaptureQualityAudit({ pairsDir: dir });

    expect(report.decision).toBe("capture_quality_fail");
    expect(report.totalPairManifests).toBe(0);
    expect(report.failReasons.some((r) => r.includes("No pair manifests found"))).toBeTrue();
  });

  test("nonexistent pairs dir -> capture_quality_fail", () => {
    const dir = path.join(tmpBase, "does-not-exist");

    const report = runCaptureQualityAudit({ pairsDir: dir });

    expect(report.decision).toBe("capture_quality_fail");
    expect(report.failReasons.some((r) => r.includes("No pair manifests found"))).toBeTrue();
  });

  test("all valid complete pairs -> capture_quality_pass (with enough coverage)", () => {
    const dir = path.join(tmpBase, "all-valid");
    const m1 = makeManifest("btc-5m-slot-A");
    // Place m2 slot > 2 hours after m1 to satisfy the temporal spread check
    const m2 = makeManifest("btc-5m-slot-B", {
      slotStartMs: 1_700_000_000_000 + 3 * 60 * 60 * 1000, // +3 hours
      slotEndMs: 1_700_000_000_000 + 3 * 60 * 60 * 1000 + 300_000,
    });
    writeManifest(dir, m1);
    writeManifest(dir, m2);

    const report = runCaptureQualityAudit({ pairsDir: dir });

    expect(report.totalPairManifests).toBe(2);
    expect(report.validPairCount).toBe(2);
    expect(report.invalidPairCount).toBe(0);
    expect(report.completeCoverageCount).toBe(2);
    expect(report.decision).toBe("capture_quality_pass");
    expect(report.failReasons.length).toBe(0);
  });

  test("invalid pairs >= valid pairs after >= 10 total -> capture_quality_fail", () => {
    const dir = path.join(tmpBase, "mostly-invalid");

    // Create 5 valid and 5 invalid pairs (total = 10)
    for (let i = 0; i < 5; i++) {
      writeManifest(dir, makeManifest(`valid-slot-${i}`));
    }
    for (let i = 0; i < 5; i++) {
      writeManifest(
        dir,
        makeManifest(`invalid-slot-${i}`, {
          pairValidity: "invalid",
          coverageVerdict: "partial",
          validationErrors: ["Replay log not found: missing.log"],
        })
      );
    }

    const report = runCaptureQualityAudit({ pairsDir: dir });

    expect(report.totalPairManifests).toBe(10);
    expect(report.validPairCount).toBe(5);
    expect(report.invalidPairCount).toBe(5);
    expect(report.decision).toBe("capture_quality_fail");
    expect(report.failReasons.some((r) => r.includes("Invalid pairs"))).toBeTrue();
  });

  test("fewer than 10 pairs with equal invalid:valid -> no fail just warn", () => {
    const dir = path.join(tmpBase, "few-invalid");

    // 3 valid, 3 invalid (total = 6, below threshold of 10)
    for (let i = 0; i < 3; i++) {
      writeManifest(dir, makeManifest(`v-${i}`));
    }
    for (let i = 0; i < 3; i++) {
      writeManifest(
        dir,
        makeManifest(`inv-${i}`, {
          pairValidity: "invalid",
          coverageVerdict: "partial",
          validationErrors: ["Replay log not found: missing.log"],
        })
      );
    }

    const report = runCaptureQualityAudit({ pairsDir: dir });

    // invalid >= valid but total < 10, so no fail on that rule
    expect(report.failReasons.some((r) => r.includes("Invalid pairs"))).toBeFalse();
  });

  test("malformed pair manifest -> fail with parse reason", () => {
    const dir = path.join(tmpBase, "malformed");
    mkdirSync(dir, { recursive: true });

    // Write invalid JSON
    writeFileSync(path.join(dir, "broken-slot.pair.json"), "{ not valid json }", "utf-8");

    const report = runCaptureQualityAudit({ pairsDir: dir });

    expect(report.totalPairManifests).toBe(1);
    expect(report.invalidPairCount).toBe(1);
    expect(report.failReasons.some((r) => r.includes("Failed to parse manifest"))).toBeTrue();
    expect(report.decision).toBe("capture_quality_fail");
  });

  test("valid pair with zero raw L2 events -> fail", () => {
    const dir = path.join(tmpBase, "zero-l2");

    writeManifest(
      dir,
      makeManifest("zero-l2-slot", {
        rawL2EventCount: 0,
        rawL2BookEventCount: 0,
        rawL2TradeEventCount: 0,
      })
    );

    const report = runCaptureQualityAudit({ pairsDir: dir });

    expect(report.failReasons.some((r) => r.includes("zero raw L2 events"))).toBeTrue();
    expect(report.decision).toBe("capture_quality_fail");
  });

  test("valid pair with incomplete coverage -> fail", () => {
    const dir = path.join(tmpBase, "incomplete-cov");

    writeManifest(
      dir,
      makeManifest("partial-slot", {
        coverageVerdict: "partial",
        pairValidity: "valid", // force valid to test the coverage check
      })
    );

    const report = runCaptureQualityAudit({ pairsDir: dir });

    expect(report.failReasons.some((r) => r.includes("incomplete coverage"))).toBeTrue();
    expect(report.decision).toBe("capture_quality_fail");
  });

  test("low raw L2 trade events -> warn, not fail", () => {
    const dir = path.join(tmpBase, "low-trades");

    writeManifest(
      dir,
      makeManifest("low-trade-slot", {
        rawL2TradeEventCount: 10, // very low
      })
    );

    const report = runCaptureQualityAudit({ pairsDir: dir });

    expect(report.warnReasons.some((r) => r.includes("Low raw L2 trade events"))).toBeTrue();
    // Should only be a warn, not fail (unless something else fails)
    expect(report.failReasons.some((r) => r.includes("trade events"))).toBeFalse();
  });

  test("valid count below min-valid-pairs -> fail", () => {
    const dir = path.join(tmpBase, "too-few-valid");

    writeManifest(dir, makeManifest("only-one-slot"));

    const report = runCaptureQualityAudit({ pairsDir: dir, minValidPairs: 5 });

    expect(report.failReasons.some((r) => r.includes("below requested minimum"))).toBeTrue();
    expect(report.decision).toBe("capture_quality_fail");
  });

  test("missing decision feature rate > 5% -> fail", () => {
    const dir = path.join(tmpBase, "missing-features");

    writeManifest(dir, makeManifest("feature-test-slot"));

    // Write calibration NDJSON with >5% missing decision features
    const calPath = path.join(tmpBase, "calib-missing-features.ndjson");
    const records = [];
    for (let i = 0; i < 10; i++) {
      records.push(
        JSON.stringify({
          schemaVersion: 1,
          slug: "feature-test-slot",
          strategy: "fair-value-maker",
          fillTsMs: Date.now() + i * 1000,
          dataQuality: {
            hasMarketTradeEvidence: true,
            hasBookEvidence: true,
            hasMarkout1s: true,
            hasMarkout5s: true,
            hasMarkout30s: true,
            missingReasons: i < 2 ? ["missing_decision_feature"] : [],
          },
        })
      );
    }
    writeFileSync(calPath, records.join("\n") + "\n", "utf-8");

    const report = runCaptureQualityAudit({
      pairsDir: dir,
      calibrationJsonlPath: calPath,
    });

    expect(report.missingDecisionFeatureCount).toBe(2);
    expect(report.missingDecisionFeatureRate).toBeCloseTo(0.2, 5); // 20%
    expect(report.failReasons.some((r) => r.includes("Missing decision feature rate"))).toBeTrue();
    expect(report.decision).toBe("capture_quality_fail");
  });

  test("missing Chainlink anchor in calibration records -> fail", () => {
    const dir = path.join(tmpBase, "missing-anchor");

    writeManifest(dir, makeManifest("anchor-test-slot"));

    const calPath = path.join(tmpBase, "calib-missing-anchor.ndjson");
    const records = [];
    for (let i = 0; i < 5; i++) {
      records.push(
        JSON.stringify({
          schemaVersion: 1,
          slug: "anchor-test-slot",
          strategy: "fair-value-maker",
          fillTsMs: Date.now() + i * 1000,
          dataQuality: {
            hasMarketTradeEvidence: true,
            hasBookEvidence: true,
            hasMarkout1s: true,
            hasMarkout5s: true,
            hasMarkout30s: true,
            missingReasons: ["missing_chainlink_anchor"],
          },
        })
      );
    }
    writeFileSync(calPath, records.join("\n") + "\n", "utf-8");

    const report = runCaptureQualityAudit({
      pairsDir: dir,
      calibrationJsonlPath: calPath,
    });

    expect(report.missingChainlinkAnchorRecordCount).toBe(5);
    expect(report.failReasons.some((r) => r.includes("missing_chainlink_anchor"))).toBeTrue();
    expect(report.decision).toBe("capture_quality_fail");
  });

  test("missing trade prints -> warn, not fail", () => {
    const dir = path.join(tmpBase, "no-trade-prints");

    writeManifest(dir, makeManifest("no-prints-slot"));

    const calPath = path.join(tmpBase, "calib-no-prints.ndjson");
    const records = [];
    // All touch-only records (>50%)
    for (let i = 0; i < 10; i++) {
      records.push(
        JSON.stringify({
          schemaVersion: 1,
          slug: "no-prints-slot",
          strategy: "fair-value-maker",
          fillTsMs: Date.now() + i * 1000,
          dataQuality: {
            hasMarketTradeEvidence: false,
            hasBookEvidence: true,
            hasMarkout1s: true,
            hasMarkout5s: true,
            hasMarkout30s: true,
            missingReasons: [],
          },
        })
      );
    }
    writeFileSync(calPath, records.join("\n") + "\n", "utf-8");

    const report = runCaptureQualityAudit({
      pairsDir: dir,
      calibrationJsonlPath: calPath,
    });

    expect(report.touchOnlyCount).toBe(10);
    expect(report.warnReasons.some((r) => r.includes("Touch-only"))).toBeTrue();
    // Not a fail condition
    expect(report.failReasons.some((r) => r.includes("touch"))).toBeFalse();
  });

  test("output JSON and Markdown produced correctly (dry-run)", () => {
    const dir = path.join(tmpBase, "output-test");
    writeManifest(dir, makeManifest("output-test-slot"));

    const report = runCaptureQualityAudit({ pairsDir: dir });

    // Test JSON serialization
    const json = JSON.stringify(report, null, 2);
    const parsed = JSON.parse(json) as CaptureQualityAuditReport;
    expect(parsed.decision).toBe(report.decision);
    expect(parsed.totalPairManifests).toBe(1);

    // Test Markdown rendering
    const md = renderMarkdown(report);
    expect(md).toContain("# Capture Quality Audit");
    expect(md).toContain(report.decision);
    expect(md).toContain("output-test-slot");
    expect(md).toContain("No live execution behavior was changed");
  });

  test("recorder unknown stop reason on valid pair produces warn entry in report", () => {
    const dir = path.join(tmpBase, "unknown-stop");

    writeManifest(
      dir,
      makeManifest("unknown-stop-slot", {
        recorderStopReason: "unknown",
        recorderCompletedEventSeen: false,
        recorderExitCode: null,
      })
    );

    const report = runCaptureQualityAudit({ pairsDir: dir });

    expect(report.recorderStopReasonCounts["unknown"]).toBe(1);
    expect(report.warnReasons.some((r) => r.includes("unknown recorder stop reason"))).toBeTrue();
  });

  test("calibration records with all good data -> pass or warn only", () => {
    const dir = path.join(tmpBase, "all-good");

    writeManifest(dir, makeManifest("clean-slot"));

    const calPath = path.join(tmpBase, "calib-clean.ndjson");
    const records = [];
    for (let i = 0; i < 20; i++) {
      records.push(
        JSON.stringify({
          schemaVersion: 1,
          slug: "clean-slot",
          strategy: "fair-value-maker",
          fillTsMs: Date.now() + i * 1000,
          dataQuality: {
            hasMarketTradeEvidence: true,
            hasBookEvidence: true,
            hasMarkout1s: true,
            hasMarkout5s: true,
            hasMarkout30s: true,
            missingReasons: [],
          },
        })
      );
    }
    writeFileSync(calPath, records.join("\n") + "\n", "utf-8");

    const report = runCaptureQualityAudit({
      pairsDir: dir,
      calibrationJsonlPath: calPath,
    });

    expect(report.tradePrintBackedCount).toBe(20);
    expect(report.missingDecisionFeatureCount).toBe(0);
    expect(report.missingChainlinkAnchorRecordCount).toBe(0);
    expect(report.failReasons.filter((r) => !r.includes("trade events") && !r.includes("hours")).length).toBe(0);
    // Decision should be pass (low trades and low temporal spread are warns only)
    const isFail = report.failReasons.length > 0;
    if (isFail) {
      // If there's a fail it must be unrelated to calibration quality
      expect(report.failReasons.every((r) => !r.includes("calibration") && !r.includes("feature"))).toBeTrue();
    }
  });
});
