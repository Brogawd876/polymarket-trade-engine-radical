import type { Strategy } from "./types.ts";
import { simulationStrategy } from "./simulation.ts";
import { lateEntry, type LateEntryConfig } from "./late-entry.ts";
import { lateEntryOptimized } from "./late-entry-optimized.ts";
import { lateEntryAdaptive } from "./late-entry-adaptive.ts";
import { hyperAggressive } from "./hyper-aggressive.ts";
import { fairValueMaker } from "./fair-value-maker.ts";

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
  hyperaggressive: hyperAggressive,
  "fair-value-maker": fairValueMaker,
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
  "fair-value-maker": {
    id: "fair-value-maker",
    label: "Fair Value Maker (Institutional)",
    strategy: "fair-value-maker",
    description: "Mathematical fair-value quoting using Black-Scholes digital option pricing and inventory skew.",
    config: {
      shares: 5,
      margin: 0.05,
      inventorySkew: 0.1,
      maxInventory: 50,
    },
    paperEligible: true,
  },
  "late-entry-flow-aware": {
    id: "late-entry-flow-aware",
    label: "late-entry (Flow Aware)",
    strategy: "late-entry",
    description: "Standard late-entry reinforced with Order Book Imbalance and Whale protection.",
    config: {
      ...LATE_ENTRY_DEFAULT,
      certaintyPrice: 0.75,
      minImbalance: 0.1,
      minGapSafety: 20,
      blockOnHostileWhale: true,
    },
    paperEligible: true,
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
