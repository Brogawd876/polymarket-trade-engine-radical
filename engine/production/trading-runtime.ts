import { ProductionAuthority } from "./authority.ts";
import {
  CurrentClobExecutionAdapter,
  type CommandResolution,
} from "./exchange-adapter.ts";
import {
  DeterministicFakeExchange,
  type ReplayTrade,
} from "./fake-exchange.ts";
import { formatAtoms, multiplyAtoms, parseAtoms } from "./fixed.ts";
import {
  type ProductionHealthReport,
  type TradingDependencyName,
  validateHealthReport,
} from "./health.ts";
import type { ExchangeReconciliationSnapshot } from "./reconciliation.ts";
import {
  ProductionRiskEngine,
  type ProductionOperatingMode,
  type ProductionRiskDecision,
  type RiskDependencyState,
  type RiskFinancialState,
} from "./risk-engine.ts";
import {
  SettlementEdgeMaker,
  type QuoteGridInput,
  type SettlementEdgeDecision,
} from "./settlement-edge-maker.ts";

export type NonLiveOperatingMode = Extract<
  ProductionOperatingMode,
  "REPLAY" | "SHADOW" | "PAPER"
>;

export type RuntimeRiskFinancials = Pick<
  RiskFinancialState,
  | "startingBankroll"
  | "venueMinimumOrderNotional"
  | "sessionLoss"
  | "drawdown"
  | "activeMarketIds"
> & {
  existingMarketWorstCaseLoss: string;
  existingAggregateWorstCaseOpenLoss: string;
};

export type RuntimeDecisionResult = {
  strategy: SettlementEdgeDecision;
  risk: ProductionRiskDecision | null;
  command: CommandResolution | null;
  intentId: string | null;
  outcome:
    | "NO_TRADE"
    | "RISK_BLOCKED"
    | "SHADOW_ONLY"
    | "PAPER_ORDER_PROCESSED";
};

/**
 * Integrated non-live composition for replay, shadow, and paper execution.
 * Its exchange dependency is statically restricted to DeterministicFakeExchange,
 * so this class cannot sign or submit a real order.
 */
export class ProductionTradingRuntime {
  readonly risk: ProductionRiskEngine;
  private readonly strategy = new SettlementEdgeMaker();
  private readonly execution: CurrentClobExecutionAdapter;
  private started = false;
  private stopped = false;
  private sequence = 0;
  private lastDependencies: RiskDependencyState | null = null;

  private constructor(
    readonly runId: string,
    readonly mode: NonLiveOperatingMode,
    readonly authority: ProductionAuthority,
    readonly exchange: DeterministicFakeExchange,
    private readonly nowMs: () => number,
  ) {
    this.risk = new ProductionRiskEngine(authority.journal);
    this.execution = new CurrentClobExecutionAdapter(
      exchange,
      authority.outbox,
      authority.lifecycle,
      authority.ledger,
      nowMs,
    );
  }

  static async open(input: {
    runId: string;
    mode: NonLiveOperatingMode;
    journalPath: string;
    initialCash: string;
    exchange: DeterministicFakeExchange;
    nowMs?: () => number;
  }): Promise<ProductionTradingRuntime> {
    if (!input.runId.trim()) throw new Error("runId is required");
    const nowMs = input.nowMs ?? Date.now;
    const authority = await ProductionAuthority.open({
      journalPath: input.journalPath,
      initialCash: input.initialCash,
      nowMs,
    });
    return new ProductionTradingRuntime(
      input.runId,
      input.mode,
      authority,
      input.exchange,
      nowMs,
    );
  }

  async start(exchange: ExchangeReconciliationSnapshot): Promise<void> {
    if (this.started) throw new Error("runtime is already started");
    if (this.stopped) throw new Error("stopped runtime cannot restart");
    await this.authority.startup(exchange);
    await this.authority.journal.append({
      kind: "production_runtime_started",
      aggregateId: this.runId,
      payload: {
        runId: this.runId,
        mode: this.mode,
        exchangeAuthority: "DETERMINISTIC_FAKE_ONLY",
      },
    });
    this.started = true;
  }

