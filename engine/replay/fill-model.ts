import type { BookLevel } from "../event-store/events.ts";

export type FillModelOrder = {
  orderId?: string;
  action: "buy" | "sell";
  side: "UP" | "DOWN";
  price: number;
  shares: number;
  orderType?: "GTC" | "GTD" | "FOK" | "FAK";
  queuePosition?: number | null;
};

export type FillModelBook = {
  bids: BookLevel[];
  asks: BookLevel[];
  lastTradePrice?: number | null;
  lastTradeSize?: number | null;
  lastTradeTs?: number | null;
};

export type FillModelResult = {
  filled: boolean;
  filledShares: number;
  fillProbability: number;
  makerTaker: "maker" | "taker" | "unknown";
  sizeAheadEstimate: number | null;
  reason: string;
};

export type ConservativeMakerFillOptions = {
  unknownQueueFillProbability?: number;
  requireTradeThrough?: boolean;
};

export class ConservativeMakerFillModel {
  readonly version = "conservative-maker-v1";
  private readonly unknownQueueFillProbability: number;
  private readonly requireTradeThrough: boolean;

  constructor(opts: ConservativeMakerFillOptions = {}) {
    this.unknownQueueFillProbability = opts.unknownQueueFillProbability ?? 0;
    this.requireTradeThrough = opts.requireTradeThrough ?? true;
  }

  evaluate(order: FillModelOrder, book: FillModelBook): FillModelResult {
    const makerTaker = classifyMakerTaker(order, book);
    if (makerTaker === "taker") return this.evaluateTaker(order, book);

    const sizeAheadEstimate = estimateSizeAhead(order, book);
    const tradeThrough = didTradeThrough(order, book);
    const touched = didTouch(order, book);

    if (tradeThrough) {
      return {
        filled: true,
        filledShares: order.shares,
        fillProbability: 1,
        makerTaker: "maker",
        sizeAheadEstimate,
        reason: "trade-through crossed resting maker price",
      };
    }

    if (touched && !this.requireTradeThrough && sizeAheadEstimate !== null && sizeAheadEstimate <= 0) {
      return {
        filled: true,
        filledShares: order.shares,
        fillProbability: 0.5,
        makerTaker: "maker",
        sizeAheadEstimate,
        reason: "touch fill allowed with no estimated size ahead",
      };
    }

    return {
      filled: false,
      filledShares: 0,
      fillProbability:
        sizeAheadEstimate === null ? this.unknownQueueFillProbability : 0,
      makerTaker: makerTaker === "unknown" ? "unknown" : "maker",
      sizeAheadEstimate,
      reason: touched
        ? "touch is not enough for conservative maker fill"
        : "maker order did not trade through",
    };
  }

  private evaluateTaker(order: FillModelOrder, book: FillModelBook): FillModelResult {
    const levels = order.action === "buy" ? book.asks : book.bids;
    let available = 0;
    for (const [price, size] of levels) {
      const crosses =
        order.action === "buy"
          ? price <= order.price + 1e-9
          : price >= order.price - 1e-9;
      if (!crosses) break;
      available += size;
      if (available >= order.shares) break;
    }
    const full = available >= order.shares - 1e-9;
    const partialOk = order.orderType === "FAK";
    const filledShares = full ? order.shares : partialOk ? Math.max(0, available) : 0;
    return {
      filled: filledShares > 0,
      filledShares,
      fillProbability: filledShares > 0 ? 1 : 0,
      makerTaker: "taker",
      sizeAheadEstimate: 0,
      reason: full
        ? "marketable order has enough displayed depth"
        : partialOk && filledShares > 0
          ? "FAK partially fills displayed depth"
          : "insufficient displayed depth for taker fill",
    };
  }
}

export function classifyMakerTaker(
  order: FillModelOrder,
  book: FillModelBook,
): "maker" | "taker" | "unknown" {
  const bestAsk = book.asks[0]?.[0] ?? null;
  const bestBid = book.bids[0]?.[0] ?? null;
  if (order.orderType === "FOK" || order.orderType === "FAK") return "taker";
  if (order.action === "buy" && bestAsk !== null) {
    return order.price >= bestAsk - 1e-9 ? "taker" : "maker";
  }
  if (order.action === "sell" && bestBid !== null) {
    return order.price <= bestBid + 1e-9 ? "taker" : "maker";
  }
  return "unknown";
}

export function estimateSizeAhead(
  order: FillModelOrder,
  book: FillModelBook,
): number | null {
  if (order.queuePosition !== undefined && order.queuePosition !== null) {
    return Math.max(0, order.queuePosition);
  }
  const levels = order.action === "buy" ? book.bids : book.asks;
  const atLevel = levels.find(([price]) => Math.abs(price - order.price) < 1e-9);
  return atLevel ? atLevel[1] : null;
}

function didTouch(order: FillModelOrder, book: FillModelBook): boolean {
  if (
    book.lastTradePrice !== undefined &&
    book.lastTradePrice !== null &&
    Math.abs(book.lastTradePrice - order.price) < 1e-9
  ) {
    return true;
  }
  const bestOpposite =
    order.action === "buy" ? book.asks[0]?.[0] ?? null : book.bids[0]?.[0] ?? null;
  if (bestOpposite === null) return false;
  return order.action === "buy"
    ? bestOpposite <= order.price + 1e-9
    : bestOpposite >= order.price - 1e-9;
}

function didTradeThrough(order: FillModelOrder, book: FillModelBook): boolean {
  const trade = book.lastTradePrice;
  if (trade === undefined || trade === null) return false;
  return order.action === "buy"
    ? trade < order.price - 1e-9
    : trade > order.price + 1e-9;
}
