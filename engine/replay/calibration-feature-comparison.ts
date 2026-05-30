import type { CalibrationRecord } from "./calibration-extractor.ts";
import { evaluateCalibration, getRecordField, type CalibrationExtractionSummary, type CalibrationMetrics } from "./calibration-metrics.ts";
import { fitIsotonicRegression, predictIsotonicProbability, type IsotonicBucket, type IsotonicModel, type LabeledScore } from "./isotonic-calibration.ts";

export type CalibrationLabelName =
  | "adverseSelection"
  | "profitableMarkout1s"
  | "profitableMarkout5s"
  | "profitableMarkout30s"
  | "adverseMarkout1s"
  | "adverseMarkout5s"
  | "adverseMarkout30s";

export type CalibrationCandidate = {
  scoreField: string;
  labelField: CalibrationLabelName;
};

export type HoldoutBucketStability = {
  trainBucketCount: number;
  populatedHoldoutBuckets: number;
  emptyHoldoutBuckets: number;
  weightedAbsRateDelta: number | null;
  maxAbsRateDelta: number | null;
  buckets: Array<{
    lowerScore: number;
    upperScore: number;
    trainCount: number;
    trainRate: number;
    holdoutCount: number;
    holdoutPositiveRate: number | null;
    absRateDelta: number | null;
  }>;
};

export type CalibrationFeatureComparisonResult = {
  status: "ok" | "insufficient_data";
  scoreField: string;
  labelField: CalibrationLabelName;
  totalRecords: number;
  trainSampleCount: number;
  holdoutSampleCount: number;
  positiveLabelRate: number | null;
  trainPositiveLabelRate: number | null;
  holdoutPositiveLabelRate: number | null;
  extraction: CalibrationExtractionSummary;
  trainMetrics: CalibrationMetrics;
  holdoutMetrics: CalibrationMetrics;
  buckets: IsotonicBucket[];
  bucketStability: HoldoutBucketStability | null;
  featureWarning?: string;
  reason?: string;
};

export type CalibrationFeatureComparisonSummary = {
  status: "ok" | "insufficient_data";
  splitMode: "row" | "temporal";
  evidenceFilter?: string;
  trainRatio: number;
  temporalCutoffMs?: number;
  minTrainSamples: number;
  minHoldoutSamples: number;
  totalRecords: number;
  candidates: CalibrationFeatureComparisonResult[];
};

type LabeledRecord = LabeledScore & {
  sortKey: string;
  slug: string;
  tsMs: number;
};

function parseNumeric(value: unknown): { value?: number; missing: boolean; invalid: boolean } {
  if (value === null || value === undefined) return { missing: true, invalid: false };
  if (typeof value !== "number" || !Number.isFinite(value)) return { missing: false, invalid: true };
  return { value, missing: false, invalid: false };
}

function labelFromMarkout(value: unknown, direction: "profitable" | "adverse"): { label?: 0 | 1; missing: boolean; invalid: boolean } {
  const parsed = parseNumeric(value);
  if (parsed.value === undefined) return parsed;
  if (direction === "profitable") return { label: parsed.value > 0 ? 1 : 0, missing: false, invalid: false };
  return { label: parsed.value < 0 ? 1 : 0, missing: false, invalid: false };
}

function getLabel(record: CalibrationRecord, labelField: CalibrationLabelName): { label?: 0 | 1; missing: boolean; invalid: boolean } {
  if (labelField === "adverseSelection") {
    const value = record.adverseSelection;
    if (value === null || value === undefined) return { missing: true, invalid: false };
    if (typeof value !== "boolean") return { missing: false, invalid: true };
    return { label: value ? 1 : 0, missing: false, invalid: false };
  }

  if (labelField === "profitableMarkout1s") return labelFromMarkout(record.markout1s, "profitable");
  if (labelField === "profitableMarkout5s") return labelFromMarkout(record.markout5s, "profitable");
  if (labelField === "profitableMarkout30s") return labelFromMarkout(record.markout30s, "profitable");
  if (labelField === "adverseMarkout1s") return labelFromMarkout(record.markout1s, "adverse");
  if (labelField === "adverseMarkout5s") return labelFromMarkout(record.markout5s, "adverse");
  return labelFromMarkout(record.markout30s, "adverse");
}

function recordSortKey(record: CalibrationRecord, score: number, label: 0 | 1): string {
  return [
    record.slug,
    record.fillTsMs ?? record.quoteTsMs ?? record.decisionTsMs ?? 0,
    record.strategy,
    record.variantName ?? "",
    record.tokenId ?? "",
    score,
    label,
  ].join("|");
}