  async evaluate(input: {
    marketId: string;
    quote: QuoteGridInput;
    dependencies: RiskDependencyState;
    financials: RuntimeRiskFinancials;
  }): Promise<RuntimeDecisionResult> {
    this.assertRunning();
    this.authority.reconciliation.assertReadyForNewTrading();
    this.lastDependencies = structuredClone(input.dependencies);
    const strategy = this.strategy.evaluate(input.quote);
    for (const candidate of strategy.candidates) {
      await this.authority.journal.append({
        kind: "candidate_evaluated",
        aggregateId: candidate.candidateId,
        occurredAtMs: candidate.decisionTimestampMs,
        payload: candidate,
      });
    }
    if (!strategy.selected) {
      return {
        strategy,
        risk: null,
        command: null,
        intentId: null,
        outcome: "NO_TRADE",
      };
    }

    const candidate = strategy.selected;
    const requestedNotional = multiplyAtoms(
      parseAtoms(candidate.requestedPrice),
      parseAtoms(candidate.requestedSize),
    );
    const proposedMarketWorstCaseLoss =
      parseAtoms(input.financials.existingMarketWorstCaseLoss) +
      requestedNotional;
    const proposedAggregateWorstCaseOpenLoss =
      parseAtoms(input.financials.existingAggregateWorstCaseOpenLoss) +
      requestedNotional;
    const riskDecisionId = this.nextId("risk");
    const risk = await this.risk.evaluate({
      riskDecisionId,
      runId: this.runId,
      candidateId: candidate.candidateId,
      decisionTimestampMs: input.quote.decisionTimestampMs,
      mode: this.mode,
      liveAuthorizationPresent: false,
      dependencies: input.dependencies,
      financials: {
        startingBankroll: input.financials.startingBankroll,
        requestedOrderNotional: formatAtoms(requestedNotional),
        venueMinimumOrderNotional:
          input.financials.venueMinimumOrderNotional,
        proposedMarketWorstCaseLoss: formatAtoms(
          proposedMarketWorstCaseLoss,
        ),
        proposedAggregateWorstCaseOpenLoss: formatAtoms(
          proposedAggregateWorstCaseOpenLoss,
        ),
        sessionLoss: input.financials.sessionLoss,
        drawdown: input.financials.drawdown,
        activeMarketIds: [...input.financials.activeMarketIds],
        proposedMarketId: input.marketId,
      },
    });
    if (!risk.approved) {
      return {
        strategy,
        risk,
        command: null,
        intentId: null,
        outcome: "RISK_BLOCKED",
      };
    }
    if (this.mode === "SHADOW") {
      await this.authority.journal.append({
        kind: "shadow_approved_counterfactual",
        aggregateId: candidate.candidateId,
        payload: { candidateId: candidate.candidateId, riskDecisionId },
      });
      return {
        strategy,
        risk,
        command: null,
        intentId: null,
        outcome: "SHADOW_ONLY",
      };
    }

    const intentId = this.nextId("intent");
    const executionCommandId = this.nextId("command");
    const ids = {
      runId: this.runId,
      marketId: input.marketId,
      candidateId: candidate.candidateId,
      decisionId: this.nextId("decision"),
      intentId,
      riskDecisionId,
      executionCommandId,
      clientCorrelationId: this.nextId("correlation"),
    };
    await this.authority.lifecycle.createIntent({
      ids,
      tokenId: candidate.tokenId,
      side: "BUY",
      orderType: candidate.orderType,
      postOnly: candidate.postOnly,
      price: candidate.requestedPrice,
      requestedQuantity: candidate.requestedSize,
    });
    await this.authority.lifecycle.transition(intentId, "RISK_APPROVED");
    await this.authority.ledger.reserveBuy({
      orderId: intentId,
      tokenId: candidate.tokenId,
      limitPrice: candidate.requestedPrice,
      quantity: candidate.requestedSize,
      maximumFee: candidate.expectedFee,
    });
    await this.authority.outbox.enqueue({
      executionCommandId,
      intentId,
      clientCorrelationId: ids.clientCorrelationId,
      kind: "SUBMIT",
      payload: {
        marketId: input.marketId,
        tokenId: candidate.tokenId,
        side: "BUY",
        orderType: candidate.orderType,
        postOnly: candidate.postOnly,
        price: candidate.requestedPrice,
        quantity: candidate.requestedSize,
      },
    });
    await this.authority.lifecycle.transition(intentId, "OUTBOXED");
    const command = await this.execution.execute(executionCommandId);
    return {
      strategy,
      risk,
      command,
      intentId,
      outcome: "PAPER_ORDER_PROCESSED",
    };
  }

