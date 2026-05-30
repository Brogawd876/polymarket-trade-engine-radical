import { 
  type BotAsset, 
  type Clock, 
  RealClock,
  type OrderFlowSnapshot,
  type OrderFlowMonitor,
  type WhaleActivity
} from "../engine/bot-core/data-sources.ts";

export type TradeEvent = {
  assetId: string;
  price: number;
  size: number;
  side: "buy" | "sell";
  ts: number;
};

export type TradeTapeOptions = {
  asset: BotAsset;
  clock?: Clock;
  whaleThresholdUsd?: number;
  window10s?: number;
  window60s?: number;
};

/**
 * TradeTapeTracker calculates real-time Order Flow metrics
 * such as CVD (Cumulative Volume Delta) and OBI (Order Book Imbalance).
 */
export class TradeTapeTracker implements OrderFlowMonitor {
  private asset: BotAsset;
  private clock: Clock;
  private whaleThresholdUsd: number;
  private window10s: number;
  private window60s: number;

  private trades: TradeEvent[] = [];
  private handlers = new Set<(snapshot: OrderFlowSnapshot) => void>();
  
  // Imbalance state (provided by OrderBook externally)
  private imbalanceUp: number | null = null;
  private imbalanceDown: number | null = null;

  constructor(opts: TradeTapeOptions) {
    this.asset = opts.asset;
    this.clock = opts.clock ?? new RealClock();
    this.whaleThresholdUsd = opts.whaleThresholdUsd ?? 5000;
    this.window10s = opts.window10s ?? 10000;
    this.window60s = opts.window60s ?? 60000;
  }

  /** Record a new trade from the websocket */
  recordTrade(event: TradeEvent) {
    this.trades.push(event);
    this._prune();
    this.notify();
  }

  /** Update imbalance from OrderBook state */
  updateImbalance(up: number | null, down: number | null) {
    this.imbalanceUp = up;
    this.imbalanceDown = down;
    this.notify();
  }

  latest(): OrderFlowSnapshot {
    const now = this.clock.nowMs();
    const cvd10 = this._calculateCVD(now - this.window10s);
    const cvd60 = this._calculateCVD(now - this.window60s);
    const whales = this._getRecentWhales(now - this.window60s);

    return {
      asset: this.asset,
      timestampMs: now,
      source: "public_inferred",
      confidence: "low",
      imbalanceUp: this.imbalanceUp,
      imbalanceDown: this.imbalanceDown,
      cvd10s: cvd10,
      cvd60s: cvd60,
      recentWhales: whales,
      sentiment: this._deriveSentiment(cvd10, this.imbalanceUp)
    };
  }

  subscribe(handler: (snapshot: OrderFlowSnapshot) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private notify() {
    const snap = this.latest();
    for (const handler of this.handlers) {
      handler(snap);
    }
  }

  private _prune() {
    const horizon = this.clock.nowMs() - this.window60s;
    while (this.trades.length > 0 && this.trades[0]!.ts < horizon) {
      this.trades.shift();
    }
  }

  private _calculateCVD(sinceMs: number): { up: number; down: number } {
    let up = 0;
    let down = 0;
    for (const trade of this.trades) {
      if (trade.ts < sinceMs) continue;
      // In Polymarket, "buy" usually means hitting the ask (bullish flow)
      if (trade.side === "buy") up += trade.size * trade.price;
      else down += trade.size * trade.price;
    }
    return { up, down };
  }

  private _getRecentWhales(sinceMs: number): WhaleActivity[] {
    return this.trades
      .filter(t => t.ts >= sinceMs && (t.size * t.price) >= this.whaleThresholdUsd)
      .map(t => ({
        ts: t.ts,
        side: t.side,
        price: t.price,
        shares: t.size,
        notionalUsd: t.size * t.price
      }));
  }

  private _deriveSentiment(cvd: { up: number; down: number }, imbalance: number | null): "bullish" | "bearish" | "neutral" {
    const delta = cvd.up - cvd.down;
    const imb = imbalance ?? 0;
    
    if (delta > 0 && imb > 0.2) return "bullish";
    if (delta < 0 && imb < -0.2) return "bearish";
    return "neutral";
  }
}
