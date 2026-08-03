import type { AuthoritativeJournal } from "./journal.ts";
import { parseAtoms } from "./fixed.ts";

export type PromotionGate = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const GATE_CRITERIA: Record<
  PromotionGate,
  readonly string[]
> = Object.freeze({
  0: [
    "complete_decision_order_trace",
    "zero_orphaned_remainders",
    "restart_reconciliation",
    "shutdown_reconciliation",
    "deterministic_replay",
    "exact_anchor_proof",
    "dynamic_fees_and_market_parameters",
    "lot_level_ledger",
    "zero_unexplained_mismatch",
    "fault_injection_tests",
  ],
  1: [
    "continuous_shadow_no_orders",
    "no_raw_stream_overwrite",
    "message_completeness_acceptable",
    "timestamps_preserved",
    "source_latency_measured",
    "features_reproducible",
    "shadow_has_no_submission_capability",
  ],
  2: [
    "chronological_holdout",
    "calibration_not_materially_worse_than_midpoint",
    "predictive_incremental_value_justified",
    "no_leakage",
    "artifact_frozen_reproducible",
    "uncertainty_quantified",
  ],
  3: [
    "identical_market_cohorts",
    "continuous_bankroll",
    "positive_net_pnl_after_costs",
    "positive_clustered_lower_confidence_bound",
    "bounded_drawdown",
    "no_market_or_day_concentration",
    "pessimistic_queue_and_latency_acceptable",
    "ledger_and_lifecycle_invariants",
  ],
  4: [
    "full_live_data_decision_path",
    "simulated_lifecycle_measured_latency",
    "no_operational_failures",
    "stable_calibration_and_risk",
    "no_unavailable_fill_dependence",
  ],
  5: [
    "authenticated_lifecycle_evidence",
    "actual_queue_fill_behavior",
    "exact_fees",
    "actual_partials_and_cancellations",
    "exact_wallet_reconciliation",
    "zero_orphaned_orders",
    "fill_conditioned_model_updated",
  ],
  6: [
    "preregistered_pilot",
    "no_mid_pilot_tuning",
    "automatic_kill_switch",
    "final_wallet_reconciled_net_pnl",
    "inventory_valued_or_settled",
    "no_missing_lifecycle_evidence",
  ],
});

export type GateCriterionEvidence = {
  passed: boolean;
  evidenceIds: string[];
  note: string;
};

export type GateEvidence = {
  gate: PromotionGate;
  evidencePackageId: string;
  evidencePackageHash: string;
  createdAtMs: number;
  cohortId: string;
  criteria: Record<string, GateCriterionEvidence>;
};

export type ExplicitLiveAuthorization = {
  gate: 5 | 6;
  authorizationId: string;
  explicitlyAuthorized: true;
  authorizedAtMs: number;
  bankroll: string;
  maximumPermittedLoss: string;
  orderSize: string;
  marketCohort: string[];
  strategyHash: string;
  modelHash: string;
  configHash: string;
  killSwitchBehavior: string;
  priorGateEvidencePackageIds: string[];
};

export type PromotionState = {
  passedGates: PromotionGate[];
  gateEvidence: Partial<Record<PromotionGate, GateEvidence>>;
  liveAuthorizations: Partial<
    Record<5 | 6, ExplicitLiveAuthorization>
  >;
  highestPassedGate: PromotionGate | null;
  liveSubmissionEnabled: false;
};

function assertHash(label: string, value: string): void {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`${label} must be a SHA-256 hash`);
  }
}

/**
 * Evidence sequencer only. Deliberately has no dependency on an exchange
 * adapter and cannot enable real submission.
 */
export class PromotionManager {
  private readonly evidence = new Map<PromotionGate, GateEvidence>();
  private readonly authorizations = new Map<
    5 | 6,
    ExplicitLiveAuthorization
  >();

  constructor(private readonly journal: AuthoritativeJournal) {}

