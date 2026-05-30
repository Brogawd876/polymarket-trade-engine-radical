import { PriceLevelMap } from "../utils/price-level-map.ts";
import { renderOrderBookTable } from "../utils/orderbook-table.ts";
import { Env } from "../utils/config.ts";
import { type Clock, RealClock } from "../engine/bot-core/data-sources.ts";
import { 
  createReconnectingWs, 
  type ReconnectingWs 
} from "../utils/reconnecting-ws.ts";

import { TradeTapeTracker } from "./trade-tape.ts";

const DEFAULT_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

type OrderLevel = { price: string; size: string };

type BookMessage = {
  asset_id: string;
  bids: OrderLevel[];
  asks: OrderLevel[];
  // first book event always contains tick size
  tick_size?: string;
  event_type: "book";
};

type PriceChangeMessage = {
  price_changes: {
    asset_id: string;
    price: string;
    size: string;
    side: string;
    best_bid: string;
    best_ask: string;
  }[];
  event_type: "price_change";
};

type TickSizeChangeMessage = {
  event_type: "tick_size_change";
  asset_id: string;
  new_tick_size: string;
};

type TradeMessage = {
  event_type: "trades";
  asset_id: string;
  price: string;
  size: string;
  side: "buy" | "sell";
  timestamp: string;
};

type LastTradePriceMessage = {
  event_type: "last_trade_price";
  asset_id: string;
  price: string;
  fee_rate_bps: string;
};

type AssetBook = {
  bids: PriceLevelMap; // desc — best = highest bid
  asks: PriceLevelMap; // asc  — best = lowest ask
};

export class OrderBook {
  private ws?: ReconnectingWs;
  protected _clock: Clock;
  protected assetIds: string[] = ["", ""];
  protected books = new Map<string, AssetBook>();
  protected tickSizes = new Map<string, string>(); // tokenId -> tickSize
  protected feeRates = new Map<string, number>(); // tokenId -> feeRateBps
  protected lastTradePrices = new Map<string, number>(); // tokenId -> price
  protected lastTradeSizes = new Map<string, number>(); // tokenId -> shares
  protected lastTradeTs = new Map<string, number>(); // tokenId -> timestampMs
  private listeners = new Set<() => void>();
  private _isTerminallyBroken = false;
  private _tradeTape?: TradeTapeTracker;

  constructor(clock?: Clock, tradeTape?: TradeTapeTracker) {
    this._clock = clock ?? new RealClock();
    this._tradeTape = tradeTape;
  }

  subscribe(clobTokenIds: string[]) {
    this.destroy();
    this.assetIds = clobTokenIds;
    this.books.clear();
    this.tickSizes.clear();
    this.feeRates.clear();
    this._isTerminallyBroken = false;

    this.ws = createReconnectingWs({
      url: process.env.ORDERBOOK_WS_URL ?? DEFAULT_WS_URL,
      label: "OrderBook",
      onopen: (ws) => {
        ws.send(
          JSON.stringify({
            type: "market",
            assets_ids: this.assetIds,
            custom_feature_enabled: true,
          }),
        );
      },

      onmessage: (event) => this.handleMessage(event),
      isTerminal: (event) => {
        // Code 1006 with no reason often happens on 403 Handshake rejection in some envs,
        // but we'll look for explicit "Forbidden" or known Cloudflare/rejection signals if possible.
        if (event.code === 4003 || event.reason.toLowerCase().includes("forbidden")) {
          this._isTerminallyBroken = true;
          return "Polymarket access appears to be blocked from this network or region (403 Forbidden).";
        }
        return null;
      }
    });
  }

  destroy() {
    if (this.ws) {
      this.ws.destroy();
      this.ws = undefined;
    }
  }

