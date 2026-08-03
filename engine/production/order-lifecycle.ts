import type { AuthoritativeJournal, JournalRecord } from "./journal.ts";
import { formatAtoms, parseAtoms } from "./fixed.ts";

export type LifecycleOrderState =
  | "INTENT_CREATED"
  | "RISK_APPROVED"
  | "OUTBOXED"
  | "SUBMITTING"
  | "UNRESOLVED"
  | "ACKNOWLEDGED"
  | "LIVE"
  | "MATCHED"
  | "DELAYED"
  | "PARTIALLY_FILLED"
  | "CANCEL_PENDING"
  | "CANCELED"
  | "FILLED"
  | "REJECTED"
  | "SETTLED";

export type StableOrderIds = {
  runId: string;
  marketId: string;
  candidateId: string;
  decisionId: string;
  intentId: string;
  riskDecisionId: string;
  executionCommandId: string;
  clientCorrelationId: string;
};

export type OrderLifecycleRecord = {
  ids: StableOrderIds;
  tokenId: string;
  side: "BUY" | "SELL";
  orderType: "GTC" | "FAK" | "FOK";
  postOnly: boolean;
  price: string;
  requestedQuantity: string;
  filledQuantity: string;
  remainingQuantity: string;
  canceledQuantity: string;
  state: LifecycleOrderState;
  exchangeOrderId?: string;
  tradeIds: string[];
  transactionHashes: string[];
  reason?: string;
  updatedAtMs: number;
};

const TERMINAL = new Set<LifecycleOrderState>([
  "CANCELED",
  "FILLED",
  "REJECTED",
  "SETTLED",
]);

const ALLOWED: Record<LifecycleOrderState, ReadonlySet<LifecycleOrderState>> = {
  INTENT_CREATED: new Set(["RISK_APPROVED", "REJECTED"]),
  RISK_APPROVED: new Set(["OUTBOXED", "REJECTED"]),
  OUTBOXED: new Set(["SUBMITTING", "UNRESOLVED", "REJECTED"]),
  SUBMITTING: new Set(["UNRESOLVED", "ACKNOWLEDGED", "REJECTED"]),
  UNRESOLVED: new Set(["ACKNOWLEDGED", "LIVE", "MATCHED", "DELAYED", "PARTIALLY_FILLED", "FILLED", "REJECTED"]),
  ACKNOWLEDGED: new Set(["LIVE", "MATCHED", "DELAYED", "PARTIALLY_FILLED", "CANCEL_PENDING", "CANCELED", "FILLED", "REJECTED"]),
  LIVE: new Set(["MATCHED", "DELAYED", "PARTIALLY_FILLED", "CANCEL_PENDING", "CANCELED", "FILLED"]),
  MATCHED: new Set(["DELAYED", "PARTIALLY_FILLED", "FILLED"]),
  DELAYED: new Set(["MATCHED", "PARTIALLY_FILLED", "FILLED", "CANCEL_PENDING"]),
  PARTIALLY_FILLED: new Set(["PARTIALLY_FILLED", "CANCEL_PENDING", "CANCELED", "FILLED", "DELAYED"]),
  CANCEL_PENDING: new Set(["PARTIALLY_FILLED", "CANCELED", "FILLED", "UNRESOLVED"]),
  CANCELED: new Set(["SETTLED"]),
  FILLED: new Set(["SETTLED"]),
  REJECTED: new Set([]),
  SETTLED: new Set([]),
};

export class OrderLifecycleManager {
  private readonly orders = new Map<string, OrderLifecycleRecord>();
  private readonly seenTrades = new Set<string>();

  constructor(
    private readonly journal: AuthoritativeJournal,
    private readonly nowMs: () => number = Date.now,
  ) {}

  async createIntent(input: Omit<OrderLifecycleRecord, "filledQuantity" | "remainingQuantity" | "canceledQuantity" | "state" | "tradeIds" | "transactionHashes" | "updatedAtMs">): Promise<OrderLifecycleRecord> {
    if (this.orders.has(input.ids.intentId)) {
      throw new Error(`duplicate intent ${input.ids.intentId}`);
    }
    const requested = parseAtoms(input.requestedQuantity);
    if (requested <= 0n) throw new Error("requested quantity must be positive");
    if (parseAtoms(input.price) <= 0n) throw new Error("order price must be positive");
    const record: OrderLifecycleRecord = {
      ...input,
      filledQuantity: "0",
      remainingQuantity: formatAtoms(requested),
      canceledQuantity: "0",
      state: "INTENT_CREATED",
      tradeIds: [],
      transactionHashes: [],
      updatedAtMs: this.nowMs(),
    };
    await this.append("order_intent_created", record);
    this.orders.set(input.ids.intentId, record);
    return structuredClone(record);
  }

