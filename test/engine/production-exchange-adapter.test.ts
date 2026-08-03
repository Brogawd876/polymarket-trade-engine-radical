import { describe, expect, test } from "bun:test";
import { CurrentClobExecutionAdapter, type CurrentClobTransport } from "../../engine/production/exchange-adapter.ts";
import { MemoryJournal } from "../../engine/production/journal.ts";
import { OrderLifecycleManager } from "../../engine/production/order-lifecycle.ts";
import { ExecutionOutbox } from "../../engine/production/outbox.ts";

async function harness(transport: CurrentClobTransport) {
  const journal = new MemoryJournal();
  const lifecycle = new OrderLifecycleManager(journal);
  const outbox = new ExecutionOutbox(journal);
  const ids = {
    runId: "run-1",
    marketId: "market-1",
    candidateId: "candidate-1",
    decisionId: "decision-1",
    intentId: "intent-1",
    riskDecisionId: "risk-1",
    executionCommandId: "command-1",
    clientCorrelationId: "correlation-1",
  };
  await lifecycle.createIntent({
    ids,
    tokenId: "UP",
    side: "BUY",
    orderType: "GTC",
    postOnly: true,
    price: "0.42",
    requestedQuantity: "10",
  });
  await lifecycle.transition(ids.intentId, "RISK_APPROVED");
  await outbox.enqueue({
    executionCommandId: ids.executionCommandId,
    intentId: ids.intentId,
    clientCorrelationId: ids.clientCorrelationId,
    kind: "SUBMIT",
    payload: { postOnly: true },
  });
  await lifecycle.transition(ids.intentId, "OUTBOXED");
  return {
    journal,
    lifecycle,
    outbox,
    ids,
    adapter: new CurrentClobExecutionAdapter(transport, outbox, lifecycle),
  };
}

describe("current CLOB execution adapter", () => {
  test("recovers exchange acceptance that occurred before local acknowledgement", async () => {
    let submissions = 0;
    const h = await harness({
      async submit() {
        submissions += 1;
        throw new Error("connection reset after request body");
      },
      async cancel() {
        throw new Error("unused");
      },
      async reconcileCommand(command) {
        return {
          clientCorrelationId: command.clientCorrelationId,
          exchangeOrderId: "exchange-1",
          status: "LIVE",
          fills: [],
        };
      },
    });
    const result = await h.adapter.execute(h.ids.executionCommandId);
    expect(result.resolved).toBe(true);
    expect(submissions).toBe(1);
    expect(h.lifecycle.get(h.ids.intentId)?.state).toBe("LIVE");
    expect(h.outbox.get(h.ids.executionCommandId)?.state).toBe("RESOLVED");
  });

  test("keeps an unproven ambiguous submission unresolved and blocks retry", async () => {
    const h = await harness({
      async submit() {
        throw new Error("timeout");
      },
      async cancel() {
        throw new Error("unused");
      },
      async reconcileCommand() {
        return null;
      },
    });
    const result = await h.adapter.execute(h.ids.executionCommandId);
    expect(result.resolved).toBe(false);
    expect(h.lifecycle.get(h.ids.intentId)?.state).toBe("UNRESOLVED");
    expect(() => h.outbox.assertCanSubmit(h.ids.executionCommandId)).toThrow(
      /requires reconciliation/,
    );
  });

  test("resolves REST eventual consistency later without a second submission", async () => {
    let submissions = 0;
    let reconciliations = 0;
    const h = await harness({
      async submit() {
        submissions += 1;
        throw new Error("request timed out after body write");
      },
      async cancel() {
        throw new Error("unused");
      },
      async reconcileCommand(command) {
        reconciliations += 1;
        if (reconciliations === 1) return null;
        return {
          clientCorrelationId: command.clientCorrelationId,
          exchangeOrderId: "exchange-eventual-1",
          status: "LIVE",
          fills: [],
        };
      },
    });

    const first = await h.adapter.execute(h.ids.executionCommandId);
    expect(first.resolved).toBe(false);
    expect(submissions).toBe(1);
    expect(h.outbox.get(h.ids.executionCommandId)?.state).toBe("AMBIGUOUS");
    expect(h.lifecycle.get(h.ids.intentId)?.state).toBe("UNRESOLVED");

    const recovered = await h.adapter.reconcileAmbiguous(
      h.ids.executionCommandId,
    );
    expect(recovered.resolved).toBe(true);
    expect(submissions).toBe(1);
    expect(reconciliations).toBe(2);
    expect(h.outbox.get(h.ids.executionCommandId)?.state).toBe("RESOLVED");
    expect(h.lifecycle.get(h.ids.intentId)?.state).toBe("LIVE");
    expect(
      h.journal.records().some(
        record =>
          record.kind === "execution_command_state_changed" &&
          record.payload.state === "AMBIGUOUS",
      ),
    ).toBe(true);
  });

  test("records a post-only rejection as exchange evidence", async () => {
    const h = await harness({
      async submit(command) {
        return {
          clientCorrelationId: command.clientCorrelationId,
          status: "REJECTED",
          fills: [],
          error: "post-only order would cross",
        };
      },
      async cancel() {
        throw new Error("unused");
      },
      async reconcileCommand() {
        return null;
      },
    });
    await h.adapter.execute(h.ids.executionCommandId);
    expect(h.lifecycle.get(h.ids.intentId)?.state).toBe("REJECTED");
    expect(h.lifecycle.get(h.ids.intentId)?.reason).toMatch(/post-only/);
  });

  test("deduplicates a repeated acknowledgement update without lifecycle churn", async () => {
    const evidence = {
      clientCorrelationId: "correlation-1",
      exchangeOrderId: "exchange-duplicate-ack",
      status: "LIVE" as const,
      fills: [],
    };
    const h = await harness({
      async submit() {
        return evidence;
      },
      async cancel() {
        throw new Error("unused");
      },
      async reconcileCommand() {
        return null;
      },
    });
    await h.adapter.execute(h.ids.executionCommandId);
    const liveTransitionsBefore = h.journal.records().filter(
      record =>
        record.kind === "order_state_changed" &&
        record.payload.state === "LIVE",
    ).length;

    await h.adapter.applyExternalEvidence(
      h.ids.executionCommandId,
      evidence,
    );

    expect(h.lifecycle.get(h.ids.intentId)?.state).toBe("LIVE");
    expect(h.outbox.get(h.ids.executionCommandId)?.state).toBe("RESOLVED");
    expect(
      h.journal.records().filter(
        record =>
          record.kind === "order_state_changed" &&
          record.payload.state === "LIVE",
      ),
    ).toHaveLength(liveTransitionsBefore);
  });

  test("retains the live remainder from an immediate partial execution", async () => {
    const h = await harness({
      async submit(command) {
        return {
          clientCorrelationId: command.clientCorrelationId,
          exchangeOrderId: "exchange-1",
          status: "PARTIALLY_FILLED",
          fills: [{ tradeId: "trade-1", quantity: "4" }],
        };
      },
      async cancel() {
        throw new Error("unused");
      },
      async reconcileCommand() {
        return null;
      },
    });
    await h.adapter.execute(h.ids.executionCommandId);
    expect(h.lifecycle.get(h.ids.intentId)?.state).toBe("PARTIALLY_FILLED");
    expect(h.lifecycle.get(h.ids.intentId)?.remainingQuantity).toBe("6");
  });
});
