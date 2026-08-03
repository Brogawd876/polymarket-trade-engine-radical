import type { OrderRequest } from "./strategy/types.ts";
import type { EarlyBirdClient, BookSnapshot } from "./client.ts";
import { isSimFilled } from "./client.ts";
import { type Clock, RealClock } from "./bot-core/data-sources.ts";
import { ConservativeMakerFillModel, type FillModelBook } from "./replay/fill-model.ts";
import { 
  createReconnectingWs, 
  type ReconnectingWs 
} from "../utils/reconnecting-ws.ts";

export type ApiCreds = { key: string; secret: string; passphrase: string };

export interface UserChannel {
  /** Start connecting (prod: opens WS + sends auth; sim: starts poll interval). */
  subscribe(conditionId: string): void;
  /** True if the channel is authenticated and listening for events. */
  isReady(): boolean;
  /** Resolves when the channel is ready to receive events (auth confirmed). */
  waitForReady(): Promise<void>;
  /** Track a placed order. Channel calls request.onFilled / request.onFailed. */
  trackOrder(orderId: string, request: OrderRequest): void;
  /**
   * Stop tracking. Subsequent events for this order are silently ignored.
   * Skips matched-but-not-mined orders so an in-flight settlement can still fire onFilled.
   */
  untrackOrder(orderId: string): void;
  /** Sum of matched_amount across MINED trades seen so far (0 if untracked). */
  getMatchedSoFar(orderId: string): number;
  /** True if MATCHED has been received but final MINED settlement is still pending. */
  isMatched(orderId: string): boolean;
  destroy(): void;
}

type Tracked = {
  request: OrderRequest;
  matched: boolean;
  associatedTrades: Set<string>;
  minedAmounts: Map<string, number>; // tradeId -> amount credited to this order
  reportedAmount: number;
};

type OrderEvent = {
  id: string;
  type: string;
  status: string;
  associate_trades?: string[];
};

type TradeEvent = {
  id: string;
  status: string;
  size: string;
  taker_order_id: string;
  maker_orders?: { order_id: string; matched_amount: string }[];
};

abstract class UserChannelBase implements UserChannel {
  protected tracked = new Map<string, Tracked>();
  /** Buffer for MINED trade amounts that arrive before trackOrder or before order MATCHED. */
  private _pendingTradeAmounts = new Map<string, Map<string, number>>();
  /** Buffer for trade IDs that MATCHED before trackOrder. Required for taker
   *  orders, which never receive an order UPDATE MATCHED event — the trade
   *  event is the only signal that the order is filled. */
  private _pendingMatchedTrades = new Map<string, Set<string>>();

  abstract subscribe(conditionId: string): void;
  abstract isReady(): boolean;
  abstract waitForReady(): Promise<void>;
  abstract destroy(): void;

  trackOrder(orderId: string, request: OrderRequest): void {
    const bufferedMined = this._pendingTradeAmounts.get(orderId);
    const bufferedMatched = this._pendingMatchedTrades.get(orderId);
    this.tracked.set(orderId, {
      request,
      matched: (bufferedMatched?.size ?? 0) > 0,
      associatedTrades: bufferedMatched ?? new Set(),
      minedAmounts: bufferedMined ?? new Map(),
      reportedAmount: 0,
    });
    this._pendingTradeAmounts.delete(orderId);
    this._pendingMatchedTrades.delete(orderId);
    this._trySettle(orderId);
  }

  untrackOrder(orderId: string): void {
    const t = this.tracked.get(orderId);
    if (t?.matched) return;
    this.tracked.delete(orderId);
    this._pendingTradeAmounts.delete(orderId);
    this._pendingMatchedTrades.delete(orderId);
  }

  getMatchedSoFar(orderId: string): number {
    const t = this.tracked.get(orderId);
    if (!t) return 0;
    let pending = 0;
    for (const v of t.minedAmounts.values()) pending += v;
    return t.reportedAmount + pending;
  }

  isMatched(orderId: string): boolean {
    return this.tracked.get(orderId)?.matched ?? false;
  }

  protected processOrderEvent(evt: OrderEvent): void {
    const t = this.tracked.get(evt.id);
    if (!t) return;

    if (evt.type === "UPDATE" && evt.status === "MATCHED") {
      t.matched = true;
      for (const tradeId of evt.associate_trades ?? []) {
        t.associatedTrades.add(tradeId);
      }
      this._trySettle(evt.id);
    } else if (evt.type === "CANCELLATION") {
      this.tracked.delete(evt.id);
      t.request.onFailed?.("cancelled");
    }
  }

