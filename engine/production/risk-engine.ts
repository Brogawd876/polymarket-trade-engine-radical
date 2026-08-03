import type { AuthoritativeJournal } from "./journal.ts";
import { formatAtoms, multiplyAtoms, parseAtoms } from "./fixed.ts";

export type ProductionOperatingMode =
  | "REPLAY"
  | "SHADOW"
  | "PAPER"
  | "MICRO_LIVE"
  | "PILOT";

export const PILOT_RISK_DEFAULTS = Object.freeze({
  maximumPerMarketLossFraction: "0.1",
  maximumAggregateOpenLossFraction: "0.2",
  maximumDrawdownFraction: "0.2",
  maximumActiveMarkets: 1,
  sizing: "VENUE_MINIMUM" as const,
  kellyEnabled: false,
  compoundingEnabled: false,
  reconciliationTolerance: "0",
});

export type RiskDependencyState = {
  anchorVerified: boolean;
  exactMarketVerified: boolean;
  marketUnambiguous: boolean;
  acceptingOrders: boolean;
  resolutionFresh: boolean;
  predictiveSourceCount: number;
  minimumPredictiveSourceCount: number;
  venueBookFresh: boolean;
  venueBookContinuous: boolean;
  userChannelHealthy: boolean;
  userChannelOutageWithinReconciliationTolerance: boolean;
  reconciliationValid: boolean;
  unresolvedExchangeCommand: boolean;
  modelCompatible: boolean;
  modelApproved: boolean;
  modelExpired: boolean;
  tickSizeSupported: boolean;
  minimumSizeSupported: boolean;
  depthSufficient: boolean;
  spreadWithinLimit: boolean;
  priceImpactWithinLimit: boolean;
  quoteAgeWithinLimit: boolean;
  clockDriftWithinLimit: boolean;
  exchangeHealthy: boolean;
  orphanRiskOrder: boolean;
  orderChurnWithinLimit: boolean;
  requiredEvidenceComplete: boolean;
  settlementRulesUnambiguous: boolean;
  journalHealthy: boolean;
};

export type RiskFinancialState = {
  startingBankroll: string;
  requestedOrderNotional: string;
  venueMinimumOrderNotional: string;
  proposedMarketWorstCaseLoss: string;
  proposedAggregateWorstCaseOpenLoss: string;
  sessionLoss: string;
  drawdown: string;
  activeMarketIds: string[];
  proposedMarketId: string;
};

export type ProductionRiskInput = {
  riskDecisionId: string;
  runId: string;
  candidateId: string;
  decisionTimestampMs: number;
  mode: ProductionOperatingMode;
  dependencies: RiskDependencyState;
  financials: RiskFinancialState;
  liveAuthorizationPresent: boolean;
};

export type ProductionRiskDecision = {
  riskDecisionId: string;
  runId: string;
  candidateId: string;
  decisionTimestampMs: number;
  mode: ProductionOperatingMode;
  approved: boolean;
  hardBlockReasons: string[];
  limits: {
    maximumPerMarketWorstCaseLoss: string;
    maximumAggregateWorstCaseOpenLoss: string;
    maximumDrawdown: string;
    maximumActiveMarkets: number;
  };
};

function percentageLimit(bankroll: string, fraction: string): bigint {
  const bankrollAtoms = parseAtoms(bankroll);
  if (bankrollAtoms <= 0n) throw new Error("starting bankroll must be positive");
  return multiplyAtoms(bankrollAtoms, parseAtoms(fraction));
}

/**
 * Fail-closed operational and financial authority. Alpha/EV thresholds do not
 * belong here and cannot suppress any reason produced by this engine.
 */
export class ProductionRiskEngine {
  private manualKillSwitch = false;

  constructor(private readonly journal: AuthoritativeJournal) {}

  killSwitchEngaged(): boolean {
    return this.manualKillSwitch;
  }

  async engageKillSwitch(reason: string): Promise<void> {
    if (!reason.trim()) throw new Error("kill-switch reason is required");
    if (this.manualKillSwitch) return;
    await this.journal.append({
      kind: "manual_kill_switch_engaged",
      aggregateId: "production-risk",
      payload: { reason },
    });
    this.manualKillSwitch = true;
  }

  /**
   * Reset is intentionally explicit and journaled. This does not authorize a
   * live mode or clear any other blocker.
   */
  async resetKillSwitch(reason: string): Promise<void> {
    if (!reason.trim()) throw new Error("kill-switch reset reason is required");
    await this.journal.append({
      kind: "manual_kill_switch_reset",
      aggregateId: "production-risk",
      payload: { reason },
    });
    this.manualKillSwitch = false;
  }