  onUpdate(handler: () => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  protected notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private handleMessage(event: MessageEvent) {
    if (!event.data) return;
    let data;
    try {
      data = JSON.parse(event.data as string);
    } catch (e) {
      console.warn(`[OrderBook] Received non-JSON message: ${event.data}`);
      return;
    }

    // Initial snapshot is an array of book messages
    if (Array.isArray(data)) {
      for (const book of data as BookMessage[]) {
        this.applyBookSnapshot(book);
      }
      this.notify();
      return;
    }

    if (data.event_type === "book") {
      this.applyBookSnapshot(data as BookMessage);
      this._updateTapeImbalance();
    } else if (data.event_type === "price_change") {
      this.applyPriceChange(data as PriceChangeMessage);
      this._updateTapeImbalance();
    } else if (data.event_type === "tick_size_change") {
      const msg = data as TickSizeChangeMessage;
      this.tickSizes.set(msg.asset_id, msg.new_tick_size);
    } else if (data.event_type === "last_trade_price") {
      const msg = data as LastTradePriceMessage;
      this.feeRates.set(msg.asset_id, parseFloat(msg.fee_rate_bps));
      this.lastTradePrices.set(msg.asset_id, parseFloat(msg.price));
      this.lastTradeTs.set(msg.asset_id, this._clock.nowMs());
      this._recordTapeTrade(msg);
    } else if (data.event_type === "trades") {
      const msg = data as TradeMessage;
      const price = parseFloat(msg.price);
      const size = parseFloat(msg.size);
      this.lastTradePrices.set(msg.asset_id, price);
      this.lastTradeSizes.set(msg.asset_id, size);
      this.lastTradeTs.set(msg.asset_id, parseInt(msg.timestamp));
      if (this._tradeTape) {
        this._tradeTape.recordTrade({
          assetId: msg.asset_id,
          price,
          size,
          side: msg.side,
          ts: parseInt(msg.timestamp)
        });
      }
    }
    this.notify();
  }

  protected getOrCreateBook(assetId: string): AssetBook {
    let book = this.books.get(assetId);
    if (!book) {
      book = {
        bids: new PriceLevelMap("desc"),
        asks: new PriceLevelMap("asc"),
      };
      this.books.set(assetId, book);
    }
    return book;
  }

  private applyBookSnapshot(msg: BookMessage) {
    const book = this.getOrCreateBook(msg.asset_id);
    book.bids.clear();
    book.asks.clear();
    for (const level of msg.bids) {
      book.bids.set(parseFloat(level.price), parseFloat(level.size));
    }
    for (const level of msg.asks) {
      book.asks.set(parseFloat(level.price), parseFloat(level.size));
    }
    if (msg.tick_size) {
      // If we have assetIds, assume first two are UP/DOWN for this market
      if (this.assetIds[0]) this.tickSizes.set(this.assetIds[0], msg.tick_size);
      if (this.assetIds[1]) this.tickSizes.set(this.assetIds[1], msg.tick_size);
    }
  }

  private applyPriceChange(msg: PriceChangeMessage) {
    for (const change of msg.price_changes) {
      const book = this.getOrCreateBook(change.asset_id);
      const map = change.side === "BUY" ? book.bids : book.asks;
      const size = parseFloat(change.size);
      if (size === 0) {
        map.delete(parseFloat(change.price));
      } else {
        map.set(parseFloat(change.price), size);
      }
    }
  }

  /**
   * Calculate how many shares you get and the payout for spending `amount` USDC
   * on an asset by walking the ask side of the order book.
   * Each share pays $1 if the outcome is correct.
   *
   * Returns { cost, shares, payout, toWin } or null if no book data.
   */
  private calculateBuy(assetId: string, amount: number) {
    const book = this.books.get(assetId);
    if (!book || book.asks.size === 0) return null;

    let remaining = amount;
    let totalShares = 0;

    for (const [price, size] of book.asks.entries()) {
      if (remaining <= 0) break;
      const costForAll = size * price;

      if (costForAll <= remaining) {
        totalShares += size;
        remaining -= costForAll;
      } else {
        totalShares += remaining / price;
        remaining = 0;
      }
    }

    // ideally remaining should be 0 i.e cost 10$
    // but in low liquidity markets we might not have enough asks
    const cost = amount - remaining;
    const payout = totalShares; // each share pays $1
    const profit = payout - cost;

    return { cost, shares: totalShares, payout, profit };
  }

  /** Get buy calculation for Up (index 0) and Down (index 1) */
  private getNetGain(amount: number) {
    if (this.assetIds.length < 2) return null;

    const up = this.calculateBuy(this.assetIds[0]!, amount);
    const down = this.calculateBuy(this.assetIds[1]!, amount);

    return { up, down };
  }

  private _fmtGain(r: ReturnType<typeof this.calculateBuy>, label: string) {
    if (!r) return `${label}: --`;
    return `${label}: $${r.profit.toFixed(2)}`;
  }

  isReady(): boolean {
    if (this._isTerminallyBroken) return false;
    if (!this.assetIds[0] || !this.assetIds[1]) return false;
    return (
      this.books.has(this.assetIds[0]!) && this.books.has(this.assetIds[1]!)
    );
  }

  /** Resolves once both UP and DOWN books have received their initial snapshot. */
  waitForReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const check = () => {
        if (this._isTerminallyBroken) {
          reject(new Error("OrderBook connection terminally failed (likely geoblocked)."));
          return true;
        }
        if (this.isReady()) {
          resolve();
          return true;
        }
        return false;
      };

      if (check()) return;

      const poll = () => {
        this._clock.setTimeout(() => {
          if (!check()) poll();
        }, 100);
      };
      poll();
    });
  }

  bestBidPrice(side: "UP" | "DOWN"): number | null {
    const assetId = side === "UP" ? this.assetIds[0]! : this.assetIds[1]!;
    return this.books.get(assetId)?.bids.best ?? null;
  }

  bestAskPrice(side: "UP" | "DOWN"): number | null {
    const assetId = side === "UP" ? this.assetIds[0]! : this.assetIds[1]!;
    return this.books.get(assetId)?.asks.best ?? null;
  }

  /** Best bid price and USDC value at that level { price, liquidity } */
  bestBidInfo(
    side: "UP" | "DOWN",
  ): { price: number; liquidity: number } | null {
    const assetId = side === "UP" ? this.assetIds[0]! : this.assetIds[1]!;
    const book = this.books.get(assetId);
    if (!book) return null;
    const price = book.bids.best;
    if (price === null) return null;
    const size = book.bids.get(price) ?? 0;
    return { price, liquidity: price * size };
  }

  getTokenId(side: "UP" | "DOWN"): string {
    return side === "UP" ? this.assetIds[0]! : this.assetIds[1]!;
  }

  /** Tick size for the given asset, or 0.01 if not yet received. */
  getTickSize(assetId: string): string {
    return this.tickSizes.get(assetId) ?? "0.01";
  }

  /** Fee rate in bps for the given asset, or 1000 if not yet received. */
  getFeeRate(assetId: string): number {
    return this.feeRates.get(assetId) ?? 1000;
  }

  /** Best ask price and USDC value at that level { price, liquidity } */
  bestAskInfo(
    side: "UP" | "DOWN",
  ): { price: number; liquidity: number } | null {
    const assetId = side === "UP" ? this.assetIds[0]! : this.assetIds[1]!;
    const book = this.books.get(assetId);
    if (!book) return null;
    const price = book.asks.best;
    if (price === null) return null;
    const size = book.asks.get(price) ?? 0;
    return { price, liquidity: price * size };
  }

  /** Last trade price and size for the given asset. */
  lastTradeInfo(assetId: string): { price: number | null; size: number | null; timestamp: number | null } {
    return {
      price: this.lastTradePrices.get(assetId) ?? null,
      size: this.lastTradeSizes.get(assetId) ?? null,
      timestamp: this.lastTradeTs.get(assetId) ?? null,
    };
  }

  /** Full book entries (bids/asks) for the given asset. */
  getBookLevels(assetId: string): { bids: [number, number][]; asks: [number, number][] } {
    const book = this.books.get(assetId);
    if (!book) return { bids: [], asks: [] };
    return {
      bids: book.bids.top(100),
      asks: book.asks.top(100),
    };
  }

  /** Structured snapshot of both books for logging. */
  getSnapshotData(): {
    up: { bids: [number, number][]; asks: [number, number][] } | null;
    down: { bids: [number, number][]; asks: [number, number][] } | null;
  } {
    const DEPTH = 5;
    const toEntries = (
      map: { top: (n: number) => [number, number][] },
      depth: number,
    ): [number, number][] => map.top(depth).map(([p, s]) => [p, s]);

    const upBook = this.books.get(this.assetIds[0]!);
    const downBook = this.books.get(this.assetIds[1]!);
    return {
      up: upBook
        ? {
            bids: toEntries(upBook.bids, DEPTH),
            asks: toEntries(upBook.asks, DEPTH),
          }
        : null,
      down: downBook
        ? {
            bids: toEntries(downBook.bids, DEPTH),
            asks: toEntries(downBook.asks, DEPTH),
          }
        : null,
    };
  }

  /** Order book depth table + net gain as an array of display lines */
  /** Order book depth table + net gain as an array of display lines */
  getDisplayLines(): string[] {
    const { apiSymbol } = Env.getAssetConfig();
    if (this.assetIds.length < 2)
      return [`${apiSymbol} Order Book: Waiting...`];

    const upBook = this.books.get(this.assetIds[0]!);
    const downBook = this.books.get(this.assetIds[1]!);
    if (!upBook || !downBook) return [`${apiSymbol} Order Book: Waiting...`];

    const DEPTH = 5;
    const fmt = (v: number) => "$" + Math.round(v).toLocaleString();
    const liquidity =
      `UP   Ask: ${fmt(upBook.asks.totalLiquidity)}  Bid: ${fmt(upBook.bids.totalLiquidity)}` +
      `    DOWN   Ask: ${fmt(downBook.asks.totalLiquidity)}  Bid: ${fmt(downBook.bids.totalLiquidity)}`;

    const upFee = this.feeRates.get(this.assetIds[0]!);
    const downFee = this.feeRates.get(this.assetIds[1]!);

    return [
      liquidity,
      "\r",
      ...renderOrderBookTable(
        { bids: upBook.bids.top(DEPTH), asks: upBook.asks.top(DEPTH) },
        { bids: downBook.bids.top(DEPTH), asks: downBook.asks.top(DEPTH) },
        { upFee, downFee },
      ),
    ];
  }

  private _updateTapeImbalance() {
    if (!this._tradeTape || this.assetIds.length < 2) return;
    const up = this.books.get(this.assetIds[0]!);
    const down = this.books.get(this.assetIds[1]!);
    
    const calculateImbalance = (book: AssetBook | undefined) => {
      if (!book) return null;
      const bidVol = book.bids.top(3).reduce((sum, [, size]) => sum + size, 0);
      const askVol = book.asks.top(3).reduce((sum, [, size]) => sum + size, 0);
      if (bidVol + askVol === 0) return 0;
      return (bidVol - askVol) / (bidVol + askVol);
    };

    this._tradeTape.updateImbalance(calculateImbalance(up), calculateImbalance(down));
  }

  private _recordTapeTrade(msg: LastTradePriceMessage) {
    if (!this._tradeTape) return;
    // Polymarket last_trade_price doesn't include side, but price_change often follows.
    // For now we'll mock side as "buy" if price >= bestAsk and "sell" if price <= bestBid.
    const price = parseFloat(msg.price);
    const bestAsk = this.bestAskPrice(msg.asset_id === this.assetIds[0] ? "UP" : "DOWN");
    const bestBid = this.bestBidPrice(msg.asset_id === this.assetIds[0] ? "UP" : "DOWN");
    
    let side: "buy" | "sell" = "buy";
    if (bestBid !== null && price <= bestBid) side = "sell";

    this._tradeTape.recordTrade({
      assetId: msg.asset_id,
      price,
      size: 0, // last_trade_price message doesn't include size in public feed! 
               // Need to wait for user trades or refine with price_change deltas.
      side,
      ts: this._clock.nowMs()
    });
  }
}