  protected processTradeEvent(evt: TradeEvent): void {
    if (evt.status === "MATCHED") {
      if (evt.taker_order_id) this._markMatched(evt.taker_order_id, evt.id);
      for (const m of evt.maker_orders ?? []) {
        this._markMatched(m.order_id, evt.id);
      }
      return;
    }

    if (evt.status !== "MINED") return;

    const contributions: Array<[string, number]> = [];

    if (
      evt.taker_order_id &&
      (this.tracked.has(evt.taker_order_id) ||
        this._pendingTradeAmounts.has(evt.taker_order_id) ||
        this._pendingMatchedTrades.has(evt.taker_order_id))
    ) {
      contributions.push([evt.taker_order_id, parseFloat(evt.size)]);
    }

    for (const m of evt.maker_orders ?? []) {
      if (
        this.tracked.has(m.order_id) ||
        this._pendingTradeAmounts.has(m.order_id) ||
        this._pendingMatchedTrades.has(m.order_id)
      ) {
        contributions.push([m.order_id, parseFloat(m.matched_amount)]);
      }
    }

    for (const [orderId, amount] of contributions) {
      const t = this.tracked.get(orderId);
      if (t) {
        t.minedAmounts.set(evt.id, amount);
        this._trySettle(orderId);
      } else {
        let buf = this._pendingTradeAmounts.get(orderId);
        if (!buf) {
          buf = new Map();
          this._pendingTradeAmounts.set(orderId, buf);
        }
        buf.set(evt.id, amount);
      }
    }
  }

  private _markMatched(orderId: string, tradeId: string): void {
    const t = this.tracked.get(orderId);
    if (t) {
      t.matched = true;
      t.associatedTrades.add(tradeId);
      this._trySettle(orderId);
      return;
    }
    let buf = this._pendingMatchedTrades.get(orderId);
    if (!buf) {
      buf = new Set();
      this._pendingMatchedTrades.set(orderId, buf);
    }
    buf.add(tradeId);
  }

  private _trySettle(orderId: string): void {
    const t = this.tracked.get(orderId);
    if (!t || !t.matched) return;
    if (t.minedAmounts.size < t.associatedTrades.size) return;
    let newlyMined = 0;
    for (const v of t.minedAmounts.values()) newlyMined += v;
    if (newlyMined <= 0) return;

    t.reportedAmount += newlyMined;
    t.matched = false;
    t.associatedTrades.clear();
    t.minedAmounts.clear();

    const requested = t.request.req.shares;
    if (t.reportedAmount + 1e-9 >= requested) {
      this.tracked.delete(orderId);
    }
    // Report the incremental fill. A resting GTC stays tracked until its
    // requested quantity is fully mined or a cancellation is confirmed.
    t.request.onFilled?.(newlyMined);
  }
}

const USER_WS_URL =
  "wss://ws-subscriptions-frontend-clob.polymarket.com/ws/user";

export class PolymarketUserChannel extends UserChannelBase {
  private _ws: ReconnectingWs | null = null;
  private _destroyed = false;
  private _conditionId: string | null = null;
  private _pingInterval: any = null;
  private _readyResolve: (() => void) | null = null;
  private _isReady = false;
  private _isTerminallyBroken = false;
  private _ready = new Promise<void>((resolve) => {
    this._readyResolve = resolve;
  });
  private readonly _creds: ApiCreds;
  private readonly _client: EarlyBirdClient;
  private readonly _clock: Clock;

  constructor(opts: { creds: ApiCreds; client: EarlyBirdClient; clock?: Clock }) {
    super();
    this._creds = opts.creds;
    this._client = opts.client;
    this._clock = opts.clock ?? new RealClock();
  }

  subscribe(conditionId: string): void {
    this._conditionId = conditionId;
    this._connect();
  }

  isReady(): boolean {
    return this._isReady;
  }

  waitForReady(): Promise<void> {
    if (this._isTerminallyBroken) {
      return Promise.reject(new Error("UserChannel connection terminally failed (likely geoblocked)."));
    }
    return this._ready;
  }

  private _connect(): void {
    if (this._destroyed) return;

    this._ws = createReconnectingWs({
      url: USER_WS_URL,
      label: "UserChannel",
      onopen: (ws) => {
        this._clearPing();
        ws.send(
          JSON.stringify({
            auth: {
              apiKey: this._creds.key,
              secret: this._creds.secret,
              passphrase: this._creds.passphrase,
            },
            markets: [this._conditionId!],
            type: "user",
          }),
        );
        this._pingInterval = this._clock.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send("PING");
        }, 9_000);
        this._isReady = true;
        this._readyResolve?.();
        this._readyResolve = null;
      },
      onmessage: (event) => {
        const raw = event.data as string;
        if (raw === "PONG") return;
        try {
          const msg = JSON.parse(raw);
          if (msg.event_type === "order")
            this.processOrderEvent(msg as OrderEvent);
          else if (msg.event_type === "trade")
            this.processTradeEvent(msg as TradeEvent);
        } catch (err) {
          console.warn(`[UserChannel] Failed to parse message: ${raw}`, err);
        }
      },
      isTerminal: (event) => {
        if (event.code === 4003 || event.reason.toLowerCase().includes("forbidden")) {
          this._isTerminallyBroken = true;
          this._isReady = false;
          return "Polymarket access appears to be blocked from this network or region (403 Forbidden).";
        }
        return null;
      },
      onerror: () => {
        this._isReady = false;
      },
      onclose: () => {
        this._isReady = false;
        this._clearPing();
      },
    });
  }

  private _clearPing(): void {
    if (this._pingInterval) {
      this._clock.clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
  }

  destroy(): void {
    this._destroyed = true;
    this._clearPing();
    if (this._ws) {
      this._ws.destroy();
      this._ws = null;
    }
  }
}

