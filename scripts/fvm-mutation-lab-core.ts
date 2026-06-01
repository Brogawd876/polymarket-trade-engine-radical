import type { PairManifest } from "../engine/replay/pair-manifest.ts";
import type { StrategyLabVariantSummary } from "../engine/strategy-lab.ts";
import type { ProfitSurface } from "./fvm-profit-surface.ts";

export type PairManifestSelection = {
  path: string;
  manifest: PairManifest;
};

export type MutationFailureMode =
  | "toxic_fills"
  | "bad_fair_value_placement"
  | "poor_late_window_behavior"
  | "spread_liquidity_problem"
  | "side_bias"
  | "adverse_selection"
  | "oversized_exposure"
  | "missing_exit_behavior"
  | "risk_gate_too_loose"
  | "risk_gate_too_strict";

export type MutationProposal = {
  id: string;
  hypothesis: string;
  evidence: string[];
  failure_modes: MutationFailureMode[];
  target_behavior: string;
  suggested_files_or_symbols: string[];
  expected_metric_movement: string[];
  risk_level: "low" | "medium" | "high";
  validation_criteria: string[];
  rollback_plan: string;
};

export type MutationLabManifest = {
  schemaVersion: 1;
  runId: string;
  generatedAt: string;
  championVariant: string;
  candidateVariant: string | null;
  autoApply: "none" | "best";
  pairLimit: number;
  selectedPairCount: number;
  artifacts: Record<string, string>;
  status: "created" | "completed" | "failed";
  failures: string[];
};

export type ChampionCandidateComparison = {
  championVariant: string;
  candidateVariant: string;
  decision: "candidate_better" | "champion_better" | "inconclusive";
  reasons: string[];
  metrics: {
    champion: ComparableStrategyMetrics | null;
    candidate: ComparableStrategyMetrics | null;
    deltas: Record<string, number | null>;
  };
};

type ComparableStrategyMetrics = {
  totalPnl: number;
  conservativeAdjustedTotalPnl: number;
  tradeCount: number;
  fillCount: number;
  winRate: number | null;
  avgMarkout5s: number | null;
  adverseSelectionRate: number | null;
  worstPnl: number | null;
};

export function selectDeterministicPairs(
  pairs: PairManifestSelection[],
  limit: number,
): PairManifestSelection[] {
  const usable = pairs
    .filter((entry) => entry.manifest.pairValidity === "valid")
    .sort((a, b) => {
      const slugCmp = String(a.manifest.slug ?? "").localeCompare(String(b.manifest.slug ?? ""));
      return slugCmp !== 0 ? slugCmp : a.path.localeCompare(b.path);
    });
  return usable.slice(0, Math.max(0, limit));
}

export function createMutationLabManifest(input: {
  runId: string;
  generatedAt?: string;
  championVariant: string;
  candidateVariant?: string | null;
  autoApply: "none" | "best";
  pairLimit: number;
  selectedPairCount: number;
  artifacts: Record<string, string>;
  status?: "created" | "completed" | "failed";
  failures?: string[];
}): MutationLabManifest {
  return {
    schemaVersion: 1,
    runId: input.runId,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    championVariant: input.championVariant,
    candidateVariant: input.candidateVariant ?? null,
    autoApply: input.autoApply,
    pairLimit: input.pairLimit,
    selectedPairCount: input.selectedPairCount,
    artifacts: input.artifacts,
    status: input.status ?? "created",
    failures: input.failures ?? [],
  };
}

