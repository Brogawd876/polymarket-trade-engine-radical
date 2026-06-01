import { describe, expect, test } from "bun:test";
import {
  assertCalibrationArtifactV1,
  createCalibrationArtifactV1,
  hashCalibrationCorpus,
} from "../../engine/replay/calibration-artifact.ts";
import type { CalibrationAuditSummary } from "../../engine/replay/calibration-audit.ts";
import type { CalibrationGlobalReadiness } from "../../engine/replay/calibration-readiness-gate.ts";

function auditSummary(): CalibrationAuditSummary {
  return {
    totalRecords: 10000,
    segments: [{
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
        candidates: [],
      },
      auditedCandidates: [{
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
        buckets: [{ lowerScore: 0.1, upperScore: 0.9, count: 1000, positiveCount: 500, empiricalRate: 0.5, calibratedRate: 0.5 }],
        bucketStability: { trainBucketCount: 1, populatedHoldoutBuckets: 1, emptyHoldoutBuckets: 0, weightedAbsRateDelta: 0.01, maxAbsRateDelta: 0.02, buckets: [] },
        classification: "pre_trade_candidate",
        auditWarnings: [],
      }],
    }],
  };
}

function readiness(decision: "paper_candidate" | "blocked" = "paper_candidate"): CalibrationGlobalReadiness {
  return {
    globalDecision: decision,
    globalFailures: [],
    candidates: [{
      scoreField: "fairValue",
      labelField: "adverseMarkout30s",
      splitMode: "temporal",
      evidenceFilter: "trade-print-backed",
      decision,
      failures: [],
    }],
  };
}

describe("CalibrationArtifactV1", () => {
  test("writes only paper-candidate calibration artifacts", () => {
    const blocked = createCalibrationArtifactV1({
      variant: "v",
      audit: auditSummary(),
      readiness: readiness("blocked"),
      corpusHash: hashCalibrationCorpus("records"),
      createdAtMs: 123,
    });
    expect(blocked).toBeNull();

    const artifact = createCalibrationArtifactV1({
      variant: "v",
      audit: auditSummary(),
      readiness: readiness(),
      corpusHash: hashCalibrationCorpus("records"),
      createdAtMs: 123,
    });
    expect(artifact?.schemaVersion).toBe(1);
    expect(artifact?.variant).toBe("v");
    expect(artifact?.candidate).toBe("fairValue");
    expect(artifact?.readinessDecision).toBe("paper_candidate");
  });

  test("fails closed on incompatible artifacts", () => {
    const artifact = createCalibrationArtifactV1({
      variant: "v",
      audit: auditSummary(),
      readiness: readiness(),
      corpusHash: hashCalibrationCorpus("records"),
      createdAtMs: 123,
    })!;

    expect(() => assertCalibrationArtifactV1(artifact, "v")).not.toThrow();
    expect(() => assertCalibrationArtifactV1({ ...artifact, evidenceFilter: "all" }, "v")).toThrow(/trade-print-backed/);
    expect(() => assertCalibrationArtifactV1(artifact, "other")).toThrow(/variant mismatch/);
  });
});