export class SimUserChannel extends UserChannelBase {
  private _interval: any = null;
  private readonly _getBook: (tokenId: string) => FillModelBook | BookSnapshot | null;
  private readonly _cancelCallbacks: Map<string, () => void> | null;
  private readonly _clock: Clock;
  private readonly _conservativeFill: boolean;

  constructor(opts: {
    getBook: (tokenId: string) => FillModelBook | BookSnapshot | null;
    cancelCallbacks?: Map<string, () => void>;
    clock?: Clock;
    conservativeFill?: boolean;
  }) {
    super();
    this._getBook = opts.getBook;
    this._cancelCallbacks = opts.cancelCallbacks ?? null;
    this._clock = opts.clock ?? new RealClock();
    this._conservativeFill = opts.conservativeFill ?? false;
  }

  subscribe(_conditionId: string): void {
    if (this._interval) this._clock.clearInterval(this._interval);
    this._interval = this._clock.setInterval(() => this._check(), 100);
  }

  isReady(): boolean {
    return true;
  }

  waitForReady(): Promise<void> {
    return Promise.resolve();
  }

  override trackOrder(orderId: string, request: OrderRequest): void {
    super.trackOrder(orderId, request);
    this._cancelCallbacks?.set(orderId, () => {
      this.processOrderEvent({
        id: orderId,
        type: "CANCELLATION",
        status: "CANCELED",
      });
    });
  }

  override untrackOrder(orderId: string): void {
    const wasMatched = this.isMatched(orderId);
    super.untrackOrder(orderId);
    if (!wasMatched) this._cancelCallbacks?.delete(orderId);
  }

  private _checkFill(
    order: { action: "buy" | "sell"; price: number; shares: number; orderType?: "GTC" | "FAK" | "FOK" },
    bookData: FillModelBook | BookSnapshot | null,
  ): boolean {
    if (!bookData) return false;

    const isConservative =
      this._conservativeFill ||
      process.env.CONSERVATIVE_FILL === "true" ||
      process.env.PESSIMISTIC_FILL === "true";

    if (isConservative && "bids" in bookData && "asks" in bookData) {
      const model = new ConservativeMakerFillModel();
      const result = model.evaluate(
        {
          action: order.action,
          side: "UP", // side is not used for maker/taker classification logic
          price: order.price,
          shares: order.shares,
          orderType: (order.orderType as any) ?? "GTC",
        },
        bookData as FillModelBook,
      );
      return result.filled;
    }

    // Fallback to optimistic
    const snap: BookSnapshot = ("bids" in bookData)
      ? {
          bestAsk: (bookData as FillModelBook).asks[0]?.[0] ?? null,
          bestAskLiquidity: (bookData as FillModelBook).asks[0]?.[1] ?? null,
          bestBid: (bookData as FillModelBook).bids[0]?.[0] ?? null,
          bestBidLiquidity: (bookData as FillModelBook).bids[0]?.[1] ?? null,
        }
      : (bookData as BookSnapshot);

    return isSimFilled(order, snap);
  }

  private _check(): void {
    for (const [orderId, t] of this.tracked) {
      if (t.matched) continue;
      const { req } = t.request;
      const book = this._getBook(req.tokenId);
      if (!this._checkFill(req, book)) continue;

      const tradeId = crypto.randomUUID();
      this.processOrderEvent({
        id: orderId,
        type: "UPDATE",
        status: "MATCHED",
        associate_trades: [tradeId],
      });

      const delay = parseInt(process.env.SIM_BALANCE_DELAY_MS ?? "4000", 10);
      this._clock.setTimeout(() => {
        this.processTradeEvent({
          id: tradeId,
          status: "MINED",
          size: String(req.shares),
          taker_order_id: "",
          maker_orders: [
            { order_id: orderId, matched_amount: String(req.shares) },
          ],
        });
      }, delay);
    }
  }

  destroy(): void {
    if (this._interval) {
      this._clock.clearInterval(this._interval);
      this._interval = null;
    }
  }
}
