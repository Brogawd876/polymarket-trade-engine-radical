import type {
  CurrentClobTransport,
  ExchangeOrderEvidence,
} from "./exchange-adapter.ts";
import { formatAtoms, minAtoms, parseAtoms } from "./fixed.ts";
import type { ExecutionCommand } from "./outbox.ts";

export type QueueScenario = "PESSIMISTIC" | "NEUTRAL" | "OPTIMISTIC";

export type ReplayLatencyProfile = {
  name: "MEASURED_NORMAL" | "MEASURED_HOME_VPN" | "ELEVATED_STRESS";
  submissionMs: number;
  acknowledgementMs: number;
  cancellationMs: number;
  feedMs: number;
  disconnectRecoveryMs: number;
};

export type ReplayBook = {
  tokenId: string;
  bids: Array<{ price: string; quantity: string }>;
  asks: Array<{ price: string; quantity: string }>;
};

export type ReplayTrade = {
  tradeId: string;
  tokenId: string;
  aggressorSide: "BUY" | "SELL";
  price: string;
  quantity: string;
  sourceTimestampMs: number;
  ingestTimestampMs: number;
};

type FakeOrder = {
  clientCorrelationId: string;
  exchangeOrderId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  orderType: "GTC" | "FAK" | "FOK";
  postOnly: boolean;
  priceAtoms: bigint;
  requestedAtoms: bigint;
  remainingAtoms: bigint;
  queueAheadAtoms: bigint;
  activationAtMs: number;
  status: ExchangeOrderEvidence["status"];
  fills: ExchangeOrderEvidence["fills"];
};

const QUEUE_MULTIPLIERS: Record<QueueScenario, [bigint, bigint]> = {
  PESSIMISTIC: [3n, 2n],
  NEUTRAL: [1n, 1n],
  OPTIMISTIC: [0n, 1n],
};

export class DeterministicFakeExchange implements CurrentClobTransport {
  private readonly books = new Map<string, ReplayBook>();
  private readonly orders = new Map<string, FakeOrder>();
  private orderSequence = 0;
  private fillSequence = 0;
  private disconnectedUntilMs = 0;

