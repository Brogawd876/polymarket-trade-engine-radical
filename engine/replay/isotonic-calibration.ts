export type IsotonicBucket = {
  lowerScore: number;
  upperScore: number;
  count: number;
  positiveCount: number;
  empiricalRate: number;
  calibratedRate: number;
};

export type IsotonicModel = {
  buckets: IsotonicBucket[];
  sampleCount: number;
  positiveLabelRate: number;
};

export type LabeledScore = {
  score: number;
  label: 0 | 1;
};

type MutableBucket = {
  lowerScore: number;
  upperScore: number;
  count: number;
  positiveCount: number;
};

function rate(bucket: MutableBucket): number {
  return bucket.positiveCount / bucket.count;
}

function assertFiniteScore(score: number): void {
  if (!Number.isFinite(score)) {
    throw new Error(`Isotonic calibration score must be finite, got ${score}`);
  }
}

export function fitIsotonicRegression(samples: LabeledScore[]): IsotonicModel {
  if (samples.length === 0) {
    return { buckets: [], sampleCount: 0, positiveLabelRate: 0 };
  }

  const sorted = samples.map((sample) => {
    assertFiniteScore(sample.score);
    if (sample.label !== 0 && sample.label !== 1) {
      throw new Error(`Isotonic calibration label must be 0 or 1, got ${sample.label}`);
    }
    return { ...sample };
  }).sort((a, b) => a.score - b.score);

  const byScore: MutableBucket[] = [];
  for (const sample of sorted) {
    const previous = byScore[byScore.length - 1];
    if (previous && previous.lowerScore === sample.score) {
      previous.count++;
      previous.positiveCount += sample.label;
    } else {
      byScore.push({
        lowerScore: sample.score,
        upperScore: sample.score,
        count: 1,
        positiveCount: sample.label,
      });
    }
  }

  const buckets: MutableBucket[] = [];
  for (const bucket of byScore) {
    buckets.push({ ...bucket });
    while (buckets.length >= 2) {
      const right = buckets[buckets.length - 1]!;
      const left = buckets[buckets.length - 2]!;
      if (rate(left) <= rate(right)) break;

      buckets.splice(buckets.length - 2, 2, {
        lowerScore: left.lowerScore,
        upperScore: right.upperScore,
        count: left.count + right.count,
        positiveCount: left.positiveCount + right.positiveCount,
      });
    }
  }

  const positiveCount = sorted.reduce((sum, sample) => sum + sample.label, 0);
  return {
    buckets: buckets.map((bucket) => {
      const empiricalRate = rate(bucket);
      return {
        lowerScore: bucket.lowerScore,
        upperScore: bucket.upperScore,
        count: bucket.count,
        positiveCount: bucket.positiveCount,
        empiricalRate,
        calibratedRate: empiricalRate,
      };
    }),
    sampleCount: sorted.length,
    positiveLabelRate: positiveCount / sorted.length,
  };
}

export function predictIsotonicProbability(model: IsotonicModel, score: number): number | null {
  if (model.buckets.length === 0) return null;
  assertFiniteScore(score);

  const first = model.buckets[0]!;
  if (score <= first.upperScore) return first.calibratedRate;

  const last = model.buckets[model.buckets.length - 1]!;
  if (score >= last.lowerScore) return last.calibratedRate;

  for (const bucket of model.buckets) {
    if (score >= bucket.lowerScore && score <= bucket.upperScore) {
      return bucket.calibratedRate;
    }
  }

  for (let i = 1; i < model.buckets.length; i++) {
    const left = model.buckets[i - 1]!;
    const right = model.buckets[i]!;
    if (score > left.upperScore && score < right.lowerScore) {
      return left.calibratedRate;
    }
  }

  return last.calibratedRate;
}