  async applyReplayTrade(trade: ReplayTrade): Promise<void> {
    this.assertRunning();
    const evidence = this.exchange.applyTrade(trade);
    for (const update of evidence) {
      const command = this.authority.outbox
        .all()
        .find(
          (candidate) =>
            candidate.clientCorrelationId === update.clientCorrelationId,
        );
      if (!command) {
        throw new Error(
          `exchange evidence has no outbox command ${update.clientCorrelationId}`,
        );
      }
      await this.execution.applyExternalEvidence(
        command.executionCommandId,
        update,
      );
    }
  }

  health(): ProductionHealthReport {
    const now = this.nowMs();
    const d = this.lastDependencies;
    const dependency = (
      healthy: boolean,
      healthyDetail: string,
      blockedDetail: string,
    ) => ({
      status: healthy ? ("HEALTHY" as const) : ("BLOCKED" as const),
      checkedAtMs: now,
      detail: healthy ? healthyDetail : blockedDetail,
    });
    const dependencies: ProductionHealthReport["dependencies"] = {
      engine: dependency(
        this.started && !this.stopped,
        `${this.mode.toLowerCase()} runtime running`,
        "runtime is not running",
      ),
      eventJournal: dependency(
        this.started && !this.stopped,
        "durable journal open and last append succeeded",
        "journal is not open for a running session",
      ),
      resolutionSource: dependency(
        d?.resolutionFresh === true && d.anchorVerified,
        "resolution source fresh and anchor verified",
        "resolution source or anchor is not proven",
      ),
      predictiveSources: dependency(
        Boolean(d && d.predictiveSourceCount >= d.minimumPredictiveSourceCount),
        "minimum predictive-source quorum present",
        "predictive-source quorum absent",
      ),
      venueBook: dependency(
        d?.venueBookFresh === true && d.venueBookContinuous,
        "venue book fresh and sequence-continuous",
        "venue book stale or discontinuous",
      ),
      userChannel: dependency(
        d?.userChannelHealthy === true,
        "paper evidence channel healthy",
        "evidence channel unhealthy or not yet observed",
      ),
      restApi: dependency(
        d?.exchangeHealthy === true,
        "fake-exchange transport healthy",
        "exchange transport degraded",
      ),
      clock: dependency(
        d?.clockDriftWithinLimit === true,
        "clock drift within configured bound",
        "clock drift unproven or excessive",
      ),
      modelRegistry: dependency(
        Boolean(d && d.modelCompatible && d.modelApproved && !d.modelExpired),
        "model artifact approved, compatible, and unexpired",
        "model artifact not deployable",
      ),
      reconciliation: dependency(
        this.authority.reconciliation.latest()?.valid === true,
        "latest reconciliation valid",
        "reconciliation absent or invalid",
      ),
      killSwitch: dependency(
        !this.risk.killSwitchEngaged(),
        "kill switch clear",
        "kill switch engaged",
      ),
    };
    const blockReasons = (
      Object.entries(dependencies) as Array<
        [TradingDependencyName, (typeof dependencies)[TradingDependencyName]]
      >
    )
      .filter(([, state]) => state.status !== "HEALTHY")
      .map(([name, state]) => `${name}: ${state.detail}`);
    return validateHealthReport({
      schemaVersion: 1,
      checkedAtMs: now,
      controlPlane: "HEALTHY",
      tradingReadiness:
        blockReasons.length === 0 && this.mode !== "SHADOW"
          ? "READY"
          : "BLOCKED",
      dependencies,
      blockReasons:
        this.mode === "SHADOW"
          ? ["shadow mode is submission-ineligible", ...blockReasons]
          : blockReasons,
    });
  }

  async stop(exchange: ExchangeReconciliationSnapshot): Promise<void> {
    this.assertRunning();
    await this.authority.shutdown(exchange);
    this.stopped = true;
  }

  private nextId(kind: string): string {
    this.sequence += 1;
    return `${this.runId}:${kind}:${this.sequence}`;
  }

  private assertRunning(): void {
    if (!this.started || this.stopped) {
      throw new Error("production runtime is not running");
    }
  }
}
