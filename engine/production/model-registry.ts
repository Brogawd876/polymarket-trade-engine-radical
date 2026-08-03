import { createHash } from "crypto";

export type PlattCalibrator = {
  type: "PLATT";
  slope: number;
  intercept: number;
};

export type IsotonicCalibrator = {
  type: "ISOTONIC";
  breakpoints: number[];
  values: number[];
};

export type SettlementModelArtifact = {
  schemaVersion: 1;
  artifactId: string;
  artifactKind: "SETTLEMENT_PROBABILITY";
  featureSchemaVersion: number;
  canonicalStateSchemaVersion: number;
  featureNames: string[];
  preprocessing: {
    means: number[];
    scales: number[];
  };
  model: {
    type: "LOGISTIC";
    coefficients: number[];
    intercept: number;
  };
  calibrator: PlattCalibrator | IsotonicCalibrator;
  uncertainty: {
    clusteredStandardError: number;
    zAlpha: number;
  };
  trainingPeriod: { startMs: number; endMs: number };
  datasetHash: string;
  codeCommit: string;
  metrics: Record<string, number>;
  expiresAtMs: number;
  driftLimits: Record<string, number>;
  approval: {
    approved: boolean;
    approvedAtMs: number | null;
    approvedBy: string | null;
  };
  artifactHash: string;
};

export type FillModelArtifact = {
  schemaVersion: 1;
  artifactId: string;
  artifactKind: "CONDITIONAL_FILL";
  featureSchemaVersion: number;
  canonicalStateSchemaVersion: number;
  featureNames: string[];
  preprocessing: {
    means: number[];
    scales: number[];
  };
  model: {
    type: "MULTINOMIAL_LOGISTIC";
    classes: ["NO_FILL", "FILL_WIN", "FILL_LOSS"];
    coefficients: [number[], number[], number[]];
    intercepts: [number, number, number];
    expectedFillFraction: {
      coefficients: number[];
      intercept: number;
    };
  };
  trainingPeriod: { startMs: number; endMs: number };
  datasetHash: string;
  codeCommit: string;
  metrics: Record<string, number>;
  expiresAtMs: number;
  driftLimits: Record<string, number>;
  approval: {
    approved: boolean;
    approvedAtMs: number | null;
    approvedBy: string | null;
  };
  artifactHash: string;
};

export type ModelArtifact = SettlementModelArtifact | FillModelArtifact;

export type SettlementProbability = {
  rawUp: number;
  calibratedUp: number;
  upLower: number;
  upUpper: number;
  downLower: number;
  modelArtifactId: string;
};

export type ConditionalFillPrediction = {
  noFillProbability: number;
  fillAndWinProbability: number;
  fillAndLoseProbability: number;
  fillProbability: number;
  expectedFillFractionGivenFill: number;
  winProbabilityGivenFill: number;
  modelArtifactId: string;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "artifactHash")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function computeArtifactHash(
  artifact: Omit<ModelArtifact, "artifactHash"> | ModelArtifact,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(artifact)))
    .digest("hex");
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const exp = Math.exp(-value);
    return 1 / (1 + exp);
  }
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function normalize(
  artifact: ModelArtifact,
  features: Record<string, number>,
): number[] {
  const count = artifact.featureNames.length;
  if (
    artifact.preprocessing.means.length !== count ||
    artifact.preprocessing.scales.length !== count
  ) {
    throw new Error("model preprocessing dimension mismatch");
  }
  return artifact.featureNames.map((name, index) => {
    const value = features[name];
    const mean = artifact.preprocessing.means[index]!;
    const scale = artifact.preprocessing.scales[index]!;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`missing or non-finite model feature ${name}`);
    }
    if (!Number.isFinite(mean) || !Number.isFinite(scale) || scale <= 0) {
      throw new Error(`invalid preprocessing for feature ${name}`);
    }
    return (value - mean) / scale;
  });
}

function dot(coefficients: number[], values: number[]): number {
  if (coefficients.length !== values.length) {
    throw new Error("model coefficient dimension mismatch");
  }
  return coefficients.reduce(
    (sum, coefficient, index) => sum + coefficient * values[index]!,
    0,
  );
}

function calibrate(
  calibrator: SettlementModelArtifact["calibrator"],
  probability: number,
): number {
  if (calibrator.type === "PLATT") {
    const logit = Math.log(
      Math.max(1e-12, probability) /
        Math.max(1e-12, 1 - probability),
    );
    return sigmoid(calibrator.slope * logit + calibrator.intercept);
  }
  if (
    calibrator.breakpoints.length === 0 ||
    calibrator.breakpoints.length !== calibrator.values.length
  ) {
    throw new Error("invalid isotonic calibrator");
  }
  for (let index = 0; index < calibrator.breakpoints.length; index += 1) {
    if (probability <= calibrator.breakpoints[index]!) {
      return calibrator.values[index]!;
    }
  }
  return calibrator.values.at(-1)!;
}