export function generateMutationProposals(surface: ProfitSurface): MutationProposal[] {
  const proposals: MutationProposal[] = [];
  const lossBuckets = surface.topLossBuckets.filter((bucket) => bucket.fillCount > 0);
  const worst = lossBuckets[0];
  const highAsr = [
    ...surface.sections.cvd,
    ...surface.sections.sigma,
    ...surface.sections.spread,
  ].find((bucket) => (bucket.adverseSelectionRate ?? 0) >= 0.6 && bucket.totalSettlementPnl < 0);
  const lateLoss = surface.sections.time.find((bucket) =>
    bucket.key.startsWith("final_") && bucket.totalSettlementPnl < 0
  );
  const inventoryLoss = surface.sections.inventory.find((bucket) =>
    bucket.key === "adding_to_inventory" && bucket.totalSettlementPnl < 0
  );

  if (highAsr) {
    proposals.push({
      id: "fvm-toxic-fill-guard",
      hypothesis: "Losses are concentrated in regimes with high adverse selection, so the maker is getting filled when short-term price movement is already toxic.",
      evidence: [
        `${highAsr.key}: pnl=${highAsr.totalSettlementPnl.toFixed(4)}, fills=${highAsr.fillCount}, adverseSelectionRate=${((highAsr.adverseSelectionRate ?? 0) * 100).toFixed(1)}%`,
      ],
      failure_modes: ["toxic_fills", "adverse_selection", "risk_gate_too_loose"],
      target_behavior: "Enable a candidate-only toxicity guard that blocks or downsizes quotes when side-adjusted flow, sigma, or spread buckets show negative PnL with high adverse selection.",
      suggested_files_or_symbols: ["engine/strategy/fair-value-maker.ts", "engine/strategy/index.ts"],
      expected_metric_movement: ["lower adverse-selection rate", "lower fill count in toxic buckets", "better conservative-adjusted PnL"],
      risk_level: "medium",
      validation_criteria: ["candidate conservative-adjusted PnL improves", "candidate does not collapse trade count below useful evidence", "holdout does not worsen materially"],
      rollback_plan: "Disable the candidate variant or remove the candidate-only config flags.",
    });
  }

  if (lateLoss) {
    proposals.push({
      id: "fvm-late-window-block",
      hypothesis: "Final-window fills are losing, which suggests the strategy is quoting into settlement noise or stale fair value near expiry.",
      evidence: [
        `${lateLoss.key}: pnl=${lateLoss.totalSettlementPnl.toFixed(4)}, fills=${lateLoss.fillCount}, winRate=${(lateLoss.winRate * 100).toFixed(1)}%`,
      ],
      failure_modes: ["poor_late_window_behavior", "bad_fair_value_placement", "risk_gate_too_loose"],
      target_behavior: "Add a candidate-only final-window block or downsize rule for the losing late-time bucket.",
      suggested_files_or_symbols: ["engine/strategy/fair-value-maker.ts", "engine/strategy/index.ts"],
      expected_metric_movement: ["reduce final-window losses", "reduce worst-round PnL", "slightly lower trade count"],
      risk_level: "low",
      validation_criteria: ["final-window bucket PnL improves", "overall PnL does not rely only on removing all trades", "candidate still generates enough fills"],
      rollback_plan: "Remove the candidate final-window config flag.",
    });
  }

  if (inventoryLoss) {
    proposals.push({
      id: "fvm-inventory-add-block",
      hypothesis: "Adding to existing inventory is losing, which suggests the strategy is averaging into bad positions instead of waiting for cleaner re-entry.",
      evidence: [
        `${inventoryLoss.key}: pnl=${inventoryLoss.totalSettlementPnl.toFixed(4)}, fills=${inventoryLoss.fillCount}, maxLoss=${inventoryLoss.maxLoss.toFixed(4)}`,
      ],
      failure_modes: ["oversized_exposure", "missing_exit_behavior", "risk_gate_too_loose"],
      target_behavior: "Use the existing candidate-only falling-knife or inventory add-block behavior to avoid compounding losing inventory.",
      suggested_files_or_symbols: ["engine/strategy/index.ts"],
      expected_metric_movement: ["lower max loss", "lower exposure concentration", "better PnL per dollar exposed"],
      risk_level: "low",
      validation_criteria: ["adding-to-inventory bucket improves", "trade count remains nonzero", "worst PnL improves"],
      rollback_plan: "Remove candidate inventory add-block settings.",
    });
  }

  if (proposals.length === 0 && worst) {
    proposals.push({
      id: "fvm-worst-bucket-filter",
      hypothesis: "The largest loss bucket should be isolated first before broader strategy changes are attempted.",
      evidence: [
        `${worst.key}: pnl=${worst.totalSettlementPnl.toFixed(4)}, fills=${worst.fillCount}, winRate=${(worst.winRate * 100).toFixed(1)}%`,
      ],
      failure_modes: ["risk_gate_too_loose"],
      target_behavior: "Create a candidate-only filter or downsize rule for the single worst observed bucket.",
      suggested_files_or_symbols: ["engine/strategy/fair-value-maker.ts", "engine/strategy/index.ts"],
      expected_metric_movement: ["improve worst bucket PnL", "reduce downside concentration"],
      risk_level: "medium",
      validation_criteria: ["candidate improves the worst bucket", "overall PnL improves after accounting for fewer fills"],
      rollback_plan: "Remove the candidate filter.",
    });
  }

  if (proposals.length === 0) {
    proposals.push({
      id: "fvm-more-evidence-needed",
      hypothesis: "The run did not produce enough attributed losing evidence to justify a behavior mutation.",
      evidence: [`records=${surface.summary.recordCount}, attributedFills=${surface.summary.attributedFillCount}`],
      failure_modes: ["risk_gate_too_strict"],
      target_behavior: "Collect more replayable fills before changing strategy behavior.",
      suggested_files_or_symbols: [],
      expected_metric_movement: ["no code change recommended"],
      risk_level: "low",
      validation_criteria: ["larger corpus produces enough fill attribution for a specific proposal"],
      rollback_plan: "No rollback needed; no mutation should be applied.",
    });
  }

  return proposals;
}

