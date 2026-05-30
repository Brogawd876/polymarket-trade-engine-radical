import { type RiskGate, type RiskDecision, type RiskSnapshot, AggregatedRiskGate } from "../bot-core/risk-gate.ts";
import { type StrategyIntent } from "../bot-core/strategy-intent.ts";
import { Env } from "../../utils/config.ts";

export type CounterfactualRiskMode = "normal" | "permissive-counterfactual" | "selective-counterfactual";

export type CounterfactualRiskGateOptions = {
  mode: CounterfactualRiskMode;
  bypassReasons?: string[];
  baseGate?: RiskGate;
  replayOnly?: boolean;
};

export class CounterfactualRiskGate implements RiskGate {
  private readonly baseGate: RiskGate;
  private readonly mode: CounterfactualRiskMode;
  private readonly bypassReasons: Set<string>;

  constructor(opts: CounterfactualRiskGateOptions) {
    if (Env.get("PROD")) {
      if (opts.mode !== "normal") {
        throw new Error("Counterfactual risk modes are strictly prohibited in production.");
      }
    }

    if (opts.mode !== "normal" && opts.replayOnly !== true) {
      throw new Error("Counterfactual risk modes require replayOnly: true.");
    }

    this.mode = opts.mode;
    this.bypassReasons = new Set(opts.bypassReasons ?? []);
    this.baseGate = opts.baseGate ?? new AggregatedRiskGate();
  }

  evaluate(intent: StrategyIntent, snapshot: RiskSnapshot): RiskDecision {
    // Evaluate must throw if snapshot.productionEnabled === true
    if ((snapshot as any).productionEnabled === true && this.mode !== "normal") {
      throw new Error("Counterfactual risk modes cannot evaluate production snapshots.");
    }

    const decision = this.baseGate.evaluate(intent, snapshot);

    if (this.mode === "normal" || decision.approved) {
      return decision;
    }

    const originalReasons = decision.reasons;
    let shouldBypass = false;

    if (this.mode === "permissive-counterfactual") {
      shouldBypass = true;
    } else if (this.mode === "selective-counterfactual") {
      shouldBypass = originalReasons.every(reason => this.bypassReasons.has(reason));
    }

    if (shouldBypass) {
      return {
        approved: true,
        intent,
        checkedAtMs: snapshot.nowMs,
        reasons: [
          "approved_replay_counterfactual",
          ...originalReasons.map(r => `bypassed:${r}`)
        ],
      };
    }

    return decision;
  }
}