  async recordGateEvidence(input: GateEvidence): Promise<void> {
    if (this.evidence.has(input.gate)) {
      throw new Error(`gate ${input.gate} evidence is immutable`);
    }
    if (input.gate > 0 && !this.evidence.has((input.gate - 1) as PromotionGate)) {
      throw new Error(`gate ${input.gate - 1} must pass first`);
    }
    if (
      (input.gate === 5 || input.gate === 6) &&
      !this.authorizations.has(input.gate)
    ) {
      throw new Error(`gate ${input.gate} execution lacks explicit authorization`);
    }
    if (!input.evidencePackageId.trim() || !input.cohortId.trim()) {
      throw new Error("evidence package and cohort IDs are required");
    }
    assertHash("evidencePackageHash", input.evidencePackageHash);
    const required = GATE_CRITERIA[input.gate];
    const unexpected = Object.keys(input.criteria).filter(
      (criterion) => !required.includes(criterion),
    );
    if (unexpected.length > 0) {
      throw new Error(`unexpected gate criteria: ${unexpected.join(", ")}`);
    }
    for (const criterion of required) {
      const evidence = input.criteria[criterion];
      if (!evidence?.passed || evidence.evidenceIds.length === 0) {
        throw new Error(
          `gate ${input.gate} criterion lacks passing evidence: ${criterion}`,
        );
      }
      if (evidence.evidenceIds.some((id) => !id.trim())) {
        throw new Error(`gate ${input.gate} has an empty evidence ID`);
      }
    }
    await this.journal.append({
      kind: "promotion_gate_evidence_accepted",
      aggregateId: `promotion-gate-${input.gate}`,
      payload: input,
    });
    this.evidence.set(input.gate, structuredClone(input));
  }

  async recordExplicitLiveAuthorization(
    input: ExplicitLiveAuthorization,
  ): Promise<void> {
    if (this.authorizations.has(input.gate)) {
      throw new Error(`gate ${input.gate} authorization is immutable`);
    }
    const priorRequired = input.gate === 5 ? 4 : 5;
    if (!this.evidence.has(priorRequired)) {
      throw new Error(`gate ${priorRequired} must pass before authorization`);
    }
    if (!input.explicitlyAuthorized) {
      throw new Error("explicit authorization is required");
    }
    for (const [label, value] of [
      ["bankroll", input.bankroll],
      ["maximumPermittedLoss", input.maximumPermittedLoss],
      ["orderSize", input.orderSize],
    ] as const) {
      if (parseAtoms(value) <= 0n) throw new Error(`${label} must be positive`);
    }
    if (parseAtoms(input.maximumPermittedLoss) > parseAtoms(input.bankroll)) {
      throw new Error("maximum permitted loss exceeds bankroll");
    }
    if (input.marketCohort.length === 0) {
      throw new Error("market cohort is required");
    }
    for (const [label, hash] of [
      ["strategyHash", input.strategyHash],
      ["modelHash", input.modelHash],
      ["configHash", input.configHash],
    ] as const) {
      assertHash(label, hash);
    }
    if (!input.killSwitchBehavior.trim()) {
      throw new Error("kill-switch behavior is required");
    }
    const priorEvidenceIds = [...this.evidence.values()]
      .filter((evidence) => evidence.gate <= priorRequired)
      .map((evidence) => evidence.evidencePackageId);
    if (
      priorEvidenceIds.some(
        (id) => !input.priorGateEvidencePackageIds.includes(id),
      )
    ) {
      throw new Error("authorization does not cite every prior gate package");
    }
    await this.journal.append({
      kind: "explicit_live_authorization_recorded",
      aggregateId: input.authorizationId,
      payload: input,
    });
    this.authorizations.set(input.gate, structuredClone(input));
  }

  state(): PromotionState {
    const passedGates = [...this.evidence.keys()].sort(
      (left, right) => left - right,
    );
    return {
      passedGates,
      gateEvidence: Object.fromEntries(this.evidence.entries()),
      liveAuthorizations: Object.fromEntries(this.authorizations.entries()),
      highestPassedGate: passedGates.at(-1) ?? null,
      // Promotion evidence never mutates the technical submission fuse.
      liveSubmissionEnabled: false,
    };
  }
}
