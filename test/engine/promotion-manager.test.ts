import { describe, expect, test } from "bun:test";
import { MemoryJournal } from "../../engine/production/journal.ts";
import {
  GATE_CRITERIA,
  PromotionManager,
  type GateEvidence,
} from "../../engine/production/promotion-manager.ts";

const HASH = "a".repeat(64);

function evidence(gate: 0 | 1 | 2 | 3 | 4 | 5 | 6): GateEvidence {
  return {
    gate,
    evidencePackageId: `package-${gate}`,
    evidencePackageHash: HASH,
    createdAtMs: gate + 1,
    cohortId: "same-cohort",
    criteria: Object.fromEntries(
      GATE_CRITERIA[gate].map((criterion) => [
        criterion,
        {
          passed: true,
          evidenceIds: [`evidence-${gate}-${criterion}`],
          note: "test evidence",
        },
      ]),
    ),
  };
}

describe("PromotionManager", () => {
  test("rejects missing criteria and out-of-order gates", async () => {
    const manager = new PromotionManager(new MemoryJournal());
    await expect(manager.recordGateEvidence(evidence(1))).rejects.toThrow(
      "gate 0 must pass first",
    );
    const gate0 = evidence(0);
    delete gate0.criteria.complete_decision_order_trace;
    await expect(manager.recordGateEvidence(gate0)).rejects.toThrow(
      "criterion lacks passing evidence",
    );
  });

  test("records immutable sequential evidence without enabling submission", async () => {
    const journal = new MemoryJournal();
    const manager = new PromotionManager(journal);
    await manager.recordGateEvidence(evidence(0));
    await manager.recordGateEvidence(evidence(1));
    expect(manager.state().highestPassedGate).toBe(1);
    expect(manager.state().liveSubmissionEnabled).toBe(false);
    await expect(manager.recordGateEvidence(evidence(1))).rejects.toThrow(
      "immutable",
    );
    expect(
      journal.records().filter(
        (event) => event.kind === "promotion_gate_evidence_accepted",
      ),
    ).toHaveLength(2);
  });

  test("requires separate exact approvals for micro-live and pilot", async () => {
    const manager = new PromotionManager(new MemoryJournal());
    for (const gate of [0, 1, 2, 3, 4] as const) {
      await manager.recordGateEvidence(evidence(gate));
    }
    await expect(manager.recordGateEvidence(evidence(5))).rejects.toThrow(
      "lacks explicit authorization",
    );
    const priorGateEvidencePackageIds = [0, 1, 2, 3, 4].map(
      (gate) => `package-${gate}`,
    );
    await manager.recordExplicitLiveAuthorization({
      gate: 5,
      authorizationId: "authorization-5",
      explicitlyAuthorized: true,
      authorizedAtMs: 10,
      bankroll: "25",
      maximumPermittedLoss: "2",
      orderSize: "1",
      marketCohort: ["btc-updown-5m"],
      strategyHash: HASH,
      modelHash: HASH,
      configHash: HASH,
      killSwitchBehavior: "cancel, reconcile, and block new orders",
      priorGateEvidencePackageIds,
    });
    await manager.recordGateEvidence(evidence(5));
    await expect(manager.recordGateEvidence(evidence(6))).rejects.toThrow(
      "lacks explicit authorization",
    );
    await manager.recordExplicitLiveAuthorization({
      gate: 6,
      authorizationId: "authorization-6",
      explicitlyAuthorized: true,
      authorizedAtMs: 20,
      bankroll: "25",
      maximumPermittedLoss: "5",
      orderSize: "1",
      marketCohort: ["btc-updown-5m"],
      strategyHash: HASH,
      modelHash: HASH,
      configHash: HASH,
      killSwitchBehavior: "cancel, reconcile, and stop pilot",
      priorGateEvidencePackageIds: [
        ...priorGateEvidencePackageIds,
        "package-5",
      ],
    });
    expect(manager.state().liveSubmissionEnabled).toBe(false);
  });
});
