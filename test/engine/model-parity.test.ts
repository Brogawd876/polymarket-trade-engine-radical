import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import {
  ModelRegistry,
  computeArtifactHash,
  type SettlementModelArtifact,
} from "../../engine/production/model-registry.ts";

describe("Python and TypeScript model parity", () => {
  test("produces the same raw and calibrated probability", () => {
    const artifact: SettlementModelArtifact = {
      schemaVersion: 1,
      artifactId: "parity-v1",
      artifactKind: "SETTLEMENT_PROBABILITY",
      featureSchemaVersion: 1,
      canonicalStateSchemaVersion: 1,
      featureNames: ["distance", "remaining"],
      preprocessing: { means: [0.1, 30], scales: [0.2, 15] },
      model: {
        type: "LOGISTIC",
        coefficients: [0.7, -0.2],
        intercept: 0.1,
      },
      calibrator: { type: "PLATT", slope: 0.9, intercept: -0.05 },
      uncertainty: { clusteredStandardError: 0.01, zAlpha: 1.64 },
      trainingPeriod: { startMs: 1, endMs: 2 },
      datasetHash: "a".repeat(64),
      codeCommit: "abc",
      metrics: {},
      expiresAtMs: 10_000,
      driftLimits: {},
      approval: {
        approved: true,
        approvedAtMs: 1,
        approvedBy: "test",
      },
      artifactHash: "",
    };
    artifact.artifactHash = computeArtifactHash(artifact);
    const features = { distance: 0.2, remaining: 20 };
    const registry = new ModelRegistry(
      {
        canonicalStateSchemaVersion: 1,
        settlementFeatureSchemaVersion: 1,
        fillFeatureSchemaVersion: 1,
      },
      () => 100,
    );
    registry.load(artifact);
    const typescript = registry.settlementProbability(features);

    const python = spawnSync(
      "python",
      ["research_pipeline/parity.py"],
      {
        cwd: process.cwd(),
        input: JSON.stringify({ artifact, features }),
        encoding: "utf8",
      },
    );
    expect(python.status).toBe(0);
    const parsed = JSON.parse(python.stdout);
    expect(parsed.artifactHash).toBe(computeArtifactHash(artifact));
    expect(parsed.rawUp).toBeCloseTo(typescript.rawUp, 12);
    expect(parsed.calibratedUp).toBeCloseTo(
      typescript.calibratedUp,
      12,
    );
  });
});
