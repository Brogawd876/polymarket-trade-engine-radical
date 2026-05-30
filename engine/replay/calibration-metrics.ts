import type { CalibrationRecord } from "./calibration-extractor.ts";
import {
  fitIsotonicRegression,
  predictIsotonicProbability,
  type IsotonicBucket,
  type IsotonicModel,
  type LabeledScore,
} from "./isotonic-calibration.ts";

export type CalibrationExtractionSummary = {
  totalRecords: number;
  validRecords: number;
  missingScoreCount: number;
  missingLabelCount: number;
  invalidScoreCount: number;
  invalidLabelCount: number;
};

export type CalibrationMetrics = {
  brierScore: number | null;
  logLoss: number | null;
  expectedCalibrationError: number | null;
};

export type OfflineCalibrationSummary = {
  status: "ok" | "insufficient_data";
  scoreField: string;
  labelField: string;
  minSamples: number;
  sampleCount: number;
  positiveLabelRate: number | null;
  extraction: CalibrationExtractionSummary;
  metrics: CalibrationMetrics;
  buckets: IsotonicBucket[];
  reason?: string;
};

export function getRecordField(record: CalibrationRecord, field: string): unknown {
  const parts = field.split(".").filter(Boolean);
  let value: unknown = record;
  for (const part of parts) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function parseScore(value: unknown): { score?: number; missing: boolean; invalid: boolean } {
  if (value === null || value === undefined) return { missing: true, invalid: false };
  if (typeof value !== "number" || !Number.isFinite(value)) return { missing: false, invalid: true };
  return { score: value, missing: false, invalid: false };
}

function parseLabel(value: unknown): { label?: 0 | 1; missing: boolean; invalid: boolean } {
  if (value === null || value === undefined) return { missing: true, invalid: false };
  if (typeof value === "boolean") return { label: value ? 1 : 0, missing: false, invalid: false };
  if (value === 0 || value === 1) return { label: value, missing: false, invalid: false };
  return { missing: false, invalid: true };
}

export function extractLabeledScores(
  records: readonly CalibrationRecord[],
  scoreField: string,
  labelField: string,
): { samples: LabeledScore[]; extraction: CalibrationExtractionSummary } {
  const samples: LabeledScore[] = [];
  const extraction: CalibrationExtractionSummary = {
    totalRecords: records.length,
    validRecords: 0,
    missingScoreCount: 0,
    missingLabelCount: 0,
    invalidScoreCount: 0,
    invalidLabelCount: 0,
  };

  for (const record of records) {
    const score = parseScore(getRecordField(record, scoreField));
    const label = parseLabel(getRecordField(record, labelField));

    if (score.missing) extraction.missingScoreCount++;
    if (score.invalid) extraction.invalidScoreCount++;
    if (label.missing) extraction.missingLabelCount++;
    if (label.invalid) extraction.invalidLabelCount++;

    if (score.score === undefined || label.label === undefined) continue;
    samples.push({ score: score.score, label: label.label });
    extraction.validRecords++;
  }

  return { samples, extraction };
}

function clipProbability(value: number): number {
  return Math.min(1 - 1e-15, Math.max(1e-15, value));
}

export function evaluateCalibration(samples: readonly LabeledScore[], model: IsotonicModel): CalibrationMetrics {
  if (samples.length === 0) {
    return { brierScore: null, logLoss: null, expectedCalibrationError: null };
  }

  let brierSum = 0;
  let logLossSum = 0;
  const bucketStats = new Map<number, { count: number; positiveCount: number; confidenceSum: number }>();

  for (const sample of samples) {
    const predicted = predictIsotonicProbability(model, sample.score);
    if (predicted === null) continue;
    const clipped = clipProbability(predicted);
    brierSum += (clipped - sample.label) ** 2;
    logLossSum += sample.label === 1 ? -Math.log(clipped) : -Math.log(1 - clipped);

    const key = Math.min(9, Math.floor(clipped * 10));
    const stats = bucketStats.get(key) ?? { count: 0, positiveCount: 0, confidenceSum: 0 };
    stats.count++;
    stats.positiveCount += sample.label;
    stats.confidenceSum += clipped;
    bucketStats.set(key, stats);
  }

  let ece = 0;
  for (const stats of bucketStats.values()) {
    const accuracy = stats.positiveCount / stats.count;
    const confidence = stats.confidenceSum / stats.count;
    ece += (stats.count / samples.length) * Math.abs(accuracy - confidence);
  }

  return {
    brierScore: brierSum / samples.length,
    logLoss: logLossSum / samples.length,
    expectedCalibrationError: ece,
  };
}

export function runOfflineIsotonicCalibration(
  records: readonly CalibrationRecord[],
  opts: { scoreField: string; labelField: string; minSamples: number },
): OfflineCalibrationSummary {
  const { samples, extraction } = extractLabeledScores(records, opts.scoreField, opts.labelField);
  if (samples.length < opts.minSamples) {
    return {
      status: "insufficient_data",
      scoreField: opts.scoreField,
      labelField: opts.labelField,
      minSamples: opts.minSamples,
      sampleCount: samples.length,
      positiveLabelRate: samples.length > 0
        ? samples.reduce((sum, sample) => sum + sample.label, 0) / samples.length
        : null,
      extraction,
      metrics: { brierScore: null, logLoss: null, expectedCalibrationError: null },
      buckets: [],
      reason: `valid sample count ${samples.length} is below min-samples ${opts.minSamples}`,
    };
  }

  const model = fitIsotonicRegression(samples);
  return {
    status: "ok",
    scoreField: opts.scoreField,
    labelField: opts.labelField,
    minSamples: opts.minSamples,
    sampleCount: samples.length,
    positiveLabelRate: model.positiveLabelRate,
    extraction,
    metrics: evaluateCalibration(samples, model),
    buckets: model.buckets,
  };
}
