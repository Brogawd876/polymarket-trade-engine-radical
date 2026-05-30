import { describe, expect, test } from "bun:test";
import {
  fitIsotonicRegression,
  predictIsotonicProbability,
} from "../../engine/replay/isotonic-calibration.ts";

describe("isotonic calibration", () => {
  test("pool-adjacent-violators produces monotonic calibrated rates", () => {
    const model = fitIsotonicRegression([
      { score: 0.1, label: 1 },
      { score: 0.2, label: 0 },
      { score: 0.3, label: 0 },
      { score: 0.4, label: 1 },
      { score: 0.5, label: 1 },
    ]);

    for (let i = 1; i < model.buckets.length; i++) {
      expect(model.buckets[i]!.calibratedRate).toBeGreaterThanOrEqual(model.buckets[i - 1]!.calibratedRate);
    }
    expect(model.sampleCount).toBe(5);
    expect(model.positiveLabelRate).toBe(3 / 5);
  });

  test("duplicate scores are aggregated into one bucket before pooling", () => {
    const model = fitIsotonicRegression([
      { score: 0.2, label: 0 },
      { score: 0.2, label: 1 },
      { score: 0.4, label: 1 },
      { score: 0.4, label: 1 },
    ]);

    expect(model.buckets).toHaveLength(2);
    expect(model.buckets[0]).toMatchObject({
      lowerScore: 0.2,
      upperScore: 0.2,
      count: 2,
      positiveCount: 1,
      calibratedRate: 0.5,
    });
    expect(predictIsotonicProbability(model, 0.2)).toBe(0.5);
  });

  test("predictions clamp outside the fitted score range", () => {
    const model = fitIsotonicRegression([
      { score: 10, label: 0 },
      { score: 20, label: 1 },
    ]);

    expect(predictIsotonicProbability(model, 0)).toBe(0);
    expect(predictIsotonicProbability(model, 30)).toBe(1);
  });

  test("empty model returns null predictions", () => {
    const model = fitIsotonicRegression([]);
    expect(model.buckets).toHaveLength(0);
    expect(predictIsotonicProbability(model, 1)).toBeNull();
  });
});
