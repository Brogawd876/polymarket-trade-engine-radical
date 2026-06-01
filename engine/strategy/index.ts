import type { Strategy } from "./types.ts";
import { simulationStrategy } from "./simulation.ts";
import { lateEntry, type LateEntryConfig } from "./late-entry.ts";
import { lateEntryOptimized } from "./late-entry-optimized.ts";
import { lateEntryAdaptive } from "./late-entry-adaptive.ts";
import { hyperAggressive } from "./hyper-aggressive.ts";
import { fairValueMaker } from "./fair-value-maker.ts";
import { avellanedaMaker } from "./avellaneda-maker.ts";
import { radicalHybrid } from "./radical-hybrid.ts";

export type StrategyVariant = {
  id: string;
  label: string;
  strategy: string;
  description: string;
  config: Record<string, unknown>;
  paperEligible: boolean;
};

const LATE_ENTRY_DEFAULT: LateEntryConfig = {
  entryWindowSec: 240, // 4 minutes
  certaintyPrice: 0.70, // Catch moves at 70c instead of 85c
  minGapSafety: 20, // More sensitive BTC movement
};

export const strategies: Record<string, Strategy> = {
  "simulation": simulationStrategy,
  "late-entry": lateEntry,
  "late-entry-optimized": lateEntryOptimized,
  "late-entry-adaptive": lateEntryAdaptive,
  "hyper-aggressive": hyperAggressive,
  hyperaggressive: hyperAggressive,
  "fair-value-maker": fairValueMaker,
  "avellaneda-maker": avellanedaMaker,
  "radical-hybrid": radicalHybrid,
};


export const DEFAULT_STRATEGY = "simulation";