export class ModelRegistry {
  private settlement: SettlementModelArtifact | null = null;
  private fill: FillModelArtifact | null = null;

  constructor(
    private readonly compatibility: {
      canonicalStateSchemaVersion: number;
      settlementFeatureSchemaVersion: number;
      fillFeatureSchemaVersion: number;
    },
    private readonly nowMs: () => number = Date.now,
  ) {}

  load(artifact: ModelArtifact): void {
    this.validateCommon(artifact);
    if (artifact.artifactKind === "SETTLEMENT_PROBABILITY") {
      if (
        artifact.featureSchemaVersion !==
        this.compatibility.settlementFeatureSchemaVersion
      ) {
        throw new Error("settlement model feature schema is incompatible");
      }
      if (
        artifact.model.coefficients.length !== artifact.featureNames.length
      ) {
        throw new Error("settlement model dimension mismatch");
      }
      this.settlement = structuredClone(artifact);
    } else {
      if (
        artifact.featureSchemaVersion !==
        this.compatibility.fillFeatureSchemaVersion
      ) {
        throw new Error("fill model feature schema is incompatible");
      }
      for (const coefficients of artifact.model.coefficients) {
        if (coefficients.length !== artifact.featureNames.length) {
          throw new Error("fill model dimension mismatch");
        }
      }
      this.fill = structuredClone(artifact);
    }
  }

  requireReady(): void {
    if (!this.settlement) {
      throw new Error(
        "approved settlement model artifact is required; legacy formula fallback is forbidden",
      );
    }
    if (!this.fill) {
      throw new Error("approved conditional-fill model artifact is required");
    }
  }

  settlementProbability(
    features: Record<string, number>,
  ): SettlementProbability {
    const artifact = this.settlement;
    if (!artifact) throw new Error("settlement model is not loaded");
    this.validateCommon(artifact);
    const normalized = normalize(artifact, features);
    const raw = sigmoid(
      artifact.model.intercept +
        dot(artifact.model.coefficients, normalized),
    );
    const calibrated = calibrate(artifact.calibrator, raw);
    const margin =
      artifact.uncertainty.zAlpha *
      artifact.uncertainty.clusteredStandardError;
    const upLower = Math.max(0, calibrated - margin);
    const upUpper = Math.min(1, calibrated + margin);
    return {
      rawUp: raw,
      calibratedUp: calibrated,
      upLower,
      upUpper,
      // DOWN's lower bound is derived from UP's upper bound, never UP lower.
      downLower: 1 - upUpper,
      modelArtifactId: artifact.artifactId,
    };
  }

  conditionalFill(
    features: Record<string, number>,
  ): ConditionalFillPrediction {
    const artifact = this.fill;
    if (!artifact) throw new Error("conditional-fill model is not loaded");
    this.validateCommon(artifact);
    const normalized = normalize(artifact, features);
    const logits = artifact.model.coefficients.map(
      (coefficients, index) =>
        artifact.model.intercepts[index]! + dot(coefficients, normalized),
    );
    const maximum = Math.max(...logits);
    const exponentials = logits.map((value) => Math.exp(value - maximum));
    const total = exponentials.reduce((sum, value) => sum + value, 0);
    const probabilities = exponentials.map((value) => value / total);
    const noFill = probabilities[0]!;
    const fillWin = probabilities[1]!;
    const fillLoss = probabilities[2]!;
    const fillProbability = fillWin + fillLoss;
    const expectedFraction = sigmoid(
      artifact.model.expectedFillFraction.intercept +
        dot(
          artifact.model.expectedFillFraction.coefficients,
          normalized,
        ),
    );
    return {
      noFillProbability: noFill,
      fillAndWinProbability: fillWin,
      fillAndLoseProbability: fillLoss,
      fillProbability,
      expectedFillFractionGivenFill: expectedFraction,
      winProbabilityGivenFill:
        fillProbability > 0 ? fillWin / fillProbability : 0,
      modelArtifactId: artifact.artifactId,
    };
  }

  private validateCommon(artifact: ModelArtifact): void {
    if (artifact.schemaVersion !== 1) {
      throw new Error(`unsupported model artifact schema ${artifact.schemaVersion}`);
    }
    if (
      artifact.canonicalStateSchemaVersion !==
      this.compatibility.canonicalStateSchemaVersion
    ) {
      throw new Error("model canonical-state schema is incompatible");
    }
    if (artifact.artifactHash !== computeArtifactHash(artifact)) {
      throw new Error("model artifact hash mismatch");
    }
    if (!artifact.approval.approved) {
      throw new Error("model artifact is not approved");
    }
    if (
      !artifact.approval.approvedAtMs ||
      !artifact.approval.approvedBy
    ) {
      throw new Error("model approval evidence is incomplete");
    }
    if (artifact.expiresAtMs <= this.nowMs()) {
      throw new Error("model artifact is expired");
    }
    if (!/^[a-f0-9]{64}$/i.test(artifact.datasetHash)) {
      throw new Error("model dataset hash is invalid");
    }
  }
}
