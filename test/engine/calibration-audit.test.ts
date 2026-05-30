import { test, expect } from "bun:test";
import { runCalibrationAudit, classifyCandidate } from "../../engine/replay/calibration-audit.ts";
import type { CalibrationRecord } from "../../engine/replay/calibration-extractor.ts";
import type { CalibrationCandidate, CalibrationFeatureComparisonResult } from "../../engine/replay/calibration-feature-comparison.ts";

function createMockRecord(ts: number, score: number, markout: number, slug: string, hasTrade: boolean): CalibrationRecord {
  return {
    schemaVersion: 1,
    pairManifestPath: "test",
    slug,
    strategy: "test",
    fillTsMs: ts,
    modelProbability: score,
    markout1s: markout,
    markout5s: markout,
    markout30s: markout,
    dataQuality: {
      hasMarketTradeEvidence: hasTrade,
      hasBookEvidence: true,
      hasMarkout1s: true,
      hasMarkout5s: true,
      hasMarkout30s: true,
      missingReasons: [],
    }
  } as CalibrationRecord;
}

test("Calibration Audit > classifies pre_trade_candidate correctly", () => {
  const result = { status: "ok", scoreField: "modelProbability", labelField: "adverseMarkout30s" } as CalibrationFeatureComparisonResult;
  const { classification } = classifyCandidate(result);
  expect(classification).toBe("pre_trade_candidate");
});

test("Calibration Audit > classifies markout as diagnostic_only", () => {
  const result = { status: "ok", scoreField: "markout1s", labelField: "adverseMarkout30s" } as CalibrationFeatureComparisonResult;
  const { classification, reason } = classifyCandidate(result);
  expect(classification).toBe("diagnostic_only");
  expect(reason).toContain("post-trade");
});

test("Calibration Audit > handles insufficient data correctly", () => {
  const result = { status: "insufficient_data", scoreField: "modelProbability" } as CalibrationFeatureComparisonResult;
  const { classification } = classifyCandidate(result);
  expect(classification).toBe("insufficient_data");
});

test("Calibration Audit > runs matrix for row and temporal splits", () => {
  const records = [
    createMockRecord(1000, 0.6, -100, "slug-1", true),
    createMockRecord(2000, 0.4, 100, "slug-1", false),
    createMockRecord(3000, 0.8, -50, "slug-2", true),
    createMockRecord(4000, 0.3, 50, "slug-2", false),
  ];
  const candidates: CalibrationCandidate[] = [
    { scoreField: "modelProbability", labelField: "adverseMarkout30s" }
  ];

  const summary = runCalibrationAudit(records, candidates, {
    trainRatio: 0.5,
    minTrainSamples: 1,
    minHoldoutSamples: 1,
  });

  expect(summary.totalRecords).toBe(4);
  expect(summary.segments.length).toBe(8); // 2 splits * 4 evidence filters
  
  const rowAll = summary.segments.find(s => s.splitMode === "row" && s.evidenceFilter === "all");
  expect(rowAll).toBeDefined();
  expect(rowAll?.auditedCandidates[0]?.status).toBe("ok");

  const temporalAll = summary.segments.find(s => s.splitMode === "temporal" && s.evidenceFilter === "all");
  expect(temporalAll).toBeDefined();
  
  const tpBacked = summary.segments.find(s => s.splitMode === "row" && s.evidenceFilter === "trade-print-backed");
  expect(tpBacked?.summary.totalRecords).toBe(2);
});

test("Calibration Audit > generates warnings for small sample size and extreme imbalance", () => {
  const records = [
    createMockRecord(1000, 0.6, -100, "slug-1", true), // label 1
    createMockRecord(2000, 0.6, -100, "slug-1", true), // label 1
    createMockRecord(3000, 0.6, -100, "slug-2", true), // label 1
    createMockRecord(4000, 0.6, -100, "slug-2", true), // label 1
  ];
  
  const summary = runCalibrationAudit(records, [{ scoreField: "modelProbability", labelField: "adverseMarkout30s" }], {
    trainRatio: 0.5,
    minTrainSamples: 2,
    minHoldoutSamples: 2,
  });

  const rowAll = summary.segments.find(s => s.splitMode === "row" && s.evidenceFilter === "all");
  const cand = rowAll?.auditedCandidates[0];
  expect(cand?.auditWarnings).toBeDefined();
  
  const hasExtremeImbalance = cand?.auditWarnings.some(w => w.includes("Extreme class imbalance"));
  expect(hasExtremeImbalance).toBe(true);

  const hasSingleBucket = cand?.auditWarnings.some(w => w.includes("single train bucket"));
  expect(hasSingleBucket).toBe(true);
});
