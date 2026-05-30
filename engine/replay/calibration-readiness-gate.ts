import type { CalibrationAuditSummary, CalibrationAuditCandidateResult, CalibrationAuditSegment } from "./calibration-audit.ts";

export type CalibrationReadinessDecision = "blocked" | "research_only" | "paper_candidate";

export type CalibrationReadinessGateConfig = {
  minTotalRecords: number;
  minTradePrintBackedRecords: number;
  minTrainSamples: number;
  minHoldoutSamples: number;
  minTemporalMarketsTrain: number;
  minTemporalMarketsHoldout: number;
  maxPositiveLabelRate: number;
  minPositiveLabelRate: number;
  maxHoldoutBrier: number;
  maxHoldoutLogLoss: number;
  maxHoldoutEce: number;
  maxTrainHoldoutBrierDelta: number;
  requireTemporalSplit: boolean;
  requireTradePrintBackedSegment: boolean;
  rejectDiagnosticOnlyFeatures: boolean;
  rejectSameSlugLeakage: boolean;
  rejectInsufficientData: boolean;
};

export const DEFAULT_CALIBRATION_READINESS_CONFIG: CalibrationReadinessGateConfig = {
  minTotalRecords: 5000,
  minTradePrintBackedRecords: 2000,
  minTrainSamples: 500,
  minHoldoutSamples: 200,
  minTemporalMarketsTrain: 20,
  minTemporalMarketsHoldout: 10,
  maxPositiveLabelRate: 0.90,
  minPositiveLabelRate: 0.10,
  maxHoldoutBrier: 0.20,
  maxHoldoutLogLoss: 0.65,
  maxHoldoutEce: 0.08,
  maxTrainHoldoutBrierDelta: 0.05,
  requireTemporalSplit: true,
  requireTradePrintBackedSegment: true,
  rejectDiagnosticOnlyFeatures: true,
  rejectSameSlugLeakage: true,
  rejectInsufficientData: true,
};

export type CalibrationCandidateReadiness = {
  scoreField: string;
  labelField: string;
  splitMode: string;
  evidenceFilter: string;
  decision: CalibrationReadinessDecision;
  failures: string[];
};

export type CalibrationGlobalReadiness = {
  globalDecision: CalibrationReadinessDecision;
  globalFailures: string[];
  candidates: CalibrationCandidateReadiness[];
};

