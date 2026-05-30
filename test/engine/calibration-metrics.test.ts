import { describe, expect, test } from "bun:test";
import type { CalibrationRecord } from "../../engine/replay/calibration-extractor.ts";
import {
  extractLabeledScores,
  runOfflineIsotonicCalibration,
} from "../../engine/replay/calibration-metrics.ts";

function record(overrides: Partial<CalibrationRecord>): CalibrationRecord {
  return {
    schemaVersion: 1,
    pairManifestPath: "data/pairs/test.pair.json",
    slug: "test",
    strategy: "fair-value-maker",
    fillPrice: 0.5,
    markout5s: null,
    adverseSelection: false,
    calibratedProbability: null,
    dataQuality: {
      hasMarketTradeEvidence: true,
      hasBookEvidence: true,
      hasMarkout1s: false,
      hasMarkout5s: false,
      hasMarkout30s: false,
      missingReasons: [],
    },
    ...overrides,
  };
}

describe("offline calibration metrics", () => {
  test("drops missing/null score and label rows with explicit counts", () => {
    const records = [
      record({ fillPrice: 0.1, adverseSelection: false }),
      record({ fillPrice: null, adverseSelection: true }),
      record({ fillPrice: 0.3, adverseSelection: null }),
      record({ fillPrice: Number.NaN, adverseSelection: false }),
    ];

    const { samples, extraction } = extractLabeledScores(records, "fillPrice", "adverseSelection");
    expect(samples).toEqual([{ score: 0.1, label: 0 }]);
    expect(extraction).toMatchObject({
      totalRecords: 4,
      validRecords: 1,
      missingScoreCount: 1,
      invalidScoreCount: 1,
      missingLabelCount: 1,
      invalidLabelCount: 0,
    });
  });

  test("reports insufficient data without forcing a model", () => {
    const summary = runOfflineIsotonicCalibration([
      record({ fillPrice: 0.1, adverseSelection: false }),
      record({ fillPrice: 0.2, adverseSelection: true }),
    ], {
      scoreField: "fillPrice",
      labelField: "adverseSelection",
      minSamples: 3,
    });

    expect(summary.status).toBe("insufficient_data");
    expect(summary.sampleCount).toBe(2);
    expect(summary.buckets).toHaveLength(0);
    expect(summary.metrics.brierScore).toBeNull();
    expect(summary.reason).toContain("below min-samples");
  });

  test("fits model and returns metrics when enough data exists", () => {
    const summary = runOfflineIsotonicCalibration([
      record({ fillPrice: 0.1, adverseSelection: false }),
      record({ fillPrice: 0.2, adverseSelection: false }),
      record({ fillPrice: 0.8, adverseSelection: true }),
      record({ fillPrice: 0.9, adverseSelection: true }),
    ], {
      scoreField: "fillPrice",
      labelField: "adverseSelection",
      minSamples: 4,
    });

    expect(summary.status).toBe("ok");
    expect(summary.sampleCount).toBe(4);
    expect(summary.positiveLabelRate).toBe(0.5);
    expect(summary.buckets.length).toBeGreaterThan(0);
    expect(summary.metrics.brierScore).not.toBeNull();
    expect(summary.metrics.logLoss).not.toBeNull();
    expect(summary.metrics.expectedCalibrationError).not.toBeNull();
  });

  test("extracting calibration samples does not mutate input records", () => {
    const records = [
      record({ fillPrice: 0.1, adverseSelection: false }),
      record({ fillPrice: 0.9, adverseSelection: true }),
    ];
    const before = JSON.stringify(records);

    runOfflineIsotonicCalibration(records, {
      scoreField: "fillPrice",
      labelField: "adverseSelection",
      minSamples: 1,
    });

    expect(JSON.stringify(records)).toBe(before);
  });
});
