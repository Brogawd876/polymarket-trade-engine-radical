import type { AuthoritativeJournal } from "./journal.ts";
import type { LedgerSnapshot } from "./ledger.ts";
import type { ExecutionOutbox } from "./outbox.ts";
import type { OrderLifecycleManager } from "./order-lifecycle.ts";
import { formatAtoms, parseAtoms } from "./fixed.ts";

export type ReconciliationTrigger =
  | "STARTUP"
  | "PERIODIC"
  | "USER_CHANNEL_OUTAGE"
  | "SHUTDOWN"
  | "RESTART";

export type ExchangeReconciliationSnapshot = {
  evidenceId: string;
  capturedAtMs: number;
  cashBalance: string;
  tokenBalances: Record<string, string>;
  openExchangeOrderIds: string[];
  pendingTradeIds: string[];
  reserveSemantics: {
    cash: "BALANCE_INCLUDES_RESERVED" | "BALANCE_EXCLUDES_RESERVED";
    tokens: "BALANCE_INCLUDES_RESERVED" | "BALANCE_EXCLUDES_RESERVED";
  };
};

export type ReconciliationDifference = {
  field: string;
  expected: string;
  observed: string;
  explanation: string;
};

export type ReconciliationResult = {
  reconciliationId: string;
  trigger: ReconciliationTrigger;
  evidenceId: string;
  capturedAtMs: number;
  valid: boolean;
  differences: ReconciliationDifference[];
  unresolvedCommandIds: string[];
  orphanExchangeOrderIds: string[];
  missingExchangeOrderIds: string[];
  pendingTradeIds: string[];
};

export class ReconciliationService {
  private latestResult: ReconciliationResult | null = null;

  constructor(
    private readonly journal: AuthoritativeJournal,
    private readonly outbox: ExecutionOutbox,
    private readonly lifecycle: OrderLifecycleManager,
  ) {}

  async reconcile(
    trigger: ReconciliationTrigger,
    ledger: LedgerSnapshot,
    exchange: ExchangeReconciliationSnapshot,
  ): Promise<ReconciliationResult> {
    const differences: ReconciliationDifference[] = [];
    const expectedCash =
      exchange.reserveSemantics.cash === "BALANCE_INCLUDES_RESERVED"
        ? parseAtoms(ledger.availableCash) +
          parseAtoms(ledger.reservedBuyCash) +
          parseAtoms(ledger.pendingCash)
        : parseAtoms(ledger.availableCash) + parseAtoms(ledger.pendingCash);
    const observedCash = parseAtoms(exchange.cashBalance);
    if (expectedCash !== observedCash) {
      differences.push({
        field: "cash",
        expected: formatAtoms(expectedCash),
        observed: formatAtoms(observedCash),
        explanation: `cash reserve semantics: ${exchange.reserveSemantics.cash}`,
      });
    }

    const tokenIds = new Set([
      ...Object.keys(ledger.tokenBalances),
      ...Object.keys(exchange.tokenBalances),
    ]);
    for (const tokenId of [...tokenIds].sort()) {
      const expected =
        exchange.reserveSemantics.tokens === "BALANCE_INCLUDES_RESERVED"
          ? parseAtoms(ledger.availableTokens[tokenId] ?? "0") +
            parseAtoms(ledger.reservedSellTokens[tokenId] ?? "0") +
            parseAtoms(ledger.pendingTokenAdjustments[tokenId] ?? "0")
          : parseAtoms(ledger.availableTokens[tokenId] ?? "0") +
            parseAtoms(ledger.pendingTokenAdjustments[tokenId] ?? "0");
      const observed = parseAtoms(exchange.tokenBalances[tokenId] ?? "0");
      if (expected !== observed) {
        differences.push({
          field: `token:${tokenId}`,
          expected: formatAtoms(expected),
          observed: formatAtoms(observed),
          explanation: `token reserve semantics: ${exchange.reserveSemantics.tokens}`,
        });
      }
    }

    const knownOpenIds = new Set(
      this.lifecycle
        .unresolved()
        .map((order) => order.exchangeOrderId)
        .filter((id): id is string => Boolean(id)),
    );
    const observedOpenIds = new Set(exchange.openExchangeOrderIds);
    const orphanExchangeOrderIds = [...observedOpenIds].filter(
      (id) => !knownOpenIds.has(id),
    );
    const missingExchangeOrderIds = [...knownOpenIds].filter(
      (id) => !observedOpenIds.has(id),
    );
    const unresolvedCommandIds = this.outbox
      .unresolved()
      .map((command) => command.executionCommandId);
    const result: ReconciliationResult = {
      reconciliationId: crypto.randomUUID(),
      trigger,
      evidenceId: exchange.evidenceId,
      capturedAtMs: exchange.capturedAtMs,
      valid:
        differences.length === 0 &&
        orphanExchangeOrderIds.length === 0 &&
        missingExchangeOrderIds.length === 0 &&
        unresolvedCommandIds.length === 0 &&
        exchange.pendingTradeIds.length === 0,
      differences,
      unresolvedCommandIds,
      orphanExchangeOrderIds,
      missingExchangeOrderIds,
      pendingTradeIds: [...exchange.pendingTradeIds],
    };
    await this.journal.append({
      kind: "reconciliation_completed",
      aggregateId: result.reconciliationId,
      payload: result,
    });
    this.latestResult = result;
    return structuredClone(result);
  }

  assertReadyForNewTrading(): void {
    if (!this.latestResult?.valid) {
      throw new Error("new trading blocked until reconciliation is valid");
    }
  }

  assertShutdownComplete(): void {
    if (!this.latestResult || this.latestResult.trigger !== "SHUTDOWN") {
      throw new Error("shutdown is incomplete without final reconciliation");
    }
    if (!this.latestResult.valid) {
      throw new Error("shutdown is incomplete while reconciliation differs");
    }
    if (this.lifecycle.unresolved().length > 0) {
      throw new Error("shutdown is incomplete while order remainders remain");
    }
    if (this.outbox.unresolved().length > 0) {
      throw new Error("shutdown is incomplete while outbox commands remain");
    }
  }

  latest(): ReconciliationResult | null {
    return this.latestResult ? structuredClone(this.latestResult) : null;
  }
}
