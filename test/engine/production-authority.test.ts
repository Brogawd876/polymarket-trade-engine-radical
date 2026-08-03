import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DurableJournal,
  MemoryJournal,
} from "../../engine/production/journal.ts";
import {
  formatAtoms,
  multiplyAtoms,
  parseAtoms,
} from "../../engine/production/fixed.ts";
import { ExecutionOutbox } from "../../engine/production/outbox.ts";
import { OrderLifecycleManager } from "../../engine/production/order-lifecycle.ts";
import { LotLedger } from "../../engine/production/ledger.ts";
import { ReconciliationService } from "../../engine/production/reconciliation.ts";
import { ProductionAuthority } from "../../engine/production/authority.ts";

function ids(suffix = "1") {
  return {
    runId: `run-${suffix}`,
    marketId: `market-${suffix}`,
    candidateId: `candidate-${suffix}`,
    decisionId: `decision-${suffix}`,
    intentId: `intent-${suffix}`,
    riskDecisionId: `risk-${suffix}`,
    executionCommandId: `command-${suffix}`,
    clientCorrelationId: `correlation-${suffix}`,
  };
}

async function createOrder(
  lifecycle: OrderLifecycleManager,
  suffix = "1",
) {
  const stableIds = ids(suffix);
  await lifecycle.createIntent({
    ids: stableIds,
    tokenId: "UP",
    side: "BUY",
    orderType: "GTC",
    postOnly: true,
    price: "0.42",
    requestedQuantity: "10",
  });
  return stableIds;
}

describe("fixed-point accounting", () => {
  test("never requires binary floating point for exchange values", () => {
    expect(parseAtoms("0.100001")).toBe(100001n);
    expect(formatAtoms(parseAtoms("12.340000"))).toBe("12.34");
    expect(formatAtoms(multiplyAtoms(parseAtoms("0.42"), parseAtoms("10")))).toBe(
      "4.2",
    );
    expect(() => parseAtoms("0.1234567")).toThrow(/precision exceeds/);
  });
});