export function extractCandidateSamples(
  records: readonly CalibrationRecord[],
  candidate: CalibrationCandidate,
): { samples: LabeledRecord[]; extraction: CalibrationExtractionSummary } {
  const samples: LabeledRecord[] = [];
  const extraction: CalibrationExtractionSummary = {
    totalRecords: records.length,
    validRecords: 0,
    missingScoreCount: 0,
    missingLabelCount: 0,
    invalidScoreCount: 0,
    invalidLabelCount: 0,
  };

  for (const record of records) {
    const score = parseNumeric(getRecordField(record, candidate.scoreField));
    const label = getLabel(record, candidate.labelField);

    if (score.missing) extraction.missingScoreCount++;
    if (score.invalid) extraction.invalidScoreCount++;
    if (label.missing) extraction.missingLabelCount++;
    if (label.invalid) extraction.invalidLabelCount++;
    if (score.value === undefined || label.label === undefined) continue;

    samples.push({
      score: score.value,
      label: label.label,
      sortKey: recordSortKey(record, score.value, label.label),
      slug: record.slug,
      tsMs: record.fillTsMs ?? record.quoteTsMs ?? record.decisionTsMs ?? 0,
    });
    extraction.validRecords++;
  }

  samples.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  return { samples, extraction };
}

function positiveRate(samples: readonly LabeledScore[]): number | null {
  if (samples.length === 0) return null;
  return samples.reduce((sum, sample) => sum + sample.label, 0) / samples.length;
}

function splitTrainHoldout(
  samples: readonly LabeledRecord[],
  opts: { splitMode?: "row" | "temporal"; trainRatio: number; temporalCutoffMs?: number },
): { train: LabeledScore[]; holdout: LabeledScore[] } {
  if (opts.splitMode === "temporal") {
    const slugMinTs = new Map<string, number>();
    const slugSamples = new Map<string, LabeledRecord[]>();
    for (const sample of samples) {
      const minTs = slugMinTs.get(sample.slug);
      if (minTs === undefined || sample.tsMs < minTs) {
        slugMinTs.set(sample.slug, sample.tsMs);
      }
      let arr = slugSamples.get(sample.slug);
      if (!arr) {
        arr = [];
        slugSamples.set(sample.slug, arr);
      }
      arr.push(sample);
    }
    
    const sortedSlugs = Array.from(slugMinTs.keys()).sort((a, b) => slugMinTs.get(a)! - slugMinTs.get(b)!);
    
    const train: LabeledScore[] = [];
    const holdout: LabeledScore[] = [];
    
    if (opts.temporalCutoffMs) {
      for (const slug of sortedSlugs) {
        const arr = slugSamples.get(slug)!;
        if (slugMinTs.get(slug)! <= opts.temporalCutoffMs) {
          train.push(...arr.map(({ score, label }) => ({ score, label })));
        } else {
          holdout.push(...arr.map(({ score, label }) => ({ score, label })));
        }
      }
    } else {
      let trainCount = 0;
      const targetTrainCount = Math.min(samples.length, Math.max(0, Math.floor(samples.length * opts.trainRatio)));
      for (const slug of sortedSlugs) {
        const arr = slugSamples.get(slug)!;
        if (trainCount < targetTrainCount || trainCount === 0) {
          train.push(...arr.map(({ score, label }) => ({ score, label })));
          trainCount += arr.length;
        } else {
          holdout.push(...arr.map(({ score, label }) => ({ score, label })));
        }
      }
    }
    return { train, holdout };
  } else {
    const trainCount = Math.min(samples.length, Math.max(0, Math.floor(samples.length * opts.trainRatio)));
    return {
      train: samples.slice(0, trainCount).map(({ score, label }) => ({ score, label })),
      holdout: samples.slice(trainCount).map(({ score, label }) => ({ score, label })),
    };
  }
}

function featureWarning(candidate: CalibrationCandidate): string | undefined {
  if (candidate.scoreField.startsWith("markout")) {
    const horizon = candidate.scoreField.replace("markout", "Markout");
    if (candidate.labelField.endsWith(horizon)) {
      return "post_outcome_leakage_same_markout_horizon";
    }
    return "post_outcome_feature_not_pre_trade";
  }
  return undefined;
}

function bucketForScore(model: IsotonicModel, score: number): IsotonicBucket | null {
  if (model.buckets.length === 0) return null;
  const first = model.buckets[0]!;
  if (score <= first.upperScore) return first;
  const last = model.buckets[model.buckets.length - 1]!;
  if (score >= last.lowerScore) return last;
  for (const bucket of model.buckets) {
    if (score >= bucket.lowerScore && score <= bucket.upperScore) return bucket;
  }
  for (let i = 1; i < model.buckets.length; i++) {
    const left = model.buckets[i - 1]!;
    const right = model.buckets[i]!;
    if (score > left.upperScore && score < right.lowerScore) return left;
  }
  return last;
}