export const strategyVariants: Record<string, StrategyVariant> = {
  "simulation": {
    id: "simulation",
    label: "simulation",
    strategy: "simulation",
    description: "Baseline paper/replay strategy used to validate order lifecycle plumbing.",
    config: {},
    paperEligible: true,
  },
  "hyper-aggressive": {
    id: "hyper-aggressive",
    label: "hyper-aggressive",
    strategy: "hyper-aggressive",
    description: "EXTREME aggression for testing purposes.",
    config: {},
    paperEligible: false,
  },
  "late-entry-optimized": {
    id: "late-entry-optimized",
    label: "late-entry optimized",
    strategy: "late-entry-optimized",
    description: "Institutional refinements (dynamic certainty, theta decay) for better signal capture.",
    config: {},
    paperEligible: false,
  },
  "late-entry-adaptive": {
    id: "late-entry-adaptive",
    label: "late-entry adaptive",
    strategy: "late-entry-adaptive",
    description: "Smart sizing and slippage buffering based on market divergence.",
    config: {},
    paperEligible: false,
  },
  "late-entry": {
    id: "late-entry",
    label: "late-entry default",
    strategy: "late-entry",
    description: "Current late-entry rules, kept as the conservative baseline.",
    config: LATE_ENTRY_DEFAULT,
    paperEligible: false,
  },
  "late-entry-120s": {
    id: "late-entry-120s",
    label: "late-entry 120s",
    strategy: "late-entry",
    description: "Wider late-entry window to test whether the baseline enters too late.",
    config: { entryWindowSec: 120 },
    paperEligible: false,
  },
  "late-entry-loose": {
    id: "late-entry-loose",
    label: "late-entry loose",
    strategy: "late-entry",
    description: "Looser certainty, divergence, gap, and liquidity gates for replay tuning only.",
    config: {
      entryWindowSec: 120,
      certaintyPrice: 0.8,
      maxDivergence: 15,
      minGapSafety: 25,
      minPeakGapRatio: 0.6,
      minLiquidity: 10,
    },
    paperEligible: false,
  },
  "late-entry-strict": {
    id: "late-entry-strict",
    label: "late-entry strict",
    strategy: "late-entry",
    description: "Stricter gates for checking whether fewer but cleaner entries improve outcomes.",
    config: {
      entryWindowSec: 60,
      certaintyPrice: 0.9,
      maxDivergence: 8,
      minGapSafety: 50,
      minPeakGapRatio: 0.85,
      minLiquidity: 30,
    },
    paperEligible: false,
  },
  "late-entry-flow-aware": {
    id: "late-entry-flow-aware",
    label: "late-entry (flow-aware)",
    strategy: "late-entry",
    description: "Same as late-entry, but disables triggers if inferred retail flow heavily opposes the entry.",
    config: {
      ...LATE_ENTRY_DEFAULT,
      minFlowImbalance: 0.1, // Require slightly favorable or neutral flow
    },
    paperEligible: true,
  },
  "fair-value-maker": {
    id: "fair-value-maker",
    label: "Fair Value Maker (Institutional)",
    strategy: "fair-value-maker",
    description: "v1.1.1+: Event-driven maker strategy with flow toxicity gates.",
    config: {}, // Uses defaults which now include toxicity gates
    paperEligible: true,
  },
  "fair-value-maker-v1-1-0": {
    id: "fair-value-maker-v1-1-0",
    label: "Fair Value Maker (v1.1.0 High PnL)",
    strategy: "fair-value-maker",
    description: "v1.1.0: Event-driven quote hygiene but WITHOUT toxicity gates. Highly profitable but vulnerable to adverse selection.",
    config: {
      minCvd10s: Number.NEGATIVE_INFINITY,
      minImbalance: -1,
    },
    paperEligible: false,
  },
  "fvm-v1.1.0-raw-ungated": {
    id: "fvm-v1.1.0-raw-ungated",
    label: "FVM v1.1.0 (Raw, Ungated)",
    strategy: "fair-value-maker",
    description: "Original champion: event-driven hygiene but NO disagreement abort or toxicity gates.",
    config: {
      skipHygiene: true,
      minCvd10s: Number.NEGATIVE_INFINITY,
      sharesMode: "fixed",
      shares: 5,
      minShares: 5,
      divergenceThresholdAbs: 200,
    },
    paperEligible: false,
  },
  "fvm-v1.1.0-ai-mutant-poc": {
    id: "fvm-v1.1.0-ai-mutant-poc",
    label: "FVM v1.1.0 AI Mutant POC",
    strategy: "fair-value-maker",
    description: "Mutation-lab candidate derived from v1.1.0 raw ungated. Keeps the champion's open CVD and skip-hygiene settings, but enables existing candidate-only profit/risk controls for small-corpus validation.",
    config: {
      skipHygiene: true,
      minCvd10s: Number.NEGATIVE_INFINITY,
      sharesMode: "fixed",
      shares: 5,
      minShares: 5,
      divergenceThresholdAbs: 200,
      edgeWeightedSizing: true,
      regimeWeightedSizing: true,
      fallingKnifeBlock: true,
      fallingKnifeWindow: 3,
      unstableBasisDownsize: true,
      unstableBasisThreshold: 5.0,
    },
    paperEligible: false,
  },
  "fvm-v1.1.1-raw-gated": {
    id: "fvm-v1.1.1-raw-gated",
    label: "FVM v1.1.1 (Raw, Gated)",
    strategy: "fair-value-maker",
    description: "Original gated: event-driven hygiene + toxicity gates, but NO early aborts.",
    config: {
      skipHygiene: true,
      minCvd10s: -100,
      shares: 10,
    },
    paperEligible: false,
  },
  "fvm-v1.2.0-hygienic-ungated": {
    id: "fvm-v1.2.0-hygienic-ungated",
    label: "FVM v1.2.0 (Hygienic, Ungated)",
    strategy: "fair-value-maker",
    description: "New baseline: early aborts on disagreement + strict bounds + NO toxicity gates.",
    config: {
      skipHygiene: false,
      minCvd10s: Number.NEGATIVE_INFINITY,
      shares: 10,
    },
    paperEligible: false,
  },
  "fvm-v1.2.1-hygienic-gated": {
    id: "fvm-v1.2.1-hygienic-gated",
    label: "FVM v1.2.1 (Hygienic, Gated)",
    strategy: "fair-value-maker",
    description: "Full protection: early aborts + strict bounds + toxicity gates.",
    config: {
      skipHygiene: false,
      minCvd10s: -100,
      shares: 10,
    },
    paperEligible: false,
  },
  "fvm-v1.3.0-profit-selective": {
    id: "fvm-v1.3.0-profit-selective",
    label: "FVM v1.3.0 (Profit-Selective)",
    strategy: "fair-value-maker",
    description: "Profit-directed descendant of v1.1.0-raw-ungated. Dynamic pct_of_balance sizing, edge-weighted and regime-weighted scaling, falling-knife add-block, unstable-basis downsize. Preserves mean-reversion alpha by inheriting the champion's open CVD and skip-hygiene config.",
    config: {
      // Inherit champion's core settings
      skipHygiene: true,
      minCvd10s: Number.NEGATIVE_INFINITY,
      divergenceThresholdAbs: 200,
      // Dynamic bankroll sizing (replaces fixed 5-share sizing)
      sharesMode: "pct_of_balance",
      sharePct: 0.10,    // 10% of balance per order
      minShares: 5,
      // v1.3.0 profit-selective controls
      edgeWeightedSizing: true,
      regimeWeightedSizing: true,
      fallingKnifeBlock: true,
      fallingKnifeWindow: 3,
      unstableBasisDownsize: true,
      unstableBasisThreshold: 5.0,
    },
    paperEligible: false,
  },
  "fvm-v1.4.0-take-profit": {
    id: "fvm-v1.4.0-take-profit",
    label: "FVM v1.4.0 (Take-Profit)",
    strategy: "fair-value-maker",
    description: "v1.3.0 + Avellaneda-Stoikov mid-round exit: sells all inventory when market bid >= 0.97, locking in near-full profit and eliminating settlement risk. Suppresses new buys on exiting side for the remainder of the round.",
    config: {
      // Inherit all v1.3.0 champion settings
      skipHygiene: true,
      minCvd10s: Number.NEGATIVE_INFINITY,
      divergenceThresholdAbs: 200,
      sharesMode: "pct_of_balance",
      sharePct: 0.10,
      minShares: 5,
      edgeWeightedSizing: true,
      regimeWeightedSizing: true,
      fallingKnifeBlock: true,
      fallingKnifeWindow: 3,
      unstableBasisDownsize: true,
      unstableBasisThreshold: 5.0,
      // v1.4.0 take-profit
      takeProfitEnabled: true,
      takeProfitThreshold: 0.97,
    },
    paperEligible: false,
  },
  "fvm-v1.5.0-avellaneda": {
    id: "fvm-v1.5.0-avellaneda",
    label: "FVM v1.5.0 (Avellaneda Market Maker)",
    strategy: "avellaneda-maker",
    description: "v1.5.0: True continuous two-sided quoting based on Avellaneda-Stoikov. Posts bids to acquire inventory and asks to unload it, actively capturing the spread without waiting for a take-profit threshold.",
    config: {
      skipHygiene: true,
      minCvd10s: Number.NEGATIVE_INFINITY,
      divergenceThresholdAbs: 200,
      sharesMode: "pct_of_balance",
      sharePct: 0.10,
      minShares: 5,
      edgeWeightedSizing: true,
      regimeWeightedSizing: true,
      fallingKnifeBlock: true,
      fallingKnifeWindow: 3,
      unstableBasisDownsize: true,
      unstableBasisThreshold: 5.0,
    },
    paperEligible: false,
  },
  "fvm-v2.0.0-toxic-guarded-50": {
    id: "fvm-v2.0.0-toxic-guarded-50",
    label: "FVM v2.0.0 (Toxic Guarded $50)",
    strategy: "fair-value-maker",
    description: "v1.4.0 + Toxic flow cancellation & Volatility jump filter ($50 threshold, 10s cooldown).",
    config: {
      skipHygiene: true,
      minCvd10s: Number.NEGATIVE_INFINITY,
      divergenceThresholdAbs: 200,
      sharesMode: "pct_of_balance",
      sharePct: 0.10,
      minShares: 5,
      edgeWeightedSizing: true,
      regimeWeightedSizing: true,
      fallingKnifeBlock: true,
      fallingKnifeWindow: 3,
      unstableBasisDownsize: true,
      unstableBasisThreshold: 5.0,
      takeProfitEnabled: true,
      takeProfitThreshold: 0.97,
      toxicJumpEnabled: true,
      toxicJumpThresholdAbs: 50.0,
      toxicJumpCooldownMs: 10_000,
    },
    paperEligible: false,
  },
  "fvm-v2.0.0-toxic-guarded-100": {
    id: "fvm-v2.0.0-toxic-guarded-100",
    label: "FVM v2.0.0 (Toxic Guarded $100)",
    strategy: "fair-value-maker",
    description: "v1.4.0 + Toxic flow cancellation & Volatility jump filter ($100 threshold, 10s cooldown).",
    config: {
      skipHygiene: true,
      minCvd10s: Number.NEGATIVE_INFINITY,
      divergenceThresholdAbs: 200,
      sharesMode: "pct_of_balance",
      sharePct: 0.10,
      minShares: 5,
      edgeWeightedSizing: true,
      regimeWeightedSizing: true,
      fallingKnifeBlock: true,
      fallingKnifeWindow: 3,
      unstableBasisDownsize: true,
      unstableBasisThreshold: 5.0,
      takeProfitEnabled: true,
      takeProfitThreshold: 0.97,
      toxicJumpEnabled: true,
      toxicJumpThresholdAbs: 100.0,
      toxicJumpCooldownMs: 10_000,
    },
    paperEligible: false,
  },
  "fvm-v2.1.0-advanced-exits-maker": {
    id: "fvm-v2.1.0-advanced-exits-maker",
    label: "FVM v2.1.0 (Advanced Exits Maker)",
    strategy: "fair-value-maker",
    description: "v2.0.0 + advanced scale-out and trailing stop logic (maker).",
    config: {
      skipHygiene: true,
      minCvd10s: Number.NEGATIVE_INFINITY,
      divergenceThresholdAbs: 200,
      sharesMode: "pct_of_balance",
      sharePct: 0.10,
      minShares: 5,
      edgeWeightedSizing: true,
      regimeWeightedSizing: true,
      fallingKnifeBlock: true,
      fallingKnifeWindow: 3,
      unstableBasisDownsize: true,
      unstableBasisThreshold: 5.0,
      takeProfitEnabled: true,
      takeProfitThreshold: 0.97,
      toxicJumpEnabled: true,
      toxicJumpThresholdAbs: 50.0,
      toxicJumpCooldownMs: 10_000,
      advancedExitsEnabled: true,
      scaleOutProfitMargin: 0.10,
      scaleOutInventoryPct: 0.50,
      trailingStopActivationMargin: 0.15,
      trailingStopDrawdownMargin: 0.05,
      trailingStopOrderType: "maker",
    },
    paperEligible: false,
  },
  "fvm-v2.1.0-advanced-exits-taker": {
    id: "fvm-v2.1.0-advanced-exits-taker",
    label: "FVM v2.1.0 (Advanced Exits Taker)",
    strategy: "fair-value-maker",
    description: "v2.0.0 + advanced scale-out and trailing stop logic (taker).",
    config: {
      skipHygiene: true,
      minCvd10s: Number.NEGATIVE_INFINITY,
      divergenceThresholdAbs: 200,
      sharesMode: "pct_of_balance",
      sharePct: 0.10,
      minShares: 5,
      edgeWeightedSizing: true,
      regimeWeightedSizing: true,
      fallingKnifeBlock: true,
      fallingKnifeWindow: 3,
      unstableBasisDownsize: true,
      unstableBasisThreshold: 5.0,
      takeProfitEnabled: true,
      takeProfitThreshold: 0.97,
      toxicJumpEnabled: true,
      toxicJumpThresholdAbs: 50.0,
      toxicJumpCooldownMs: 10_000,
      advancedExitsEnabled: true,
      scaleOutProfitMargin: 0.10,
      scaleOutInventoryPct: 0.50,
      trailingStopActivationMargin: 0.15,
      trailingStopDrawdownMargin: 0.05,
      trailingStopOrderType: "taker",
    },
    paperEligible: false,
  },
  "fvm-v2.1.1-safeguarded": {
    id: "fvm-v2.1.1-safeguarded",
    label: "FVM v2.1.1 (Safeguarded Hybrid)",
    strategy: "fair-value-maker",
    description: "v2.1.0 + hard spend caps, lower edge threshold, and hybrid trailing stop.",
    config: {
      skipHygiene: true,
      minCvd10s: Number.NEGATIVE_INFINITY,
      divergenceThresholdAbs: 200,
      sharesMode: "pct_of_balance",
      sharePct: 0.10,
      minShares: 5,
      maxSpendAbs: 15.00,
      minEdge: 0.01,
      edgeWeightedSizing: true,
      regimeWeightedSizing: true,
      fallingKnifeBlock: true,
      fallingKnifeWindow: 3,
      unstableBasisDownsize: true,
      unstableBasisThreshold: 5.0,
      takeProfitEnabled: true,
      takeProfitThreshold: 0.97,
      toxicJumpEnabled: true,
      toxicJumpThresholdAbs: 50.0,
      toxicJumpCooldownMs: 10_000,
      advancedExitsEnabled: true,
      scaleOutProfitMargin: 0.10,
      scaleOutInventoryPct: 0.50,
      trailingStopActivationMargin: 0.15,
      trailingStopDrawdownMargin: 0.05,
      trailingStopOrderType: "hybrid",
    },
    paperEligible: false,
  },
};

export function listStrategyVariants(): StrategyVariant[] {
  return Object.values(strategyVariants).sort((a, b) => a.id.localeCompare(b.id));
}

export function resolveStrategySelection(selection: string | undefined): {
  selection: string;
  strategyName: string;
  strategy: Strategy;
  config: Record<string, unknown>;
  variant: StrategyVariant;
} {
  const selected = selection ?? DEFAULT_STRATEGY;
  const variant = strategyVariants[selected] ?? (
    strategies[selected]
      ? {
          id: selected,
          label: selected,
          strategy: selected,
          description: "Direct strategy selection.",
          config: {},
          paperEligible: selected === "simulation",
        }
      : undefined
  );

  if (!variant) throw new Error(`Unknown strategy variant: ${selected}`);

  const strategy = strategies[variant.strategy];
  if (!strategy) throw new Error(`Unknown strategy: ${variant.strategy}`);

  return {
    selection: variant.id,
    strategyName: variant.strategy,
    strategy,
    config: { ...variant.config },
    variant,
  };
}

export type { Strategy, StrategyContext } from "./types.ts";
