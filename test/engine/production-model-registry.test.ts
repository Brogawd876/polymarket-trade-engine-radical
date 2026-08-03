import { describe, expect, test } from "bun:test";
import {
  ModelRegistry,
  computeArtifactHash,
  type FillModelArtifact,
  type SettlementModelArtifact,
} from "../../engine/production/model-registry.ts";

const DATASET_HASH = "a".repeat(64);

function settlement(
  overrides: Partial<SettlementModelArtifact> = {},
): SettlementModelArtifact {
  const artifact: SettlementModelArtifact = {
    schemaVersion: 1,
    artifactId: "settlement-v1",
    artifactKind: "SETTLEMENT_PROBABILITY",
    featureSchemaVersion: 1,
    canonicalStateSchemaVersion: 1,
    featureNames: ["distance", "remaining"],
    preprocessing: { means: [0, 30], scales: [1, 30] },
    model: {
      type: "LOGISTIC",
      coefficients: [1, -0.1],
      intercept: 0,
    },
    calibrator: { type: "PLATT", slope: 1, intercept: 0 },
    uncertainty: { clusteredStandardError: 0.05, zAlpha: 1.64 },
    trainingPeriod: { startMs: 1, endMs: 2 },
    datasetHash: DATASET_HASH,
    codeCommit: "abc",
    metrics: { brier: 0.2, logLoss: 0.6 },
    expiresAtMs: 10_000,
    driftLimits: { featurePsi: 0.2 },
    approval: {
      approved: true,
      approvedAtMs: 100,
      approvedBy: "operator",
    },
    artifactHash: "",
    ...overrides,
  };
  artifact.artifactHash = computeArtifactHash(artifact);
  return artifact;
}

function fill(): FillModelArtifact {
  const artifact: FillModelArtifact = {
    schemaVersion: 1,
    artifactId: "fill-v1",
    artifactKind: "CONDITIONAL_FILL",
    featureSchemaVersion: 1,
    canonicalStateSchemaVersion: 1,
    featureNames: ["queue", "lifetime"],
    preprocessing: { means: [5, 1000], scales: [5, 1000] },
    model: {
      type: "MULTINOMIAL_LOGISTIC",
      classes: ["NO_FILL", "FILL_WIN", "FILL_LOSS"],
      coefficients: [
        [1, -1],
        [-1, 1],
        [-0.5, 0.5],
      ],
      intercepts: [0, 0, 0],
      expectedFillFraction: {
        coefficients: [-0.5, 0.5],
        intercept: 0,
      },
    },
    trainingPeriod: { startMs: 1, endMs: 2 },
    datasetHash: DATASET_HASH,
    codeCommit: "abc",
    metrics: { logLoss: 1 },
    expiresAtMs: 10_000,
    driftLimits: { fillRateShift: 0.1 },
    approval: {
      approved: true,
      approvedAtMs: 100,
      approvedBy: "operator",
    },
    artifactHash: "",
  };
  artifact.artifactHash = computeArtifactHash(artifact);
  return artifact;
}

describe("fail-closed model registry", () => {
  test("requires both frozen models and never falls back to a legacy formula", () => {
    const registry = new ModelRegistry(
      {
        canonicalStateSchemaVersion: 1,
        settlementFeatureSchemaVersion: 1,
        fillFeatureSchemaVersion: 1,
      },
      () => 1000,
    );
    expect(() => registry.requireReady()).toThrow(/legacy formula fallback/);
    registry.load(settlement());
    expect(() => registry.requireReady()).toThrow(/conditional-fill/);
    registry.load(fill());
    expect(() => registry.requireReady()).not.toThrow();
  });

  test("rejects unapproved, expired, incompatible, or tampered artifacts", () => {
    const registry = new ModelRegistry(
      {
        canonicalStateSchemaVersion: 1,
        settlementFeatureSchemaVersion: 1,
        fillFeatureSchemaVersion: 1,
      },
      () => 1000,
    );
    expect(() =>
      registry.load(
        settlement({
          approval: {
            approved: false,
            approvedAtMs: null,
            approvedBy: null,
          },
        }),
      ),
    ).toThrow(/not approved/);
    expect(() => registry.load(settlement({ expiresAtMs: 999 }))).toThrow(
      /expired/,
    );
    const tampered = settlement();
    tampered.model.intercept = 999;
    expect(() => registry.load(tampered)).toThrow(/hash mismatch/);
  });

  test("uses the UP upper bound for the conservative DOWN bound", () => {
    const registry = new ModelRegistry(
      {
        canonicalStateSchemaVersion: 1,
        settlementFeatureSchemaVersion: 1,
        fillFeatureSchemaVersion: 1,
      },
      () => 1000,
    );
    registry.load(settlement());
    const result = registry.settlementProbability({
      distance: 0,
      remaining: 30,
    });
    expect(result.upLower).toBeCloseTo(0.418, 6);
    expect(result.upUpper).toBeCloseTo(0.582, 6);
    expect(result.downLower).toBeCloseTo(0.418, 6);
  });

  test("returns joint no-fill/fill-win/fill-loss probabilities", () => {
    const registry = new ModelRegistry(
      {
        canonicalStateSchemaVersion: 1,
        settlementFeatureSchemaVersion: 1,
        fillFeatureSchemaVersion: 1,
      },
      () => 1000,
    );
    registry.load(fill());
    const result = registry.conditionalFill({ queue: 5, lifetime: 1000 });
    expect(
      result.noFillProbability +
        result.fillAndWinProbability +
        result.fillAndLoseProbability,
    ).toBeCloseTo(1, 12);
    expect(result.winProbabilityGivenFill).toBeGreaterThan(0);
  });
});