  async transition(
    intentId: string,
    next: LifecycleOrderState,
    details: {
      exchangeOrderId?: string;
      transactionHash?: string;
      reason?: string;
    } = {},
  ): Promise<OrderLifecycleRecord> {
    const current = this.require(intentId);
    if (current.state === next && next !== "PARTIALLY_FILLED") {
      return structuredClone(current);
    }
    if (!ALLOWED[current.state].has(next)) {
      throw new Error(
        `illegal order transition ${intentId}: ${current.state} -> ${next}`,
      );
    }
    const updated: OrderLifecycleRecord = {
      ...current,
      state: next,
      canceledQuantity:
        next === "CANCELED"
          ? formatAtoms(
              parseAtoms(current.canceledQuantity) +
                parseAtoms(current.remainingQuantity),
            )
          : current.canceledQuantity,
      remainingQuantity:
        next === "CANCELED" ? "0" : current.remainingQuantity,
      exchangeOrderId: details.exchangeOrderId ?? current.exchangeOrderId,
      transactionHashes: details.transactionHash
        ? [...new Set([...current.transactionHashes, details.transactionHash])]
        : current.transactionHashes,
      reason: details.reason,
      updatedAtMs: this.nowMs(),
    };
    await this.append("order_state_changed", updated);
    this.orders.set(intentId, updated);
    return structuredClone(updated);
  }

  async applyFill(input: {
    intentId: string;
    tradeId: string;
    quantity: string;
    transactionHash?: string;
  }): Promise<OrderLifecycleRecord> {
    if (this.seenTrades.has(input.tradeId)) {
      return structuredClone(this.require(input.intentId));
    }
    const current = this.require(input.intentId);
    if (current.state === "REJECTED" || current.state === "SETTLED") {
      throw new Error(`cannot apply fill to ${current.state} order ${input.intentId}`);
    }
    const fill = parseAtoms(input.quantity);
    const remaining = parseAtoms(current.remainingQuantity);
    if (fill <= 0n) throw new Error("fill quantity must be positive");
    if (fill > remaining) {
      throw new Error(
        `fill exceeds remaining quantity for ${input.intentId}: ${input.quantity} > ${current.remainingQuantity}`,
      );
    }
    const nextRemaining = remaining - fill;
    const nextFilled = parseAtoms(current.filledQuantity) + fill;
    const nextState: LifecycleOrderState =
      nextRemaining === 0n ? "FILLED" : "PARTIALLY_FILLED";
    const updated: OrderLifecycleRecord = {
      ...current,
      filledQuantity: formatAtoms(nextFilled),
      remainingQuantity: formatAtoms(nextRemaining),
      state: nextState,
      tradeIds: [...current.tradeIds, input.tradeId],
      transactionHashes: input.transactionHash
        ? [...new Set([...current.transactionHashes, input.transactionHash])]
        : current.transactionHashes,
      updatedAtMs: this.nowMs(),
    };
    await this.append("order_fill_applied", updated, { tradeId: input.tradeId });
    this.seenTrades.add(input.tradeId);
    this.orders.set(input.intentId, updated);
    return structuredClone(updated);
  }

  restore(records: readonly OrderLifecycleRecord[]): void {
    for (const record of records) {
      if (this.orders.has(record.ids.intentId)) {
        throw new Error(`duplicate restored intent ${record.ids.intentId}`);
      }
      this.orders.set(record.ids.intentId, structuredClone(record));
      for (const tradeId of record.tradeIds) this.seenTrades.add(tradeId);
    }
  }

  restoreFromJournal(records: readonly JournalRecord[]): void {
    const latest = new Map<string, OrderLifecycleRecord>();
    for (const event of records) {
      if (
        event.kind !== "order_intent_created" &&
        event.kind !== "order_state_changed" &&
        event.kind !== "order_fill_applied"
      ) {
        continue;
      }
      latest.set(
        event.aggregateId,
        structuredClone(event.payload) as OrderLifecycleRecord,
      );
    }
    this.restore([...latest.values()]);
  }

  get(intentId: string): OrderLifecycleRecord | null {
    const order = this.orders.get(intentId);
    return order ? structuredClone(order) : null;
  }

  all(): OrderLifecycleRecord[] {
    return [...this.orders.values()].map((order) => structuredClone(order));
  }

  unresolved(): OrderLifecycleRecord[] {
    return this.all().filter((order) => !TERMINAL.has(order.state));
  }

  private require(intentId: string): OrderLifecycleRecord {
    const order = this.orders.get(intentId);
    if (!order) throw new Error(`unknown intent ${intentId}`);
    return order;
  }

  private async append(
    kind: string,
    order: OrderLifecycleRecord,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.journal.append({
      kind,
      aggregateId: order.ids.intentId,
      payload: { ...structuredClone(order), ...extra },
    });
  }
}