export function proposalSchemaExample(): MutationProposal {
  return {
    id: "example",
    hypothesis: "Human-readable causal claim.",
    evidence: ["Concrete metric or bucket evidence."],
    failure_modes: ["risk_gate_too_loose"],
    target_behavior: "Behavior the candidate should change.",
    suggested_files_or_symbols: ["engine/strategy/index.ts"],
    expected_metric_movement: ["Metric expected to improve."],
    risk_level: "low",
    validation_criteria: ["Observable pass/fail criterion."],
    rollback_plan: "How to undo the candidate.",
  };
}

export function compareChampionCandidate(input: {
  championVariant: string;
  candidateVariant: string;
  summaries: StrategyLabVariantSummary[];
}): ChampionCandidateComparison {
  const champion = input.summaries.find((summary) =>
    summary.strategy === input.championVariant || summary.label === input.championVariant
  );
  const candidate = input.summaries.find((summary) =>
    summary.strategy === input.candidateVariant || summary.label === input.candidateVariant
  );

  const championMetrics = champion ? toComparableMetrics(champion) : null;
  const candidateMetrics = candidate ? toComparableMetrics(candidate) : null;
  const reasons: string[] = [];

  if (!championMetrics || !candidateMetrics) {
    reasons.push("Missing champion or candidate metrics.");
    return {
      championVariant: input.championVariant,
      candidateVariant: input.candidateVariant,
      decision: "inconclusive",
      reasons,
      metrics: { champion: championMetrics, candidate: candidateMetrics, deltas: {} },
    };
  }

  const deltas = {
    totalPnl: candidateMetrics.totalPnl - championMetrics.totalPnl,
    conservativeAdjustedTotalPnl: candidateMetrics.conservativeAdjustedTotalPnl - championMetrics.conservativeAdjustedTotalPnl,
    tradeCount: candidateMetrics.tradeCount - championMetrics.tradeCount,
    fillCount: candidateMetrics.fillCount - championMetrics.fillCount,
    winRate: nullableDelta(candidateMetrics.winRate, championMetrics.winRate),
    avgMarkout5s: nullableDelta(candidateMetrics.avgMarkout5s, championMetrics.avgMarkout5s),
    adverseSelectionRate: nullableDelta(candidateMetrics.adverseSelectionRate, championMetrics.adverseSelectionRate),
    worstPnl: nullableDelta(candidateMetrics.worstPnl, championMetrics.worstPnl),
  };

  const lacksUsefulFillEvidence = championMetrics.fillCount === 0 || candidateMetrics.fillCount === 0;

  if (candidateMetrics.tradeCount === 0 || lacksUsefulFillEvidence) {
    reasons.push("Comparison lacks useful conservative fill evidence.");
  }
  if (deltas.conservativeAdjustedTotalPnl > 0) {
    reasons.push("Candidate improved conservative-adjusted PnL.");
  } else {
    reasons.push("Candidate did not improve conservative-adjusted PnL.");
  }
  if (deltas.adverseSelectionRate !== null && deltas.adverseSelectionRate < 0) {
    reasons.push("Candidate reduced adverse-selection rate.");
  }
  if (deltas.worstPnl !== null && deltas.worstPnl > 0) {
    reasons.push("Candidate improved worst-run PnL.");
  }

  const decision =
    !lacksUsefulFillEvidence &&
    candidateMetrics.tradeCount > 0 &&
    deltas.conservativeAdjustedTotalPnl > 0
      ? "candidate_better"
      : !lacksUsefulFillEvidence && deltas.conservativeAdjustedTotalPnl < 0
        ? "champion_better"
        : "inconclusive";

  return {
    championVariant: input.championVariant,
    candidateVariant: input.candidateVariant,
    decision,
    reasons,
    metrics: { champion: championMetrics, candidate: candidateMetrics, deltas },
  };
}

function toComparableMetrics(summary: StrategyLabVariantSummary): ComparableStrategyMetrics {
  return {
    totalPnl: summary.totalPnl,
    conservativeAdjustedTotalPnl: summary.conservativeAdjustedTotalPnl,
    tradeCount: summary.tradeCount,
    fillCount: summary.conservativeFill.confirmedFillCount,
    winRate: summary.winRate,
    avgMarkout5s: summary.conservativeFill.avgMarkout5s,
    adverseSelectionRate: summary.conservativeFill.adverseSelectionRate,
    worstPnl: summary.conservativeAdjustedWorstPnl ?? summary.worstPnl,
  };
}

function nullableDelta(next: number | null, previous: number | null): number | null {
  if (next === null || previous === null) return null;
  return next - previous;
}
