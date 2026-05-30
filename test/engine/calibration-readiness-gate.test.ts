import { test, expect } from "bun:test";
import { evaluateCalibrationReadiness, DEFAULT_CALIBRATION_READINESS_CONFIG } from "../../engine/replay/calibration-readiness-gate.ts";
import type { CalibrationAuditSummary, CalibrationAuditCandidateResult } from "../../engine/replay/calibration-audit.ts";

function createMockSummary(candidateModifiers: Partial<CalibrationAuditCandidateResult> = {}): CalibrationAuditSummary {
  return {
    totalRecords: 10000,
    segments: [
      {
        splitMode: "temporal",
        evidenceFilter: "trade-print-backed",
        summary: {
          status: "ok",
          splitMode: "temporal",
          evidenceFilter: "trade-print-backed",
          trainRatio: 0.7,
          minTrainSamples: 500,
          minHoldoutSamples: 200,
          totalRecords: 3000,
          candidates: []
        },
        auditedCandidates: [
          {
            status: "ok",
            scoreField: "fairValue",
            labelField: "adverseMarkout30s",
            totalRecords: 3000,
            trainSampleCount: 1000,
            holdoutSampleCount: 500,
            positiveLabelRate: 0.5,
            trainPositiveLabelRate: 0.5,
            holdoutPositiveLabelRate: 0.5,
            extraction: { totalRecords: 3000, validRecords: 3000, missingScoreCount: 0, missingLabelCount: 0, invalidScoreCount: 0, invalidLabelCount: 0 },
            trainMetrics: { brierScore: 0.15, logLoss: 0.45, expectedCalibrationError: 0.02 },
            holdoutMetrics: { brierScore: 0.16, logLoss: 0.48, expectedCalibrationError: 0.03 },
            buckets: [],
            bucketStability: { trainBucketCount: 5, populatedHoldoutBuckets: 5, emptyHoldoutBuckets: 0, weightedAbsRateDelta: 0.01, maxAbsRateDelta: 0.02, buckets: [] },
            classification: "pre_trade_candidate",
            auditWarnings: [],
            ...candidateModifiers
          }
        ]
      }
    ]
  };
}

test("Calibration Readiness Gate > valid synthetic candidate becomes paper_candidate", () => {
  const summary = createMockSummary();
  const readiness = evaluateCalibrationReadiness(summary, DEFAULT_CALIBRATION_READINESS_CONFIG);
  expect(readiness.globalDecision).toBe("paper_candidate");
  expect(readiness.candidates[0].decision).toBe("paper_candidate");
});

test("Calibration Readiness Gate > insufficient sample size blocks", () => {
  const summary = createMockSummary({ holdoutSampleCount: 10 });
  const readiness = evaluateCalibrationReadiness(summary, DEFAULT_CALIBRATION_READINESS_CONFIG);
  expect(readiness.globalDecision).toBe("blocked");
  expect(readiness.candidates[0].decision).toBe("blocked");
  expect(readiness.candidates[0].failures.some(f => f.includes("Holdout sample count"))).toBe(true);
});

test("Calibration Readiness Gate > diagnostic-only feature blocks", () => {
  const summary = createMockSummary({ classification: "diagnostic_only" });
  const readiness = evaluateCalibrationReadiness(summary, DEFAULT_CALIBRATION_READINESS_CONFIG);
  expect(readiness.globalDecision).toBe("research_only");
  expect(readiness.candidates[0].decision).toBe("research_only");
  expect(readiness.candidates[0].failures.some(f => f.includes("diagnostic_only"))).toBe(true);
});

test("Calibration Readiness Gate > non-temporal split blocks when temporal is required", () => {
  const summary = createMockSummary();
  summary.segments[0].splitMode = "row";
  const readiness = evaluateCalibrationReadiness(summary, DEFAULT_CALIBRATION_READINESS_CONFIG);
  expect(readiness.globalDecision).toBe("blocked");
  expect(readiness.candidates[0].failures.some(f => f.includes("temporal split is required"))).toBe(true);
});

test("Calibration Readiness Gate > non-trade-print-backed segment blocks when required", () => {
  const summary = createMockSummary();
  summary.segments[0].evidenceFilter = "all";
  // We also need to add a trade-print-backed segment to pass the global minimum
  summary.segments.push({
    splitMode: "temporal",
    evidenceFilter: "trade-print-backed",
    summary: { status: "insufficient_data", splitMode: "temporal", evidenceFilter: "trade-print-backed", trainRatio: 0.7, minTrainSamples: 500, minHoldoutSamples: 200, totalRecords: 3000, candidates: [] },
    auditedCandidates: []
  });

  const readiness = evaluateCalibrationReadiness(summary, DEFAULT_CALIBRATION_READINESS_CONFIG);
  expect(readiness.candidates[0].decision).toBe("blocked");
  expect(readiness.candidates[0].failures.some(f => f.includes("trade-print-backed is required"))).toBe(true);
});

test("Calibration Readiness Gate > extreme class imbalance blocks", () => {
  const summary = createMockSummary({ positiveLabelRate: 0.99 });
  const readiness = evaluateCalibrationReadiness(summary, DEFAULT_CALIBRATION_READINESS_CONFIG);
  expect(readiness.globalDecision).toBe("blocked");
  expect(readiness.candidates[0].failures.some(f => f.includes("Positive label rate"))).toBe(true);
});

test("Calibration Readiness Gate > missing metrics block", () => {
  const summary = createMockSummary({ holdoutMetrics: { brierScore: null, logLoss: null, expectedCalibrationError: null } });
  const readiness = evaluateCalibrationReadiness(summary, DEFAULT_CALIBRATION_READINESS_CONFIG);
  expect(readiness.globalDecision).toBe("blocked");
  expect(readiness.candidates[0].failures.some(f => f.includes("metrics are missing"))).toBe(true);
});

test("Calibration Readiness Gate > high Brier blocks", () => {
  const summary = createMockSummary({ holdoutMetrics: { brierScore: 0.50, logLoss: 0.48, expectedCalibrationError: 0.03 } });
  const readiness = evaluateCalibrationReadiness(summary, DEFAULT_CALIBRATION_READINESS_CONFIG);
  expect(readiness.globalDecision).toBe("blocked");
  expect(readiness.candidates[0].failures.some(f => f.includes("Brier score"))).toBe(true);
});

test("Calibration Readiness Gate > large train/holdout degradation blocks", () => {
  const summary = createMockSummary({ 
    trainMetrics: { brierScore: 0.10, logLoss: 0.30, expectedCalibrationError: 0.01 },
    holdoutMetrics: { brierScore: 0.18, logLoss: 0.40, expectedCalibrationError: 0.02 }
  }); // Delta is 0.08, which > 0.05
  const readiness = evaluateCalibrationReadiness(summary, DEFAULT_CALIBRATION_READINESS_CONFIG);
  expect(readiness.globalDecision).toBe("blocked");
  expect(readiness.candidates[0].failures.some(f => f.includes("degradation"))).toBe(true);
});

test("Calibration Readiness Gate > does not mutate input object", () => {
  const summary = createMockSummary();
  const jsonBefore = JSON.stringify(summary);
  evaluateCalibrationReadiness(summary, DEFAULT_CALIBRATION_READINESS_CONFIG);
  const jsonAfter = JSON.stringify(summary);
  expect(jsonBefore).toBe(jsonAfter);
});
