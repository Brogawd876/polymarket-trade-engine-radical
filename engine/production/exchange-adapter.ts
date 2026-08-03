import type { OrderLifecycleManager } from "./order-lifecycle.ts";
import type { ExecutionCommand, ExecutionOutbox } from "./outbox.ts";
import type { LotLedger } from "./ledger.ts";

export type ExchangeFillEvidence = {
  tradeId: string;
  quantity: string;
  price?: string;
  fee?: string;
  makerTaker?: "MAKER" | "TAKER";
  sourceTimestampMs?: number;
  ingestTimestampMs?: number;
  transactionHash?: string;
};

export type ExchangeOrderEvidence = {
  clientCorrelationId: string;
  exchangeOrderId?: string;
  status:
    | "LIVE"
    | "MATCHED"
    | "DELAYED"
    | "PARTIALLY_FILLED"
    | "FILLED"
    | "CANCELED"
    | "REJECTED";
  fills: ExchangeFillEvidence[];
  error?: string;
};

export interface CurrentClobTransport {
  submit(command: ExecutionCommand): Promise<ExchangeOrderEvidence>;
  cancel(command: ExecutionCommand): Promise<ExchangeOrderEvidence>;
  /**
   * Resolve an ambiguous request using open orders, order queries, and trades.
   * It must not infer absence from a single eventually-consistent endpoint.
   */
  reconcileCommand(
    command: ExecutionCommand,
  ): Promise<ExchangeOrderEvidence | null>;
}

export type CommandResolution = {
  resolved: boolean;
  evidence: ExchangeOrderEvidence | null;
};

export class CurrentClobExecutionAdapter {
  constructor(
    private readonly transport: CurrentClobTransport,
    private readonly outbox: ExecutionOutbox,
    private readonly lifecycle: OrderLifecycleManager,
    private readonly ledger?: LotLedger,
    private readonly nowMs: () => number = Date.now,
  ) {}

  async execute(executionCommandId: string): Promise<CommandResolution> {
    const command = this.outbox.get(executionCommandId);
    if (!command) throw new Error(`unknown command ${executionCommandId}`);
    this.outbox.assertCanSubmit(executionCommandId);
    const order = this.lifecycle.get(command.intentId);
    if (!order) throw new Error(`command references unknown intent ${command.intentId}`);

    if (command.kind === "SUBMIT") {
      if (order.state !== "OUTBOXED") {
        throw new Error(
          `submission requires OUTBOXED intent, found ${order.state}`,
        );
      }
      await this.lifecycle.transition(command.intentId, "SUBMITTING");
    } else {
      if (
        order.state !== "LIVE" &&
        order.state !== "PARTIALLY_FILLED" &&
        order.state !== "DELAYED" &&
        order.state !== "ACKNOWLEDGED"
      ) {
        throw new Error(`cancel is invalid from ${order.state}`);
      }
      await this.lifecycle.transition(command.intentId, "CANCEL_PENDING");
    }
    await this.outbox.transition(executionCommandId, "SUBMITTING");

    let evidence: ExchangeOrderEvidence;
    try {
      evidence =
        command.kind === "SUBMIT"
          ? await this.transport.submit(command)
          : await this.transport.cancel(command);
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : String(error);
      await this.outbox.transition(executionCommandId, "AMBIGUOUS", {
        error: reason,
      });
      if (command.kind === "SUBMIT") {
        await this.lifecycle.transition(command.intentId, "UNRESOLVED", {
          reason,
        });
      } else {
        await this.lifecycle.transition(command.intentId, "UNRESOLVED", {
          reason: `cancel outcome unresolved: ${reason}`,
        });
      }
      const ambiguous = this.outbox.get(executionCommandId)!;
      const reconciled = await this.transport.reconcileCommand(ambiguous);
      if (!reconciled) {
        return { resolved: false, evidence: null };
      }
      evidence = reconciled;
    }

    await this.applyEvidence(executionCommandId, command, evidence);
    return { resolved: true, evidence };
  }

  async reconcileAmbiguous(
    executionCommandId: string,
  ): Promise<CommandResolution> {
    const command = this.outbox.get(executionCommandId);
    if (!command) throw new Error(`unknown command ${executionCommandId}`);
    if (command.state !== "AMBIGUOUS") {
      throw new Error(`command ${executionCommandId} is not ambiguous`);
    }
    const evidence = await this.transport.reconcileCommand(command);
    if (!evidence) return { resolved: false, evidence: null };
    await this.applyEvidence(executionCommandId, command, evidence);
    return { resolved: true, evidence };
  }

  /**
   * Apply a later user-channel/REST update to an already acknowledged command.
   * Trade IDs are idempotent in both lifecycle and ledger authorities.
   */
  async applyExternalEvidence(
    executionCommandId: string,
    evidence: ExchangeOrderEvidence,
  ): Promise<void> {
    const command = this.outbox.get(executionCommandId);
    if (!command) throw new Error(`unknown command ${executionCommandId}`);
    await this.applyOrderEvidence(command, evidence);
  }