export function evaluateCalibrationReadiness(
  auditSummary: CalibrationAuditSummary,
  config: CalibrationReadinessGateConfig = DEFAULT_CALIBRATION_READINESS_CONFIG
): CalibrationGlobalReadiness {
  const globalFailures: string[] = [];

  if (auditSummary.totalRecords < config.minTotalRecords) {
    globalFailures.push(`Total records (${auditSummary.totalRecords}) is below required minimum (${config.minTotalRecords}).`);
  }

  let tradePrintBackedCount = 0;
  for (const seg of auditSummary.segments) {
    if (seg.splitMode === "temporal" && seg.evidenceFilter === "trade-print-backed") {
      tradePrintBackedCount = seg.summary.totalRecords;
      break;
    }
  }
  
  if (tradePrintBackedCount < config.minTradePrintBackedRecords) {
    globalFailures.push(`Trade-print-backed records (${tradePrintBackedCount}) is below required minimum (${config.minTradePrintBackedRecords}).`);
  }

  const candidateResults: CalibrationCandidateReadiness[] = [];

  for (const seg of auditSummary.segments) {
    for (const cand of seg.auditedCandidates) {
      const failures: string[] = [];
      let isResearchOnly = false;

      if (config.requireTemporalSplit && seg.splitMode !== "temporal") {
        failures.push(`Split mode is ${seg.splitMode}, but temporal split is required.`);
      }

      if (config.requireTradePrintBackedSegment && seg.evidenceFilter !== "trade-print-backed") {
        failures.push(`Evidence filter is ${seg.evidenceFilter}, but trade-print-backed is required.`);
      }

      if (config.rejectDiagnosticOnlyFeatures && (cand.classification === "diagnostic_only" || cand.classification === "invalid_for_live_decision")) {
        failures.push(`Candidate is classified as ${cand.classification}.`);
      } else if (cand.classification === "diagnostic_only") {
        isResearchOnly = true;
      }

      if (config.rejectInsufficientData && cand.status === "insufficient_data") {
        failures.push(`Candidate evaluation status is insufficient_data.`);
      }

      if (cand.status === "ok") {
        if (cand.trainSampleCount < config.minTrainSamples) {
          failures.push(`Train sample count (${cand.trainSampleCount}) is below required minimum (${config.minTrainSamples}).`);
        }
        if (cand.holdoutSampleCount < config.minHoldoutSamples) {
          failures.push(`Holdout sample count (${cand.holdoutSampleCount}) is below required minimum (${config.minHoldoutSamples}).`);
        }
        
        if (cand.positiveLabelRate === null) {
          failures.push(`Positive label rate is missing.`);
        } else if (cand.positiveLabelRate < config.minPositiveLabelRate || cand.positiveLabelRate > config.maxPositiveLabelRate) {
          failures.push(`Positive label rate (${(cand.positiveLabelRate * 100).toFixed(1)}%) is outside allowed bounds [${config.minPositiveLabelRate}, ${config.maxPositiveLabelRate}].`);
        }

        if (cand.holdoutMetrics.brierScore === null || cand.holdoutMetrics.logLoss === null || cand.holdoutMetrics.expectedCalibrationError === null) {
          failures.push(`Holdout metrics are missing.`);
        } else {
          if (cand.holdoutMetrics.brierScore > config.maxHoldoutBrier) {
            failures.push(`Holdout Brier score (${cand.holdoutMetrics.brierScore.toFixed(4)}) exceeds maximum allowed (${config.maxHoldoutBrier}).`);
          }
          if (cand.holdoutMetrics.logLoss > config.maxHoldoutLogLoss) {
            failures.push(`Holdout Log Loss (${cand.holdoutMetrics.logLoss.toFixed(4)}) exceeds maximum allowed (${config.maxHoldoutLogLoss}).`);
          }
          if (cand.holdoutMetrics.expectedCalibrationError > config.maxHoldoutEce) {
            failures.push(`Holdout ECE (${cand.holdoutMetrics.expectedCalibrationError.toFixed(4)}) exceeds maximum allowed (${config.maxHoldoutEce}).`);
          }
        }

        if (cand.trainMetrics.brierScore !== null && cand.holdoutMetrics.brierScore !== null) {
          const delta = cand.holdoutMetrics.brierScore - cand.trainMetrics.brierScore;
          if (delta > config.maxTrainHoldoutBrierDelta) {
            failures.push(`Train/Holdout Brier score degradation (${delta.toFixed(4)}) exceeds maximum allowed (${config.maxTrainHoldoutBrierDelta}).`);
          }
        }

        if (cand.bucketStability?.trainBucketCount === 1) {
          failures.push(`All predictions collapsed into a single train bucket.`);
        }

        if (cand.holdoutMetrics.expectedCalibrationError === 0 && cand.holdoutSampleCount < 50) {
          failures.push(`Suspiciously perfect ECE on small holdout sample.`);
        }

        if (cand.auditWarnings.some(w => w.includes("Temporal leakage"))) {
          if (config.rejectSameSlugLeakage) {
            failures.push(`Temporal leakage warning exists.`);
          }
        }
      }

      let decision: CalibrationReadinessDecision = "blocked";
      if (failures.length === 0 && globalFailures.length === 0) {
        decision = "paper_candidate";
      } else if (isResearchOnly || (cand.classification !== "invalid_for_live_decision" && failures.length <= 2 && globalFailures.length === 0)) {
        // If it's blocked by a couple of thresholds, maybe it's research only.
        // But for strictness, any failure blocks it, unless we just want to flag it research_only manually.
        // Let's just say if it has failures but isn't strictly invalid, it's blocked but could be research_only if it's diagnostic.
        decision = cand.classification === "diagnostic_only" ? "research_only" : "blocked";
      }

      candidateResults.push({
        scoreField: cand.scoreField,
        labelField: cand.labelField,
        splitMode: seg.splitMode,
        evidenceFilter: seg.evidenceFilter,
        decision,
        failures
      });
    }
  }

  let globalDecision: CalibrationReadinessDecision = "blocked";
  if (candidateResults.some(c => c.decision === "paper_candidate")) {
    globalDecision = "paper_candidate";
  } else if (candidateResults.some(c => c.decision === "research_only")) {
    globalDecision = "research_only";
  }

  return {
    globalDecision,
    globalFailures,
    candidates: candidateResults
  };
}