describe("durable authoritative journal", () => {
  test("fsyncs append-only records and rejects a corrupt hash chain", async () => {
    const directory = mkdtempSync(join(tmpdir(), "production-journal-"));
    const filePath = join(directory, "journal.ndjson");
    try {
      const journal = await DurableJournal.open(filePath, { nowMs: () => 10 });
      await journal.append({
        eventId: "event-1",
        kind: "test",
        aggregateId: "a",
        payload: { amount: "0.10" },
      });
      await journal.close();
      const reopened = await DurableJournal.open(filePath);
      expect(reopened.records()).toHaveLength(1);
      await reopened.close();

      const record = JSON.parse(readFileSync(filePath, "utf8").trim());
      record.payload.amount = "999";
      writeFileSync(filePath, `${JSON.stringify(record)}\n`);
      await expect(DurableJournal.open(filePath)).rejects.toThrow(
        /hash mismatch/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("outbox and authoritative order lifecycle", () => {
  test("journals command before submission and blocks blind ambiguous retry", async () => {
    const journal = new MemoryJournal();
    const outbox = new ExecutionOutbox(journal);
    await outbox.enqueue({
      executionCommandId: "command-1",
      intentId: "intent-1",
      clientCorrelationId: "correlation-1",
      kind: "SUBMIT",
      payload: { price: "0.42" },
    });
    outbox.assertCanSubmit("command-1");
    await outbox.transition("command-1", "SUBMITTING");
    await outbox.transition("command-1", "AMBIGUOUS", {
      error: "connection reset after request write",
    });
    expect(() => outbox.assertCanSubmit("command-1")).toThrow(
      /requires reconciliation/,
    );
    expect(journal.records()[0]?.kind).toBe("execution_command_queued");
  });

  test("retains a partial GTC remainder and handles a fill racing cancel", async () => {
    const journal = new MemoryJournal();
    const lifecycle = new OrderLifecycleManager(journal);
    const stableIds = await createOrder(lifecycle);
    await lifecycle.transition(stableIds.intentId, "RISK_APPROVED");
    await lifecycle.transition(stableIds.intentId, "OUTBOXED");
    await lifecycle.transition(stableIds.intentId, "SUBMITTING");
    await lifecycle.transition(stableIds.intentId, "ACKNOWLEDGED", {
      exchangeOrderId: "exchange-1",
    });
    await lifecycle.transition(stableIds.intentId, "LIVE");
    await lifecycle.applyFill({
      intentId: stableIds.intentId,
      tradeId: "trade-1",
      quantity: "3",
    });
    expect(lifecycle.get(stableIds.intentId)?.remainingQuantity).toBe("7");
    await lifecycle.transition(stableIds.intentId, "CANCEL_PENDING");
    await lifecycle.applyFill({
      intentId: stableIds.intentId,
      tradeId: "trade-2",
      quantity: "2",
    });
    expect(lifecycle.get(stableIds.intentId)?.state).toBe("PARTIALLY_FILLED");
    expect(lifecycle.get(stableIds.intentId)?.remainingQuantity).toBe("5");
    await lifecycle.transition(stableIds.intentId, "CANCEL_PENDING");
    await lifecycle.transition(stableIds.intentId, "CANCELED");
    expect(lifecycle.get(stableIds.intentId)?.remainingQuantity).toBe("0");
    expect(lifecycle.get(stableIds.intentId)?.canceledQuantity).toBe("5");
    expect(lifecycle.unresolved()).toHaveLength(0);
  });

  test("deduplicates exchange fills by trade id", async () => {
    const journal = new MemoryJournal();
    const lifecycle = new OrderLifecycleManager(journal);
    const stableIds = await createOrder(lifecycle);
    await lifecycle.transition(stableIds.intentId, "RISK_APPROVED");
    await lifecycle.transition(stableIds.intentId, "OUTBOXED");
    await lifecycle.transition(stableIds.intentId, "SUBMITTING");
    await lifecycle.transition(stableIds.intentId, "ACKNOWLEDGED");
    await lifecycle.applyFill({
      intentId: stableIds.intentId,
      tradeId: "trade-1",
      quantity: "1",
    });
    await lifecycle.applyFill({
      intentId: stableIds.intentId,
      tradeId: "trade-1",
      quantity: "1",
    });
    expect(lifecycle.get(stableIds.intentId)?.filledQuantity).toBe("1");
  });
});

describe("FIFO lot ledger and reconciliation", () => {
  test("accounts for partial fills, exact fees, and FIFO realized PnL", async () => {
    const journal = new MemoryJournal();
    const ledger = new LotLedger("100", journal);
    await ledger.reserveBuy({
      orderId: "buy-1",
      tokenId: "UP",
      limitPrice: "0.42",
      quantity: "10",
      maximumFee: "0.1",
    });
    await ledger.applyFill({
      orderId: "buy-1",
      tradeId: "trade-buy-1",
      marketId: "market-1",
      tokenId: "UP",
      side: "BUY",
      price: "0.4",
      quantity: "4",
      fee: "0.02",
      makerTaker: "MAKER",
      sourceTimestampMs: 1,
      ingestTimestampMs: 2,
    });
    await ledger.releaseReservation("buy-1", "confirmed cancel");
    await ledger.reserveSell({
      orderId: "sell-1",
      tokenId: "UP",
      quantity: "2",
    });
    await ledger.applyFill({
      orderId: "sell-1",
      tradeId: "trade-sell-1",
      marketId: "market-1",
      tokenId: "UP",
      side: "SELL",
      price: "0.6",
      quantity: "2",
      fee: "0.01",
      makerTaker: "TAKER",
      sourceTimestampMs: 3,
      ingestTimestampMs: 4,
    });

    const snapshot = ledger.snapshot();
    expect(snapshot.cashBalance).toBe("99.57");
    expect(snapshot.availableTokens.UP).toBe("2");
    expect(snapshot.actualFees).toBe("0.03");
    expect(snapshot.realizedTradingPnl).toBe("0.38");
    expect(snapshot.lots[0]?.remainingQuantity).toBe("2");
  });

  test("rehydrates reservations, lots, and exact balances after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "authority-restart-"));
    const journalPath = join(directory, "journal.ndjson");
    try {
      const first = await ProductionAuthority.open({
        journalPath,
        initialCash: "20",
      });
      await first.ledger.reserveBuy({
        orderId: "buy-1",
        tokenId: "UP",
        limitPrice: "0.5",
        quantity: "6",
        maximumFee: "0",
      });
      await first.ledger.applyFill({
        orderId: "buy-1",
        tradeId: "trade-1",
        marketId: "market-1",
        tokenId: "UP",
        side: "BUY",
        price: "0.5",
        quantity: "2",
        fee: "0",
        makerTaker: "MAKER",
        sourceTimestampMs: 1,
        ingestTimestampMs: 2,
      });
      await first.journal.close();

      const second = await ProductionAuthority.open({ journalPath });
      const restored = second.ledger.snapshot();
      expect(restored.cashBalance).toBe("19");
      expect(restored.availableCash).toBe("17");
      expect(restored.reservedBuyCash).toBe("2");
      expect(restored.availableTokens.UP).toBe("2");
      expect(restored.lots).toHaveLength(1);
      await second.journal.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("crash/restart preserves an unresolved outbox command and blocks startup trading", async () => {
    const directory = mkdtempSync(join(tmpdir(), "authority-outbox-crash-"));
    const journalPath = join(directory, "journal.ndjson");
    try {
      const first = await ProductionAuthority.open({
        journalPath,
        initialCash: "100",
      });
      const stableIds = await createOrder(first.lifecycle, "crash");
      await first.lifecycle.transition(stableIds.intentId, "RISK_APPROVED");
      await first.ledger.reserveBuy({
        orderId: stableIds.intentId,
        tokenId: "UP",
        limitPrice: "0.42",
        quantity: "10",
        maximumFee: "0",
      });
      await first.outbox.enqueue({
        executionCommandId: stableIds.executionCommandId,
        intentId: stableIds.intentId,
        clientCorrelationId: stableIds.clientCorrelationId,
        kind: "SUBMIT",
        payload: { tokenId: "UP", price: "0.42", quantity: "10" },
      });
      await first.lifecycle.transition(stableIds.intentId, "OUTBOXED");
      await first.journal.close();

      const restarted = await ProductionAuthority.open({ journalPath });
      await expect(
        restarted.startup({
          evidenceId: "startup-rest-crash",
          capturedAtMs: 1_000,
          cashBalance: "100",
          tokenBalances: {},
          openExchangeOrderIds: [],
          pendingTradeIds: [],
          reserveSemantics: {
            cash: "BALANCE_INCLUDES_RESERVED",
            tokens: "BALANCE_INCLUDES_RESERVED",
          },
        }),
      ).rejects.toThrow("new trading blocked until reconciliation is valid");

      expect(restarted.lifecycle.get(stableIds.intentId)?.state).toBe("OUTBOXED");
      expect(restarted.outbox.get(stableIds.executionCommandId)?.state).toBe("QUEUED");
      expect(restarted.ledger.snapshot().reservedBuyCash).toBe("4.2");
      expect(restarted.reconciliation.latest()?.unresolvedCommandIds).toEqual([
        stableIds.executionCommandId,
      ]);
      expect(
        restarted.journal
          .records()
          .some(record => record.kind === "reconciliation_completed"),
      ).toBe(true);
      await restarted.journal.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("restart recovers a live order but refuses false-complete shutdown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "authority-live-restart-"));
    const journalPath = join(directory, "journal.ndjson");
    try {
      const first = await ProductionAuthority.open({
        journalPath,
        initialCash: "100",
      });
      const stableIds = await createOrder(first.lifecycle, "live");
      await first.lifecycle.transition(stableIds.intentId, "RISK_APPROVED");
      await first.ledger.reserveBuy({
        orderId: stableIds.intentId,
        tokenId: "UP",
        limitPrice: "0.42",
        quantity: "10",
        maximumFee: "0",
      });
      await first.outbox.enqueue({
        executionCommandId: stableIds.executionCommandId,
        intentId: stableIds.intentId,
        clientCorrelationId: stableIds.clientCorrelationId,
        kind: "SUBMIT",
        payload: { tokenId: "UP", price: "0.42", quantity: "10" },
      });
      await first.lifecycle.transition(stableIds.intentId, "OUTBOXED");
      await first.outbox.transition(stableIds.executionCommandId, "SUBMITTING");
      await first.lifecycle.transition(stableIds.intentId, "SUBMITTING");
      await first.outbox.transition(stableIds.executionCommandId, "ACKNOWLEDGED", {
        exchangeOrderId: "exchange-live-1",
      });
      await first.lifecycle.transition(stableIds.intentId, "ACKNOWLEDGED", {
        exchangeOrderId: "exchange-live-1",
      });
      await first.lifecycle.transition(stableIds.intentId, "LIVE");
      await first.outbox.transition(stableIds.executionCommandId, "RESOLVED");
      await first.journal.close();

      const restarted = await ProductionAuthority.open({ journalPath });
      const exchangeSnapshot = {
        evidenceId: "startup-rest-live",
        capturedAtMs: 2_000,
        cashBalance: "100",
        tokenBalances: {},
        openExchangeOrderIds: ["exchange-live-1"],
        pendingTradeIds: [],
        reserveSemantics: {
          cash: "BALANCE_INCLUDES_RESERVED" as const,
          tokens: "BALANCE_INCLUDES_RESERVED" as const,
        },
      };
      const startup = await restarted.startup(exchangeSnapshot);
      expect(startup.valid).toBe(true);
      expect(restarted.lifecycle.get(stableIds.intentId)?.state).toBe("LIVE");
      expect(restarted.ledger.snapshot().reservedBuyCash).toBe("4.2");

      await expect(
        restarted.shutdown({
          ...exchangeSnapshot,
          evidenceId: "shutdown-rest-live",
          capturedAtMs: 3_000,
        }),
      ).rejects.toThrow("shutdown is incomplete while order remainders remain");
      expect(restarted.lifecycle.unresolved()).toHaveLength(1);
      expect(
        restarted.journal
          .records()
          .some(
            record =>
              record.kind === "reconciliation_completed" &&
              record.payload.trigger === "SHUTDOWN",
          ),
      ).toBe(true);
      await restarted.journal.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refuses a false-complete shutdown with unresolved commands/remainders", async () => {
    const journal = new MemoryJournal();
    const lifecycle = new OrderLifecycleManager(journal);
    const stableIds = await createOrder(lifecycle);
    const outbox = new ExecutionOutbox(journal);
    await outbox.enqueue({
      executionCommandId: stableIds.executionCommandId,
      intentId: stableIds.intentId,
      clientCorrelationId: stableIds.clientCorrelationId,
      kind: "SUBMIT",
      payload: {},
    });
    const ledger = new LotLedger("100", journal);
    const reconciliation = new ReconciliationService(
      journal,
      outbox,
      lifecycle,
    );
    const result = await reconciliation.reconcile(
      "SHUTDOWN",
      ledger.snapshot(),
      {
        evidenceId: "rest-1",
        capturedAtMs: 100,
        cashBalance: "100",
        tokenBalances: {},
        openExchangeOrderIds: [],
        pendingTradeIds: [],
        reserveSemantics: {
          cash: "BALANCE_INCLUDES_RESERVED",
          tokens: "BALANCE_INCLUDES_RESERVED",
        },
      },
    );
    expect(result.valid).toBe(false);
    expect(() => reconciliation.assertShutdownComplete()).toThrow(
      /incomplete/,
    );
  });
});