  async evaluate(input: ProductionRiskInput): Promise<ProductionRiskDecision> {
    const d = input.dependencies;
    const f = input.financials;
    const reasons: string[] = [];
    const perMarketLimit = percentageLimit(
      f.startingBankroll,
      PILOT_RISK_DEFAULTS.maximumPerMarketLossFraction,
    );
    const aggregateLimit = percentageLimit(
      f.startingBankroll,
      PILOT_RISK_DEFAULTS.maximumAggregateOpenLossFraction,
    );
    const drawdownLimit = percentageLimit(
      f.startingBankroll,
      PILOT_RISK_DEFAULTS.maximumDrawdownFraction,
    );

    if (!d.anchorVerified) reasons.push("unverified anchor");
    if (!d.exactMarketVerified || !d.marketUnambiguous) {
      reasons.push("wrong or ambiguous market");
    }
    if (!d.acceptingOrders) reasons.push("market not accepting orders");
    if (!d.resolutionFresh) reasons.push("missing or stale resolution source");
    if (d.predictiveSourceCount < d.minimumPredictiveSourceCount) {
      reasons.push("insufficient predictive sources");
    }
    if (!d.venueBookFresh || !d.venueBookContinuous) {
      reasons.push("stale or discontinuous venue book");
    }
    if (
      !d.userChannelHealthy &&
      !d.userChannelOutageWithinReconciliationTolerance
    ) {
      reasons.push("user-channel failure beyond reconciliation tolerance");
    }
    if (!d.reconciliationValid) {
      reasons.push("unresolved wallet or ledger mismatch");
    }
    if (d.unresolvedExchangeCommand) {
      reasons.push("unresolved exchange command");
    }
    if (!d.modelCompatible || !d.modelApproved || d.modelExpired) {
      reasons.push("incompatible, unapproved, or expired model artifact");
    }
    if (!d.tickSizeSupported || !d.minimumSizeSupported) {
      reasons.push("unsupported tick size or minimum size");
    }
    if (!d.depthSufficient) reasons.push("insufficient depth");
    if (!d.spreadWithinLimit) reasons.push("excessive spread");
    if (!d.priceImpactWithinLimit) {
      reasons.push("excessive expected price impact");
    }
    if (!d.quoteAgeWithinLimit) reasons.push("excessive quote age");
    if (!d.clockDriftWithinLimit) reasons.push("excessive clock drift");
    if (!d.exchangeHealthy) {
      reasons.push("market maintenance or degraded exchange state");
    }
    if (d.orphanRiskOrder) reasons.push("outstanding orphan-risk order");
    if (!d.orderChurnWithinLimit) reasons.push("excessive order churn");
    if (!d.requiredEvidenceComplete) {
      reasons.push("missing required event evidence");
    }
    if (!d.settlementRulesUnambiguous) {
      reasons.push("settlement-rule ambiguity");
    }
    if (!d.journalHealthy) reasons.push("disk or journal failure");
    if (this.manualKillSwitch) reasons.push("manual kill switch");

    const requested = parseAtoms(f.requestedOrderNotional);
    const venueMinimum = parseAtoms(f.venueMinimumOrderNotional);
    if (requested < venueMinimum) reasons.push("order is below venue minimum");
    if (venueMinimum > perMarketLimit || requested > perMarketLimit) {
      reasons.push("venue minimum or order size exceeds per-market risk cap");
    }
    if (parseAtoms(f.proposedMarketWorstCaseLoss) > perMarketLimit) {
      reasons.push("market exposure limit");
    }
    if (parseAtoms(f.proposedAggregateWorstCaseOpenLoss) > aggregateLimit) {
      reasons.push("aggregate exposure limit");
    }
    if (parseAtoms(f.sessionLoss) >= drawdownLimit) {
      reasons.push("session loss limit");
    }
    if (parseAtoms(f.drawdown) >= drawdownLimit) {
      reasons.push("drawdown limit");
    }
    const activeMarkets = new Set(f.activeMarketIds);
    if (
      !activeMarkets.has(f.proposedMarketId) &&
      activeMarkets.size >= PILOT_RISK_DEFAULTS.maximumActiveMarkets
    ) {
      reasons.push("one active five-minute market limit");
    }

    if (
      (input.mode === "MICRO_LIVE" || input.mode === "PILOT") &&
      !input.liveAuthorizationPresent
    ) {
      reasons.push("separate explicit live authorization is absent");
    }

    const decision: ProductionRiskDecision = {
      riskDecisionId: input.riskDecisionId,
      runId: input.runId,
      candidateId: input.candidateId,
      decisionTimestampMs: input.decisionTimestampMs,
      mode: input.mode,
      approved: reasons.length === 0,
      hardBlockReasons: reasons,
      limits: {
        maximumPerMarketWorstCaseLoss: formatAtoms(perMarketLimit),
        maximumAggregateWorstCaseOpenLoss: formatAtoms(aggregateLimit),
        maximumDrawdown: formatAtoms(drawdownLimit),
        maximumActiveMarkets: PILOT_RISK_DEFAULTS.maximumActiveMarkets,
      },
    };

    await this.journal.append({
      kind: "risk_decision_recorded",
      aggregateId: input.riskDecisionId,
      payload: decision,
    });
    return structuredClone(decision);
  }
}