export function evaluateBucketStability(model: IsotonicModel, holdout: readonly LabeledScore[]): HoldoutBucketStability {
  const holdoutByBucket = new Map<IsotonicBucket, { count: number; positiveCount: number }>();
  for (const sample of holdout) {
    const bucket = bucketForScore(model, sample.score);
    if (!bucket) continue;
    const stats = holdoutByBucket.get(bucket) ?? { count: 0, positiveCount: 0 };
    stats.count++;
    stats.positiveCount += sample.label;
    holdoutByBucket.set(bucket, stats);
  }

  let populatedHoldoutBuckets = 0;
  let weightedDelta = 0;
  let maxAbsRateDelta: number | null = null;

  const buckets = model.buckets.map((bucket) => {
    const stats = holdoutByBucket.get(bucket);
    const holdoutPositiveRate = stats && stats.count > 0 ? stats.positiveCount / stats.count : null;
    const absRateDelta = holdoutPositiveRate === null ? null : Math.abs(holdoutPositiveRate - bucket.calibratedRate);
    if (stats && stats.count > 0 && absRateDelta !== null) {
      populatedHoldoutBuckets++;
      weightedDelta += (stats.count / holdout.length) * absRateDelta;
      maxAbsRateDelta = maxAbsRateDelta === null ? absRateDelta : Math.max(maxAbsRateDelta, absRateDelta);
    }
    return {
      lowerScore: bucket.lowerScore,
      upperScore: bucket.upperScore,
      trainCount: bucket.count,
      trainRate: bucket.calibratedRate,
      holdoutCount: stats?.count ?? 0,
      holdoutPositiveRate,
      absRateDelta,
    };
  });

  return {
    trainBucketCount: model.buckets.length,
    populatedHoldoutBuckets,
    emptyHoldoutBuckets: model.buckets.length - populatedHoldoutBuckets,
    weightedAbsRateDelta: holdout.length > 0 ? weightedDelta : null,
    maxAbsRateDelta,
    buckets,
  };
}

export function compareCalibrationFeatures(
  records: readonly CalibrationRecord[],
  candidates: readonly CalibrationCandidate[],
  opts: {
    splitMode?: "row" | "temporal";
    evidenceFilter?: string;
    trainRatio: number;
    temporalCutoffMs?: number;
    minTrainSamples: number;
    minHoldoutSamples: number;
  },
): CalibrationFeatureComparisonSummary {
  const results = candidates.map((candidate): CalibrationFeatureComparisonResult => {
    const { samples, extraction } = extractCandidateSamples(records, candidate);
    const { train, holdout } = splitTrainHoldout(samples, opts);
    const positiveLabelRate = positiveRate(samples);
    const trainPositiveLabelRate = positiveRate(train);
    const holdoutPositiveLabelRate = positiveRate(holdout);

    if (train.length < opts.minTrainSamples || holdout.length < opts.minHoldoutSamples) {
      const reason = `train/holdout samples ${train.length}/${holdout.length} below required ${opts.minTrainSamples}/${opts.minHoldoutSamples}`;
      return {
        status: "insufficient_data",
        scoreField: candidate.scoreField,
        labelField: candidate.labelField,
        totalRecords: records.length,
        trainSampleCount: train.length,
        holdoutSampleCount: holdout.length,
        positiveLabelRate,
        trainPositiveLabelRate,
        holdoutPositiveLabelRate,
        extraction,
        trainMetrics: { brierScore: null, logLoss: null, expectedCalibrationError: null },
        holdoutMetrics: { brierScore: null, logLoss: null, expectedCalibrationError: null },
        buckets: [],
        bucketStability: null,
        featureWarning: featureWarning(candidate),
        reason,
      };
    }

    const model = fitIsotonicRegression(train);
    return {
      status: "ok",
      scoreField: candidate.scoreField,
      labelField: candidate.labelField,
      totalRecords: records.length,
      trainSampleCount: train.length,
      holdoutSampleCount: holdout.length,
      positiveLabelRate,
      trainPositiveLabelRate,
      holdoutPositiveLabelRate,
      extraction,
      trainMetrics: evaluateCalibration(train, model),
      holdoutMetrics: evaluateCalibration(holdout, model),
      buckets: model.buckets,
      bucketStability: evaluateBucketStability(model, holdout),
      featureWarning: featureWarning(candidate),
    };
  });

  return {
    status: results.some((result) => result.status === "ok") ? "ok" : "insufficient_data",
    splitMode: opts.splitMode ?? "row",
    evidenceFilter: opts.evidenceFilter,
    trainRatio: opts.trainRatio,
    temporalCutoffMs: opts.temporalCutoffMs,
    minTrainSamples: opts.minTrainSamples,
    minHoldoutSamples: opts.minHoldoutSamples,
    totalRecords: records.length,
    candidates: results,
  };
}

export function filterRecordsByEvidence(
  records: readonly CalibrationRecord[],
  evidenceFilter: "all" | "trade-print-backed" | "touch-only" | "missing-decision-feature-excluded" | string,
): CalibrationRecord[] {
  if (evidenceFilter === "trade-print-backed") {
    return records.filter((r) => r.dataQuality.hasMarketTradeEvidence);
  } else if (evidenceFilter === "touch-only") {
    return records.filter((r) => !r.dataQuality.hasMarketTradeEvidence);
  } else if (evidenceFilter === "missing-decision-feature-excluded") {
    return records.filter((r) => !r.dataQuality.missingReasons.includes("missing_decision_feature"));
  }
  return records.slice();
}

export function predictWithModel(model: IsotonicModel, score: number): number | null {
  return predictIsotonicProbability(model, score);
}