  private async applyEvidence(
    executionCommandId: string,
    command: ExecutionCommand,
    evidence: ExchangeOrderEvidence,
  ): Promise<void> {
    if (evidence.clientCorrelationId !== command.clientCorrelationId) {
      throw new Error("exchange evidence correlation mismatch");
    }
    if (evidence.status !== "REJECTED" && !evidence.exchangeOrderId) {
      throw new Error("exchange evidence is missing order id");
    }

    await this.outbox.transition(executionCommandId, "ACKNOWLEDGED", {
      exchangeOrderId: evidence.exchangeOrderId,
      error: evidence.error,
    });
    const current = this.lifecycle.get(command.intentId)!;
    if (current.state === "SUBMITTING" || current.state === "UNRESOLVED") {
      await this.lifecycle.transition(command.intentId, "ACKNOWLEDGED", {
        exchangeOrderId: evidence.exchangeOrderId,
        reason: evidence.error,
      });
    }

    await this.applyOrderEvidence(command, evidence);
    await this.outbox.transition(executionCommandId, "RESOLVED", {
      exchangeOrderId: evidence.exchangeOrderId,
      error: evidence.error,
    });
  }

  private async applyOrderEvidence(
    command: ExecutionCommand,
    evidence: ExchangeOrderEvidence,
  ): Promise<void> {
    if (evidence.clientCorrelationId !== command.clientCorrelationId) {
      throw new Error("exchange evidence correlation mismatch");
    }
    const before = this.lifecycle.get(command.intentId);
    if (!before) throw new Error(`unknown intent ${command.intentId}`);
    if (
      before.exchangeOrderId &&
      evidence.exchangeOrderId &&
      before.exchangeOrderId !== evidence.exchangeOrderId
    ) {
      throw new Error("exchange evidence order id mismatch");
    }
    for (const fill of evidence.fills) {
      if (this.ledger) {
        const marketId = String(command.payload.marketId ?? "");
        const tokenId = String(command.payload.tokenId ?? "");
        const side = command.payload.side;
        if (
          !marketId ||
          !tokenId ||
          (side !== "BUY" && side !== "SELL")
        ) {
          throw new Error(
            "ledger-authoritative evidence requires marketId, tokenId, and side",
          );
        }
        const ingestTimestampMs = fill.ingestTimestampMs ?? this.nowMs();
        await this.ledger.applyFill({
          orderId: command.intentId,
          tradeId: fill.tradeId,
          marketId,
          tokenId,
          side,
          price: fill.price ?? String(command.payload.price),
          quantity: fill.quantity,
          fee: fill.fee ?? "0",
          makerTaker:
            fill.makerTaker ??
            (command.payload.postOnly === true ? "MAKER" : "TAKER"),
          sourceTimestampMs: fill.sourceTimestampMs ?? ingestTimestampMs,
          ingestTimestampMs,
        });
      }
      await this.lifecycle.applyFill({
        intentId: command.intentId,
        tradeId: fill.tradeId,
        quantity: fill.quantity,
        transactionHash: fill.transactionHash,
      });
    }

    const afterFills = this.lifecycle.get(command.intentId)!;
    if (afterFills.state !== "FILLED") {
      switch (evidence.status) {
        case "LIVE":
          if (afterFills.state !== "LIVE") {
            await this.lifecycle.transition(command.intentId, "LIVE");
          }
          break;
        case "MATCHED":
          if (afterFills.state !== "MATCHED") {
            await this.lifecycle.transition(command.intentId, "MATCHED");
          }
          break;
        case "DELAYED":
          if (afterFills.state !== "DELAYED") {
            await this.lifecycle.transition(command.intentId, "DELAYED");
          }
          break;
        case "PARTIALLY_FILLED":
          if (afterFills.state !== "PARTIALLY_FILLED") {
            throw new Error("partial status lacks fill evidence");
          }
          break;
        case "FILLED":
          throw new Error("filled status does not account for requested quantity");
        case "CANCELED":
          if (afterFills.state !== "CANCEL_PENDING") {
            await this.lifecycle.transition(command.intentId, "CANCEL_PENDING");
          }
          await this.lifecycle.transition(command.intentId, "CANCELED");
          break;
        case "REJECTED":
          await this.lifecycle.transition(command.intentId, "REJECTED", {
            reason: evidence.error ?? "exchange rejected order",
          });
          break;
      }
    }
    const terminal = this.lifecycle.get(command.intentId)!;
    if (
      this.ledger &&
      (terminal.state === "CANCELED" ||
        terminal.state === "REJECTED" ||
        terminal.state === "FILLED")
    ) {
      await this.ledger.releaseReservation(
        command.intentId,
        `exchange evidence reached ${terminal.state}`,
      );
    }
  }
}
