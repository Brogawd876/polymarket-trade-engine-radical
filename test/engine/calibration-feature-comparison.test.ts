import { describe, expect, test } from "bun:test";
import type { CalibrationRecord } from "../../engine/replay/calibration-extractor.ts";
import {
  compareCalibrationFeatures,
  extractCandidateSamples,
  filterRecordsByEvidence,
} from "../../engine/replay/calibration-feature-comparison.ts";

function record(index: number, overrides: Partial<CalibrationRecord> = {}): CalibrationRecord {
  return {
    schemaVersion: 1,
    pairManifestPath: `data/pairs/slug-${index}.pair.json`,
    slug: `slug-${String(index).padStart(2, "0")}`,
    strategy: "fair-value-maker",
    variantName: "test",
    tokenId: `token-${index}`,
    side: index % 2 === 0 ? "UP" : "DOWN",
    fillTsMs: 1_000 + index,
    fillPrice: index / 10,
    spread: null,
    predictedProbability: null,
    calibratedProbability: null,
    markout1s: index % 2 === 0 ? 0.01 : -0.01,
    markout5s: index % 3 === 0 ? 0.02 : -0.02,
    markout30s: null,
    adverseSelection: index % 2 !== 0,
    dataQuality: {
      hasMarketTradeEvidence: true,
      hasBookEvidence: true,
      hasMarkout1s: true,
      hasMarkout5s: true,
      hasMarkout30s: false,
      missingReasons: [],
    },
    ...overrides,
  };
}