  constructor(
    private readonly scenario: QueueScenario,
    readonly latency: ReplayLatencyProfile,
    private readonly nowMs: () => number,
  ) {
    for (const value of Object.values(latency)) {
      if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) {
        throw new Error("latency profile values must be finite and non-negative");
      }
    }
  }

  setBook(book: ReplayBook): void {
    for (const level of [...book.bids, ...book.asks]) {
      parseAtoms(level.price);
      parseAtoms(level.quantity);
    }
    this.books.set(book.tokenId, structuredClone(book));
  }

  disconnect(): void {
    this.disconnectedUntilMs =
      this.nowMs() + this.latency.disconnectRecoveryMs;
  }

  async submit(command: ExecutionCommand): Promise<ExchangeOrderEvidence> {
    this.assertConnected();
    const payload = this.parseSubmitPayload(command);
    const book = this.books.get(payload.tokenId);
    if (!book) throw new Error(`missing book for ${payload.tokenId}`);

    const exchangeOrderId = `fake-order-${++this.orderSequence}`;
    const crosses = this.crosses(payload.side, payload.priceAtoms, book);
    if (payload.postOnly && crosses) {
      return {
        clientCorrelationId: command.clientCorrelationId,
        status: "REJECTED",
        fills: [],
        error: "post-only order would immediately match",
      };
    }
    if (payload.orderType === "FAK" || payload.orderType === "FOK") {
      const executable = this.walkExecutable(
        payload.side,
        payload.priceAtoms,
        book,
      );
      if (
        payload.orderType === "FOK" &&
        executable < payload.requestedAtoms
      ) {
        return {
          clientCorrelationId: command.clientCorrelationId,
          status: "REJECTED",
          fills: [],
          error: "FOK requires immediate full execution",
        };
      }
      const filled = minAtoms(executable, payload.requestedAtoms);
      if (filled === 0n) {
        return {
          clientCorrelationId: command.clientCorrelationId,
          status: "CANCELED",
          exchangeOrderId,
          fills: [],
        };
      }
      return {
        clientCorrelationId: command.clientCorrelationId,
        exchangeOrderId,
        status:
          filled === payload.requestedAtoms ? "FILLED" : "PARTIALLY_FILLED",
        fills: [
          {
            tradeId: `fake-fill-${++this.fillSequence}`,
            quantity: formatAtoms(filled),
            price: formatAtoms(payload.priceAtoms),
            fee: "0",
            makerTaker: "TAKER",
            sourceTimestampMs: this.nowMs(),
            ingestTimestampMs: this.nowMs(),
          },
        ],
      };
    }

    const queueAtPrice = this.quantityAtOwnSide(
      payload.side,
      payload.priceAtoms,
      book,
    );
    const [numerator, denominator] = QUEUE_MULTIPLIERS[this.scenario];
    const order: FakeOrder = {
      clientCorrelationId: command.clientCorrelationId,
      exchangeOrderId,
      tokenId: payload.tokenId,
      side: payload.side,
      orderType: payload.orderType,
      postOnly: payload.postOnly,
      priceAtoms: payload.priceAtoms,
      requestedAtoms: payload.requestedAtoms,
      remainingAtoms: payload.requestedAtoms,
      queueAheadAtoms: (queueAtPrice * numerator) / denominator,
      activationAtMs:
        this.nowMs() +
        this.latency.submissionMs +
        this.latency.acknowledgementMs,
      status: "LIVE",
      fills: [],
    };
    this.orders.set(exchangeOrderId, order);
    return this.evidence(order);
  }

  async cancel(command: ExecutionCommand): Promise<ExchangeOrderEvidence> {
    this.assertConnected();
    const exchangeOrderId = String(command.payload.exchangeOrderId ?? "");
    const order = this.orders.get(exchangeOrderId);
    if (!order) {
      throw new Error(
        `cancel cannot prove absent order ${exchangeOrderId}; reconciliation required`,
      );
    }
    if (this.nowMs() < order.activationAtMs + this.latency.cancellationMs) {
      throw new Error("cancel acknowledgement not yet observable");
    }
    if (order.status !== "FILLED") order.status = "CANCELED";
    return this.evidence(order);
  }

  async reconcileCommand(
    command: ExecutionCommand,
  ): Promise<ExchangeOrderEvidence | null> {
    const order = [...this.orders.values()].find(
      (candidate) =>
        candidate.clientCorrelationId === command.clientCorrelationId ||
        candidate.exchangeOrderId === command.exchangeOrderId ||
        candidate.exchangeOrderId === command.payload.exchangeOrderId,
    );
    return order ? this.evidence(order) : null;
  }

  applyTrade(trade: ReplayTrade): ExchangeOrderEvidence[] {
    this.assertConnected();
    if (trade.ingestTimestampMs < trade.sourceTimestampMs) {
      throw new Error("trade ingestion precedes source time");
    }
    let volume = parseAtoms(trade.quantity);
    const tradePrice = parseAtoms(trade.price);
    const results: ExchangeOrderEvidence[] = [];
    const candidates = [...this.orders.values()]
      .filter(
        (order) =>
          order.tokenId === trade.tokenId &&
          order.status !== "FILLED" &&
          order.status !== "CANCELED" &&
          order.status !== "REJECTED" &&
          order.activationAtMs <= trade.ingestTimestampMs + this.latency.feedMs &&
          ((order.side === "BUY" && trade.aggressorSide === "SELL") ||
            (order.side === "SELL" && trade.aggressorSide === "BUY")),
      )
      .sort((left, right) =>
        left.exchangeOrderId.localeCompare(right.exchangeOrderId),
      );

    for (const order of candidates) {
      if (volume <= 0n) break;
      const atOrThrough =
        order.side === "BUY"
          ? tradePrice <= order.priceAtoms
          : tradePrice >= order.priceAtoms;
      if (!atOrThrough) continue;
      const tradedThrough =
        order.side === "BUY"
          ? tradePrice < order.priceAtoms
          : tradePrice > order.priceAtoms;
      if (tradedThrough) order.queueAheadAtoms = 0n;
      const queueConsumed = minAtoms(order.queueAheadAtoms, volume);
      order.queueAheadAtoms -= queueConsumed;
      volume -= queueConsumed;
      if (order.queueAheadAtoms > 0n || volume <= 0n) continue;
      const fill = minAtoms(order.remainingAtoms, volume);
      if (fill <= 0n) continue;
      order.remainingAtoms -= fill;
      volume -= fill;
      order.fills.push({
        tradeId: `${trade.tradeId}:${order.exchangeOrderId}:${++this.fillSequence}`,
        quantity: formatAtoms(fill),
        price: formatAtoms(order.priceAtoms),
        fee: "0",
        makerTaker: "MAKER",
        sourceTimestampMs: trade.sourceTimestampMs,
        ingestTimestampMs: trade.ingestTimestampMs,
      });
      order.status =
        order.remainingAtoms === 0n ? "FILLED" : "PARTIALLY_FILLED";
      results.push(this.evidence(order));
    }
    return results;
  }

  snapshot(): Array<{
    exchangeOrderId: string;
    status: ExchangeOrderEvidence["status"];
    remainingQuantity: string;
    queueAhead: string;
    activationAtMs: number;
  }> {
    return [...this.orders.values()].map((order) => ({
      exchangeOrderId: order.exchangeOrderId,
      status: order.status,
      remainingQuantity: formatAtoms(order.remainingAtoms),
      queueAhead: formatAtoms(order.queueAheadAtoms),
      activationAtMs: order.activationAtMs,
    }));
  }

  private parseSubmitPayload(command: ExecutionCommand): {
    tokenId: string;
    side: "BUY" | "SELL";
    orderType: "GTC" | "FAK" | "FOK";
    postOnly: boolean;
    priceAtoms: bigint;
    requestedAtoms: bigint;
  } {
    const tokenId = String(command.payload.tokenId ?? "");
    const side = command.payload.side;
    const orderType = command.payload.orderType;
    const postOnly = command.payload.postOnly === true;
    if (
      !tokenId ||
      (side !== "BUY" && side !== "SELL") ||
      (orderType !== "GTC" &&
        orderType !== "FAK" &&
        orderType !== "FOK")
    ) {
      throw new Error("invalid fake-exchange submission payload");
    }
    return {
      tokenId,
      side,
      orderType,
      postOnly,
      priceAtoms: parseAtoms(String(command.payload.price)),
      requestedAtoms: parseAtoms(String(command.payload.quantity)),
    };
  }

  private crosses(side: "BUY" | "SELL", price: bigint, book: ReplayBook): boolean {
    const opposite = side === "BUY" ? book.asks[0] : book.bids[0];
    if (!opposite) return false;
    const oppositePrice = parseAtoms(opposite.price);
    return side === "BUY" ? price >= oppositePrice : price <= oppositePrice;
  }

  private walkExecutable(
    side: "BUY" | "SELL",
    limitPrice: bigint,
    book: ReplayBook,
  ): bigint {
    const levels = side === "BUY" ? book.asks : book.bids;
    return levels.reduce((sum, level) => {
      const price = parseAtoms(level.price);
      const crosses =
        side === "BUY" ? price <= limitPrice : price >= limitPrice;
      return crosses ? sum + parseAtoms(level.quantity) : sum;
    }, 0n);
  }

  private quantityAtOwnSide(
    side: "BUY" | "SELL",
    price: bigint,
    book: ReplayBook,
  ): bigint {
    const levels = side === "BUY" ? book.bids : book.asks;
    return levels
      .filter((level) => parseAtoms(level.price) === price)
      .reduce((sum, level) => sum + parseAtoms(level.quantity), 0n);
  }

  private evidence(order: FakeOrder): ExchangeOrderEvidence {
    return {
      clientCorrelationId: order.clientCorrelationId,
      exchangeOrderId: order.exchangeOrderId,
      status: order.status,
      fills: structuredClone(order.fills),
    };
  }

  private assertConnected(): void {
    if (this.nowMs() < this.disconnectedUntilMs) {
      throw new Error("fake exchange is disconnected");
    }
  }
}
