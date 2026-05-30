import {
  compareCalibrationFeatures,
  filterRecordsByEvidence,
  type CalibrationFeatureComparisonSummary,
  type CalibrationFeatureComparisonResult,
  type CalibrationCandidate
} from "./calibration-feature-comparison.ts";
import type { CalibrationRecord } from "./calibration-extractor.ts";

export type CalibrationAuditClassification = 
  | "pre_trade_candidate"
  | "diagnostic_only"
  | "invalid_for_live_decision"
  | "insufficient_data";

export type CalibrationAuditCandidateResult = CalibrationFeatureComparisonResult & {
  classification: CalibrationAuditClassification;
  classificationReason?: string;
  auditWarnings: string[];
};

export type CalibrationAuditSegment = {
  splitMode: "row" | "temporal";
  evidenceFilter: string;
  summary: CalibrationFeatureComparisonSummary;
  auditedCandidates: CalibrationAuditCandidateResult[];
};

export type CalibrationAuditSummary = {
  totalRecords: number;
  segments: CalibrationAuditSegment[];
};

export function classifyCandidate(
  result: CalibrationFeatureComparisonResult
): { classification: CalibrationAuditClassification; reason?: string } {
  if (result.status === "insufficient_data") {
    return { classification: "insufficient_data", reason: "Insufficient sample size." };
  }

  const field = result.scoreField.toLowerCase();
  
  if (
    field.includes("markout") ||
    field.includes("pnl") ||
    field.includes("adverse") ||
    field.includes("verdict") ||
    field.includes("settlement")
  ) {
    return { classification: "diagnostic_only", reason: "Field relies on post-trade or post-outcome information." };
  }

  const preTradeFields = [
    "modelprobability", "rawprobability", "fairvalue", "marketimpliedprobability",
    "quotededge", "fairvalueedge", "predictedprobability", "bestbid", "bestask", "mid",
    "spread", "topofbookliquidity", "volatilityestimate", "predictivedisagreement",
    "predictivedivergence", "resolutiondistance", "distancetoopenanchor", "timetoclosems",
    "quotedprice", "fillprice"
  ];

  if (preTradeFields.includes(field)) {
    return { classification: "pre_trade_candidate" };
  }

  return { classification: "diagnostic_only", reason: "Unrecognized field, conservatively marked diagnostic-only." };
}

export function runCalibrationAudit(
  records: readonly CalibrationRecord[],
  candidates: readonly CalibrationCandidate[],
  opts: {
    trainRatio: number;
    minTrainSamples: number;
    minHoldoutSamples: number;
    temporalCutoffMs?: number;
  }
): CalibrationAuditSummary {
  const segments: CalibrationAuditSegment[] = [];
  const splitModes: Array<"row" | "temporal"> = ["row", "temporal"];
  const evidenceFilters = ["all", "trade-print-backed", "touch-only", "missing-decision-feature-excluded"];

  for (const splitMode of splitModes) {
    for (const evidenceFilter of evidenceFilters) {
      const filteredRecords = filterRecordsByEvidence(records, evidenceFilter);
      
      const summary = compareCalibrationFeatures(filteredRecords, candidates, {
        splitMode,
        evidenceFilter,
        trainRatio: opts.trainRatio,
        temporalCutoffMs: opts.temporalCutoffMs,
        minTrainSamples: opts.minTrainSamples,
        minHoldoutSamples: opts.minHoldoutSamples,
      });

      const auditedCandidates = summary.candidates.map(candidateResult => {
        const { classification, reason } = classifyCandidate(candidateResult);
        const auditWarnings: string[] = [];

        if (candidateResult.status === "ok") {
          if (candidateResult.trainSampleCount < opts.minTrainSamples) {
            auditWarnings.push(`Train sample count (${candidateResult.trainSampleCount}) is very low.`);
          }
          if (candidateResult.holdoutSampleCount < opts.minHoldoutSamples) {
            auditWarnings.push(`Holdout sample count (${candidateResult.holdoutSampleCount}) is very low.`);
          }
          if (candidateResult.positiveLabelRate !== null && (candidateResult.positiveLabelRate < 0.05 || candidateResult.positiveLabelRate > 0.95)) {
            auditWarnings.push(`Extreme class imbalance: positive label rate is ${(candidateResult.positiveLabelRate * 100).toFixed(1)}%.`);
          }
          if (candidateResult.bucketStability?.trainBucketCount === 1) {
            auditWarnings.push(`All predictions collapsed into a single train bucket.`);
          }
          if (candidateResult.holdoutMetrics.expectedCalibrationError === 0 && candidateResult.holdoutSampleCount < 50) {
            auditWarnings.push(`Suspiciously perfect ECE on small holdout sample.`);
          }
        }

        return {
          ...candidateResult,
          classification,
          classificationReason: reason,
          auditWarnings
        };
      });

      segments.push({
        splitMode,
        evidenceFilter,
        summary,
        auditedCandidates
      });
    }
  }

  return {
    totalRecords: records.length,
    segments
  };
}
