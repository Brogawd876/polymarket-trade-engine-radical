import { readFileSync } from "fs";
import { createHash } from "crypto";
import type { CalibrationAuditCandidateResult, CalibrationAuditSummary } from "./calibration-audit.ts";
import type { CalibrationGlobalReadiness } from "./calibration-readiness-gate.ts";
import type { IsotonicBucket, IsotonicModel } from "./isotonic-calibration.ts";

export type CalibrationArtifactV1 = {
  schemaVersion: 1;
  variant: string;
  candidate: string;
  label: string;
  evidenceFilter: string;
  splitMode: "row" | "temporal";
  trainRatio: number;
  metrics: {
    train: CalibrationAuditCandidateResult["trainMetrics"];
    holdout: CalibrationAuditCandidateResult["holdoutMetrics"];
    trainSampleCount: number;
    holdoutSampleCount: number;
    positiveLabelRate: number | null;
  };
  buckets: IsotonicBucket[];
  corpusHash: string;
  createdAtMs: number;
  readinessDecision: "paper_candidate";
};

export function hashCalibrationCorpus(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function createCalibrationArtifactV1(params: {
  variant: string;
  audit: CalibrationAuditSummary;
  readiness: CalibrationGlobalReadiness;
  corpusHash: string;
  createdAtMs?: number;
}): CalibrationArtifactV1 | null {
  const readyCandidates = params.readiness.candidates.filter((candidate) => candidate.decision === "paper_candidate");
  if (params.readiness.globalDecision !== "paper_candidate" || readyCandidates.length === 0) return null;

  const readyKeys = new Set(
    readyCandidates.map((candidate) => [
      candidate.scoreField,
      candidate.labelField,
      candidate.splitMode,
      candidate.evidenceFilter,
    ].join("|")),
  );

  const audited = params.audit.segments.flatMap((segment) =>
    segment.auditedCandidates.map((candidate) => ({ segment, candidate })),
  ).filter(({ segment, candidate }) =>
    readyKeys.has([candidate.scoreField, candidate.labelField, segment.splitMode, segment.evidenceFilter].join("|"))
    && candidate.status === "ok"
    && candidate.classification === "pre_trade_candidate",
  );

  if (audited.length === 0) return null;

  audited.sort((a, b) => {
    const aBrier = a.candidate.holdoutMetrics.brierScore ?? Number.POSITIVE_INFINITY;
    const bBrier = b.candidate.holdoutMetrics.brierScore ?? Number.POSITIVE_INFINITY;
    if (aBrier !== bBrier) return aBrier - bBrier;
    return a.candidate.scoreField.localeCompare(b.candidate.scoreField);
  });

  const best = audited[0]!;
  return {
    schemaVersion: 1,
    variant: params.variant,
    candidate: best.candidate.scoreField,
    label: best.candidate.labelField,
    evidenceFilter: best.segment.evidenceFilter,
    splitMode: best.segment.splitMode,
    trainRatio: best.segment.summary.trainRatio,
    metrics: {
      train: best.candidate.trainMetrics,
      holdout: best.candidate.holdoutMetrics,
      trainSampleCount: best.candidate.trainSampleCount,
      holdoutSampleCount: best.candidate.holdoutSampleCount,
      positiveLabelRate: best.candidate.positiveLabelRate,
    },
    buckets: best.candidate.buckets,
    corpusHash: params.corpusHash,
    createdAtMs: params.createdAtMs ?? Date.now(),
    readinessDecision: "paper_candidate",
  };
}

export function assertCalibrationArtifactV1(value: unknown, expectedVariant?: string): CalibrationArtifactV1 {
  const artifact = value as Partial<CalibrationArtifactV1> | null;
  if (!artifact || artifact.schemaVersion !== 1) {
    throw new Error("Calibration artifact must have schemaVersion=1.");
  }
  if (expectedVariant && artifact.variant !== expectedVariant) {
    throw new Error(`Calibration artifact variant mismatch: expected ${expectedVariant}, got ${artifact.variant ?? "missing"}.`);
  }
  if (artifact.readinessDecision !== "paper_candidate") {
    throw new Error("Calibration artifact is not approved as paper_candidate.");
  }
  if (!Array.isArray(artifact.buckets) || artifact.buckets.length === 0) {
    throw new Error("Calibration artifact has no isotonic buckets.");
  }
  if (artifact.splitMode !== "temporal") {
    throw new Error(`Calibration artifact splitMode must be temporal, got ${artifact.splitMode ?? "missing"}.`);
  }
  if (artifact.evidenceFilter !== "trade-print-backed") {
    throw new Error(`Calibration artifact evidenceFilter must be trade-print-backed, got ${artifact.evidenceFilter ?? "missing"}.`);
  }
  return artifact as CalibrationArtifactV1;
}

export function loadCalibrationModelFromArtifact(path: string, expectedVariant?: string): IsotonicModel {
  if (!path) {
    throw new Error("Calibration artifact path is required for calibrated strategy variants.");
  }
  const artifact = assertCalibrationArtifactV1(JSON.parse(readFileSync(path, "utf-8")), expectedVariant);
  const positiveCount = artifact.buckets.reduce((sum, bucket) => sum + bucket.positiveCount, 0);
  const sampleCount = artifact.buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  return {
    buckets: artifact.buckets,
    sampleCount,
    positiveLabelRate: sampleCount > 0 ? positiveCount / sampleCount : 0,
  };
}