describe("calibration feature comparison", () => {
  test("extracts candidate samples with explicit missing counts", () => {
    const records = [
      record(1, { fillPrice: 0.1, adverseSelection: true }),
      record(2, { fillPrice: null, adverseSelection: false }),
      record(3, { fillPrice: Number.NaN, adverseSelection: true }),
      record(4, { fillPrice: 0.4, adverseSelection: null }),
    ];

    const { samples, extraction } = extractCandidateSamples(records, {
      scoreField: "fillPrice",
      labelField: "adverseSelection",
    });

    expect(samples).toHaveLength(1);
    expect(extraction).toMatchObject({
      totalRecords: 4,
      validRecords: 1,
      missingScoreCount: 1,
      invalidScoreCount: 1,
      missingLabelCount: 1,
    });
  });

  test("uses explicit deterministic train and holdout split", () => {
    const records = Array.from({ length: 10 }, (_, index) => record(index));
    const summary = compareCalibrationFeatures(records, [{
      scoreField: "fillPrice",
      labelField: "adverseSelection",
    }], {
      trainRatio: 0.6,
      minTrainSamples: 1,
      minHoldoutSamples: 1,
    });

    const result = summary.candidates[0]!;
    expect(result.status).toBe("ok");
    expect(result.trainSampleCount).toBe(6);
    expect(result.holdoutSampleCount).toBe(4);
    expect(result.holdoutMetrics.brierScore).not.toBeNull();
    expect(result.bucketStability?.trainBucketCount).toBe(result.buckets.length);
  });

  test("reports insufficient data instead of fitting", () => {
    const summary = compareCalibrationFeatures([record(1), record(2)], [{
      scoreField: "fillPrice",
      labelField: "adverseSelection",
    }], {
      trainRatio: 0.5,
      minTrainSamples: 2,
      minHoldoutSamples: 2,
    });

    const result = summary.candidates[0]!;
    expect(summary.status).toBe("insufficient_data");
    expect(result.status).toBe("insufficient_data");
    expect(result.buckets).toHaveLength(0);
    expect(result.reason).toContain("below required");
  });

  test("supports markout-derived labels without mutating records", () => {
    const records = Array.from({ length: 8 }, (_, index) => record(index));
    const before = JSON.stringify(records);

    const summary = compareCalibrationFeatures(records, [{
      scoreField: "fillPrice",
      labelField: "profitableMarkout5s",
    }], {
      trainRatio: 0.5,
      minTrainSamples: 1,
      minHoldoutSamples: 1,
    });

    expect(summary.candidates[0]!.positiveLabelRate).toBe(3 / 8);
    expect(summary.candidates[0]!.featureWarning).toBeUndefined();
    expect(JSON.stringify(records)).toBe(before);
  });

  test("flags post-outcome markout feature leakage", () => {
    const records = Array.from({ length: 8 }, (_, index) => record(index));
    const summary = compareCalibrationFeatures(records, [{
      scoreField: "markout5s",
      labelField: "profitableMarkout5s",
    }], {
      trainRatio: 0.5,
      minTrainSamples: 1,
      minHoldoutSamples: 1,
    });

    expect(summary.candidates[0]!.featureWarning).toBe("post_outcome_leakage_same_markout_horizon");
  });

  test("missing markout labels are counted honestly", () => {
    const records = [record(1, { markout30s: null }), record(2, { markout30s: null })];
    const summary = compareCalibrationFeatures(records, [{
      scoreField: "fillPrice",
      labelField: "profitableMarkout30s",
    }], {
      trainRatio: 0.5,
      minTrainSamples: 1,
      minHoldoutSamples: 1,
    });

    const result = summary.candidates[0]!;
    expect(result.extraction.validRecords).toBe(0);
    expect(result.extraction.missingLabelCount).toBe(2);
    expect(result.status).toBe("insufficient_data");
  });

  test("temporal split ordering by trainRatio", () => {
    const records = [
      record(1, { slug: "slug-03", fillTsMs: 300 }),
      record(2, { slug: "slug-01", fillTsMs: 100 }),
      record(3, { slug: "slug-02", fillTsMs: 200 }),
      record(4, { slug: "slug-03", fillTsMs: 305 }),
    ];
    const summary = compareCalibrationFeatures(records, [{
      scoreField: "fillPrice",
      labelField: "adverseSelection",
    }], {
      splitMode: "temporal",
      trainRatio: 0.5,
      minTrainSamples: 1,
      minHoldoutSamples: 1,
    });
    expect(summary.candidates[0]!.trainSampleCount).toBe(2);
    expect(summary.candidates[0]!.holdoutSampleCount).toBe(2);
  });

  test("temporal split ordering by temporalCutoffMs", () => {
    const records = [
      record(1, { slug: "slug-03", fillTsMs: 300 }),
      record(2, { slug: "slug-01", fillTsMs: 100 }),
      record(3, { slug: "slug-02", fillTsMs: 200 }),
      record(4, { slug: "slug-03", fillTsMs: 305 }),
    ];
    const summary = compareCalibrationFeatures(records, [{
      scoreField: "fillPrice",
      labelField: "adverseSelection",
    }], {
      splitMode: "temporal",
      temporalCutoffMs: 250,
      trainRatio: 0.5,
      minTrainSamples: 1,
      minHoldoutSamples: 1,
    });
    expect(summary.candidates[0]!.trainSampleCount).toBe(2);
    expect(summary.candidates[0]!.holdoutSampleCount).toBe(2);
  });

  test("no leakage between train and holdout for the same pair", () => {
    const records = Array.from({ length: 10 }, (_, index) => record(index, { slug: "same-slug" }));
    const summary = compareCalibrationFeatures(records, [{
      scoreField: "fillPrice",
      labelField: "adverseSelection",
    }], {
      splitMode: "temporal",
      trainRatio: 0.5,
      minTrainSamples: 1,
      minHoldoutSamples: 1,
    });
    expect(summary.candidates[0]!.trainSampleCount).toBe(10);
    expect(summary.candidates[0]!.holdoutSampleCount).toBe(0);
    expect(summary.status).toBe("insufficient_data");
  });

  test("missing score/label accounting with temporal split", () => {
    const records = [
      record(1, { slug: "s1", fillPrice: null, adverseSelection: true, fillTsMs: 100 }),
      record(2, { slug: "s2", fillPrice: 0.5, adverseSelection: null, fillTsMs: 200 }),
      record(3, { slug: "s3", fillPrice: 0.6, adverseSelection: true, fillTsMs: 300 }),
      record(4, { slug: "s4", fillPrice: 0.7, adverseSelection: false, fillTsMs: 400 }),
    ];
    const summary = compareCalibrationFeatures(records, [{
      scoreField: "fillPrice",
      labelField: "adverseSelection",
    }], {
      splitMode: "temporal",
      trainRatio: 0.5,
      minTrainSamples: 1,
      minHoldoutSamples: 1,
    });
    
    const result = summary.candidates[0]!;
    expect(result.extraction.missingScoreCount).toBe(1);
    expect(result.extraction.missingLabelCount).toBe(1);
    expect(result.extraction.validRecords).toBe(2);
    expect(result.trainSampleCount).toBe(1);
    expect(result.holdoutSampleCount).toBe(1);
  });

  test("evidence filtering works correctly", () => {
    const records = [
      record(1, { dataQuality: { hasMarketTradeEvidence: true, hasBookEvidence: true, hasMarkout1s: true, hasMarkout5s: true, hasMarkout30s: true, missingReasons: [] } }),
      record(2, { dataQuality: { hasMarketTradeEvidence: false, hasBookEvidence: true, hasMarkout1s: true, hasMarkout5s: true, hasMarkout30s: true, missingReasons: [] } }),
      record(3, { dataQuality: { hasMarketTradeEvidence: true, hasBookEvidence: true, hasMarkout1s: true, hasMarkout5s: true, hasMarkout30s: true, missingReasons: ["missing_decision_feature"] } }),
    ];

    expect(filterRecordsByEvidence(records, "all")).toHaveLength(3);
    expect(filterRecordsByEvidence(records, "trade-print-backed")).toHaveLength(2);
    expect(filterRecordsByEvidence(records, "touch-only")).toHaveLength(1);
    expect(filterRecordsByEvidence(records, "missing-decision-feature-excluded")).toHaveLength(2);
  });
});
