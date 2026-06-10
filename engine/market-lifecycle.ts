import { OrderBook } from "../tracker/orderbook.ts";
import { APIQueue } from "../tracker/api-queue.ts";
import { Logger } from "./logger.ts";
import type { EarlyBirdClient, PlacedOrder } from "./client.ts";
import type { LogColor } from "./log.ts";
import type {
  Strategy,
  StrategyContext,
  OrderRequest,
} from "./strategy/types.ts";
import type { CancelOrderResponse } from "../utils/trading.ts";
import type { WalletTracker } from "./wallet-tracker.ts";
import type { TickerTracker } from "../tracker/ticker";
import { slotFromSlug } from "../utils/slot.ts";
import { Env } from "../utils/config.ts";
import { digitalCallProbability } from "../utils/math.ts";
import type { MaintenanceTracker } from "../utils/maintenance.ts";
import type { UserChannel } from "./user-channel.ts";
import {
  type ResolutionSourceAdapter,
  type ResolutionPriceEvent,
  type VenueDataAdapter,
  type PredictiveFeedAdapter,
  type PredictiveSignalAggregator,
  type LeadLagMonitor,
  type OrderFlowMonitor,
  type QuantMonitor,
  type RoundWindow,
  PolymarketVenueAdapter,
  AggregatedRiskGate,
  DEFAULT_SIMULATION_RISK_LIMITS,
  type BotFeedEvent,
  type RiskGate,
  type RiskSnapshot,
  type StrategyIntent,
  type Clock,
  RealClock,
} from "./bot-core/index.ts";
import { 
  type TelemetrySink, 
  NullTelemetrySink 
} from "./telemetry/index.ts";
import { ConservativeMakerFillModel, type FillModelBook } from "./replay/fill-model.ts";
import type { BookLevel } from "./event-store/events.ts";
import { createDecisionFeatureSnapshot } from "./decision-features.ts";

import type { EventWriter } from "./event-store/writer.ts";
import type { ProfitEventPayload, ProfitEventType } from "./event-store/events.ts";

const DEFAULT_FEED_READINESS_TIMEOUT_MS = 5000;
const DEFAULT_FEED_READINESS_POLL_MS = 100;
const EMERGENCY_SELL_RETRY_DELAY_MS = 350;

function parseEnvInt(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? "", 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export type LifecycleState = "INIT" | "RUNNING" | "STOPPING" | "DONE";

export type PendingOrder = {
  orderId: string;
  tokenId: string;
  action: "buy" | "sell";
  orderType?: "GTC" | "FOK";
  intentId?: string;
  price: number;
  shares: number;
  expireAtMs: number;
  placedAtMs: number;
  onFilled?: (filledShares: number) => void;
  onExpired?: () => void | Promise<void>;
  onFailed?: (reason: string) => void | Promise<void>;
};

export type CompletedOrder = {
  action: "buy" | "sell";
  price: number;
  shares: number;
  fee: number;
  tokenId: string;
};

/** Serializable subset of PendingOrder (no callbacks). */
export type PendingOrderSnapshot = Omit<
  PendingOrder,
  "onFilled" | "onExpired" | "onFailed"
>;

type RecoveryOptions = {
  state: "RUNNING" | "STOPPING";
  conditionId: string;
  clobTokenIds: [string, string];
  pendingOrders: PendingOrder[];
  orderHistory: CompletedOrder[];
};

type MarketLifecycleOptions = {
  slug: string;
  apiQueue: APIQueue;
  client: EarlyBirdClient;
  log: (msg: string, color?: LogColor) => void;
  strategyName: string;
  strategy: Strategy;
  strategyConfig?: Record<string, unknown>;
  presetId?: string;
  tracker: WalletTracker;
  ticker: TickerTracker;
  userChannel: UserChannel;
  recovery?: RecoveryOptions;
  alwaysLog?: boolean;
  marketLogMode?: "normal" | "disabled";
  /** Optional OrderBook override (used in tests to inject SimOrderBook). */
  orderBook?: OrderBook;
  resolution?: ResolutionSourceAdapter;
  binance?: PredictiveFeedAdapter;
  coinbase?: PredictiveFeedAdapter;
  aggregator?: PredictiveSignalAggregator;
  leadLag?: LeadLagMonitor;
  orderFlow?: OrderFlowMonitor;
  quant?: QuantMonitor;
  venue?: VenueDataAdapter;
  riskGate?: RiskGate;
  maintenance?: MaintenanceTracker;
  clock?: Clock;
  feedReadinessTimeoutMs?: number;
  feedReadinessPollMs?: number;
  telemetry?: TelemetrySink;
  eventWriter?: EventWriter;
  liveMode?: boolean;
};

export class MarketLifecycle {
  private _state: LifecycleState = "INIT";
  private _ticking = false;
  private _orderBook: OrderBook;
  private _userChannel: UserChannel;
  private _clock: Clock;
  private _telemetry: TelemetrySink;
  private _eventWriter?: EventWriter;
  private _lastSpreadDepthEventMs = Number.NEGATIVE_INFINITY;

  private _clobTokenIds: [string, string] | null = null;
  private _conditionId: string | null = null;
  private _userChannelConditionId: string | null = null;

  private _feeRate = 0;
  private _pendingOrders: PendingOrder[] = [];
  private _heartbeatTimer?: any;
  private _itode = false;
  private _orderHistory: CompletedOrder[] = [];
  private _buyBlocked = false;
  private _sellBlocked = false;
  private _pnl = 0;
  private _inFlight = 0;
  private _strategyLocks = 0;
  private _marketLogger: Logger;
  private _marketOpenTimer: unknown = null;
  private _marketPriceHandle: { cancel: () => void } | null = null;
  private _strategyCleanup: (() => void) | null = null;
  private _feedReadinessDeadlineMs: number | null = null;
  private _setupPromise: Promise<void> | null = null;
  private _cancelingOrderIds = new Set<string>();
  private _lastLiveCancelGateLogMs = Number.NEGATIVE_INFINITY;
  private _isInvalid = false;
  private _latchedAnchor: ResolutionPriceEvent | null = null;

  readonly slug: string;
  private readonly apiQueue: APIQueue;
  private readonly client: EarlyBirdClient;
  private readonly _log: (msg: string, color?: LogColor) => void;
  private readonly _strategyName: string;
  private readonly _strategy: Strategy;
  private readonly _strategyConfig: Record<string, unknown>;
  private readonly _presetId?: string;
  private readonly _tracker: WalletTracker;
  private readonly _ticker: TickerTracker;
  private readonly _alwaysLog: boolean;
  private readonly _resolution?: ResolutionSourceAdapter;
  private readonly _binance?: PredictiveFeedAdapter;
  private readonly _coinbase?: PredictiveFeedAdapter;
  private readonly _aggregator?: PredictiveSignalAggregator;
  private readonly _leadLag?: LeadLagMonitor;
  private readonly _orderFlow?: OrderFlowMonitor;
  private readonly _quant?: QuantMonitor;
  private readonly _maintenance?: MaintenanceTracker;
  private readonly _venue: VenueDataAdapter;
  private readonly _riskGate: RiskGate;
  private readonly _liveMode: boolean;
  private readonly _feedReadinessTimeoutMs: number;
  private readonly _feedReadinessPollMs: number;

  constructor(opts: MarketLifecycleOptions) {
    this.slug = opts.slug;
    this.apiQueue = opts.apiQueue;
    this.client = opts.client;
    this._log = opts.log;
    this._strategyName = opts.strategyName;
    this._strategy = opts.strategy;
    this._strategyConfig = { ...(opts.strategyConfig ?? {}) };
    this._presetId = opts.presetId;
    this._tracker = opts.tracker;
    this._ticker = opts.ticker;
    this._alwaysLog = opts.alwaysLog ?? false;
    this._marketLogger = new Logger({ disabled: opts.marketLogMode === "disabled" });
    this._clock = opts.clock ?? new RealClock();
    this._telemetry = opts.telemetry ?? new NullTelemetrySink();
    this._eventWriter = opts.eventWriter;
    this._liveMode = opts.liveMode ?? false;
    this._orderBook = opts.orderBook ?? new OrderBook(this._clock);
    this._userChannel = opts.userChannel;
    this._resolution = opts.resolution;
    this._binance = opts.binance;
    this._coinbase = opts.coinbase;
    this._aggregator = opts.aggregator;
    this._leadLag = opts.leadLag;
    this._orderFlow = opts.orderFlow;
    this._quant = opts.quant;
    this._maintenance = opts.maintenance;
    this._riskGate = opts.riskGate ?? new AggregatedRiskGate();
    this._feedReadinessTimeoutMs =
      opts.feedReadinessTimeoutMs ??
      parseEnvInt(
        "FEED_READINESS_TIMEOUT_MS",
        DEFAULT_FEED_READINESS_TIMEOUT_MS,
      );
    this._feedReadinessPollMs =
      opts.feedReadinessPollMs ??
      parseEnvInt("FEED_READINESS_POLL_MS", DEFAULT_FEED_READINESS_POLL_MS);

    // Per-market venue adapter wraps the per-market orderbook
    this._venue =
      opts.venue ??
      new PolymarketVenueAdapter(
        Env.get("MARKET_ASSET"),
        this._orderBook,
        this.apiQueue,
        this._clock,
      );

    const recovery = opts.recovery;
    if (recovery) {
      this._state = recovery.state;
      this._clobTokenIds = recovery.clobTokenIds;
      this._pendingOrders = recovery.pendingOrders;
      this._orderHistory = recovery.orderHistory;
      if (recovery.state === "STOPPING") this._buyBlocked = true;
      this._orderBook.subscribe(recovery.clobTokenIds);
      this._userChannel.subscribe(recovery.conditionId);

      // track pending orders for user channel
      for (const pending of this._pendingOrders) {
        const orderId = pending.orderId;
        this._userChannel.trackOrder(orderId, {
          req: {
            tokenId: pending.tokenId,
            action: pending.action,
            price: pending.price,
            shares: pending.shares,
            orderType: pending.orderType,
          },
          expireAtMs: pending.expireAtMs,
          onFilled: (gross) => {
            const p = this._pendingOrders.find((o) => o.orderId === orderId);
            if (!p) return;
            this._commitFill(p, gross, 0);
          },
        });
      }
    }
  }

  get state(): LifecycleState {
    return this._state;
  }
  get pnl(): number {
    return this._pnl;
  }
  get clobTokenIds(): [string, string] | null {
    return this._clobTokenIds;
  }
  get conditionId(): string | null {
    return this._conditionId;
  }
  get pendingOrders(): PendingOrderSnapshot[] {
    return this._pendingOrders.map(
      ({ onFilled, onExpired, onFailed, ...rest }) => rest,
    );
  }
  get orderHistory(): CompletedOrder[] {
    return this._orderHistory;
  }
  /** Unix ms timestamp when this lifecycle's market slot starts (market opens). */
  get slotStartMs(): number {
    return slotFromSlug(this.slug).startTime;
  }
  /** Unix ms timestamp when this lifecycle's market slot ends. */
  get slotEndMs(): number {
    return slotFromSlug(this.slug).endTime;
  }
  get remainingSecs(): number {
    return (this.slotEndMs - this._clock.nowMs()) / 1000;
  }
  get strategyName(): string {
    return this._strategyName;
  }

  /** Returns full book and trade info for a tokenId owned by this lifecycle. */
  getBookSnapshot(tokenId: string): FillModelBook | null {
    if (!this._clobTokenIds) return null;
    const levels = this._orderBook.getBookLevels(tokenId);
    const trade = this._orderBook.lastTradeInfo(tokenId);
    return {
      bids: levels.bids,
      asks: levels.asks,
      lastTradePrice: trade.price,
      lastTradeSize: trade.size,
    };
  }

  /**
   * Signal graceful shutdown. INIT lifecycles are marked DONE immediately.
   * RUNNING lifecycles transition to STOPPING on next tick.
   */
  shutdown(): void {
    if (this._state === "INIT") {
      this._setState("DONE");
      return;
    }
    if (this._state === "RUNNING") {
      this._buyBlocked = true;
      this._setState("STOPPING");
    }
    // STOPPING already — no-op
  }

  destroy(): void {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    if (this._orderHistory.length > 0 || this._alwaysLog) {
      this._marketLogger.endSlot(this.slug);
    }
    this._marketLogger.destroy();
    this._marketPriceHandle?.cancel();
    if (this._marketOpenTimer) this._clock.clearTimeout(this._marketOpenTimer);
    this._venue.stop();
    this._orderBook.destroy();
    for (const pending of this._pendingOrders) {
      this._userChannel.untrackOrder(pending.orderId);
    }
    this._userChannel.destroy();
    this._log(`[${this.slug}] destroy()`, "dim");
  }

  private _setState(next: LifecycleState): void {
    if (this._state === next) return;
    const from = this._state;
    this._log(`[${this.slug}] state: ${from} → ${next}`, "dim");
    this._state = next;
    this._telemetry.push({
      ts: this._clock.nowMs(),
      type: "LIFECYCLE_STATE",
      payload: { slug: this.slug, from, to: next }
    });
  }

  async tick(): Promise<void> {
    if (this._ticking || this._state === "DONE") return;
    this._ticking = true;
    try {
      await this._step();
      
      // Heartbeat market tick
      if (this._state === "RUNNING" || this._state === "INIT") {
        const slotStartMs = this.slotStartMs;
        const marketResult = this.apiQueue.marketResult.get(slotStartMs);
        const priceToBeat = marketResult?.openPrice ?? null;
        const currentPrice = this._ticker.price ?? 0;
        const gap =
          priceToBeat !== null && currentPrice
            ? parseFloat((currentPrice - priceToBeat).toFixed(2))
            : null;
        const direction =
          gap === null ? null : gap > 0 ? "UP" : gap < 0 ? "DOWN" : "TIE";
        const upBid = this._orderBook.bestBidPrice("UP");
        const upAsk = this._orderBook.bestAskPrice("UP");
        const downBid = this._orderBook.bestBidPrice("DOWN");
        const downAsk = this._orderBook.bestAskPrice("DOWN");

        const prob = this._quant?.latest().probabilityUp;
        const sigma = this._quant?.latest().sigma;

        this._telemetry.push({
          ts: this._clock.nowMs(),
          type: "MARKET_TICK",
          payload: {
            slug: this.slug,
            asset: Env.get("MARKET_ASSET"),
            price: currentPrice,
            bid: upBid,
            ask: upAsk,
            slotStartMs,
            slotEndMs: this.slotEndMs,
            priceToBeat,
            gap,
            direction,
            upBid,
            upAsk,
            downBid,
            downAsk,
            probabilityUp: prob ?? null,
            sigma: sigma ?? null,
            },
            });
        this._emitSpreadDepthSnapshot();

        
        if (this._aggregator) {
            this._telemetry.push({
                ts: this._clock.nowMs(),
                type: "PREDICTIVE_AGGREGATE",
                payload: this._aggregator.latest()
            });
        }
        if (this._leadLag) {
            this._telemetry.push({
                ts: this._clock.nowMs(),
                type: "LEAD_LAG_UPDATE",
                payload: this._leadLag.latest()
            });
        }
      }
    } catch (e) {
      this._log(`[${this.slug}] tick error: ${e}`, "red");
    } finally {
      this._ticking = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Core engine
  // ---------------------------------------------------------------------------

  private async _step(): Promise<void> {
    switch (this._state) {
      case "INIT":
        return this._handleInit();
      case "RUNNING":
        return this._handleRunning();
      case "STOPPING":
        return this._handleStopping();
    }
  }

  async setup(): Promise<void> {
    if (this._setupPromise) return this._setupPromise;

    this._setupPromise = (async () => {
      const slot = slotFromSlug(this.slug);
      const round: RoundWindow = {
        slug: this.slug,
        asset: Env.get("MARKET_ASSET"),
        window: Env.get("MARKET_WINDOW"),
        startTimeMs: slot.startTime,
        endTimeMs: slot.endTime,
      };

      // Use recovery state if available to avoid refetch
      const existing = this._conditionId
        ? {
            conditionId: this._conditionId,
            clobTokenIds: this._clobTokenIds!,
            feeRateBps: this._feeRate,
          }
        : undefined;

      this._log(`[${this.slug}] calling venue.initRound`, "dim");
      const metadata = await this._venue.initRound(round, existing);
      this._log(
        `[${this.slug}] venue.initRound returned ${metadata ? "metadata" : "null"}`,
        "dim",
      );
      if (!metadata) {
        this._setupPromise = null; // Allow retry on next tick if failed
        return;
      }

      this._conditionId = metadata.conditionId;
      this._clobTokenIds = metadata.clobTokenIds;
      this._feeRate = metadata.feeRateBps;

      // Polymarket research: Detect Taker Order Delay (250ms hold)
      try {
        const market = await (this.client as any).clob.getMarket(
          metadata.conditionId,
        );
        this._itode = !!market?.itode;
        if (this._itode) {
          this._log(
            `[${this.slug}] Taker Order Delay (itode) detected: 250ms order lock active`,
            "yellow",
          );
        }
      } catch {
        // Fallback or non-clob client
      }

      this._orderBook.subscribe(metadata.clobTokenIds);
    })();

    return this._setupPromise;
  }  private async _handleInit(): Promise<void> {
    await this.setup();
    if (!this._clobTokenIds) return;

    const slot = slotFromSlug(this.slug);
    const delayMs = Math.max(0, slot.startTime - this._clock.nowMs());
    if (!this._marketOpenTimer) {
      this._marketOpenTimer = this._clock.setTimeout(() => {
        this._marketPriceHandle = this.apiQueue.queueMarketPrice(slot);
      }, delayMs);
    }

    // Start venue events
    await this._venue.start();

    const round: RoundWindow = {
      slug: this.slug,
      asset: Env.get("MARKET_ASSET"),
      window: Env.get("MARKET_WINDOW"),
      startTimeMs: slot.startTime,
      endTimeMs: slot.endTime,
    };

    if (this._resolution) {
      const anchor = await this._resolution.priceToBeat(round);
      if (anchor) {
        this._appendEvent("resolution_anchor", "market-lifecycle", {
          price: anchor.price,
          priceToBeat: anchor.priceToBeat ?? anchor.price,
          roundId: anchor.roundId ?? null,
          rawOracleAnswer: anchor.rawOracleAnswer ?? null,
          chainUpdatedAtMs: anchor.chainUpdatedAtMs ?? anchor.clock.sourceTimestampMs ?? null,
          localReceivedAtMs: anchor.localReceivedAtMs ?? anchor.clock.receivedAtMs,
          oracleLagMs: anchor.oracleLagMs ?? anchor.lagMs ?? null,
          quality: anchor.quality,
          sourceType: anchor.sourceType ?? null,
          contractAddress: anchor.metadata?.contractAddress ?? null,
        });
        this._appendEvent("price_to_beat", "market-lifecycle", {
          priceToBeat: anchor.priceToBeat ?? anchor.price,
          price: anchor.price,
          sourceType: anchor.sourceType ?? null,
        });
      }
    }

    if (
      this._conditionId &&
      this._userChannelConditionId !== this._conditionId
    ) {
      this._userChannel.subscribe(this._conditionId);
      this._userChannelConditionId = this._conditionId;
    }

    if (!this._orderBook.isReady() || !this._userChannel.isReady()) {
      return;
    }

    const readiness = this._checkRequiredFeedsReadiness();
    if (!readiness.ready) {
      const now = this._clock.nowMs();
      if (!this._feedReadinessDeadlineMs) {
        this._feedReadinessDeadlineMs = now + this._feedReadinessTimeoutMs;
      }

      if (now < this._feedReadinessDeadlineMs) {
        return; // Wait for next tick
      }

      const reason = readiness.reasons.join("; ");
      this._buyBlocked = true;
      this._sellBlocked = true;
      this._log(
        `[${this.slug}] Required feeds not ready after ${this._feedReadinessTimeoutMs}ms: ${reason}. No-trading round.`,
        "yellow",
      );
      this._marketLogger.log({
        type: "info",
        msg: "required feeds not ready; no-trading round",
        reason,
      });
      this._setState("DONE");
      return;
    }

    this._marketLogger.setSnapshotProvider(() =>
      this._orderBook.getSnapshotData(),
    );
    this._marketLogger.setTickerProvider(() => ({
      assetPrice: this._ticker.price,
      binancePrice: this._ticker.binancePrice,
      coinbasePrice: this._ticker.coinbasePrice,
      okxPrice: this._ticker.okxPrice,
      bybitPrice: this._ticker.bybitPrice,
      divergence: this._ticker.divergence,
    }));
    this._marketLogger.setMarketResultProvider(() => {
      const data = this.apiQueue.marketResult.get(slot.startTime);
      if (!data?.openPrice) return {};
      const assetPrice = this._ticker.price;
      const gap = assetPrice
        ? parseFloat((assetPrice - data.openPrice).toFixed(2))
        : undefined;
      return { openPrice: data.openPrice, gap, priceToBeat: data.openPrice };
    });
    this._marketLogger.setResolutionProvider(() => {
      const resolution = this._resolution?.latest();
      if (!resolution) return null;
      return {
        source: resolution.source,
        sourceType: resolution.sourceType,
        price: resolution.price,
        rawOracleAnswer: resolution.rawOracleAnswer,
        roundId: resolution.roundId,
        answeredInRound: resolution.answeredInRound,
        chainUpdatedAtMs: resolution.chainUpdatedAtMs,
        localReceivedAtMs: resolution.localReceivedAtMs ?? resolution.clock.receivedAtMs,
        oracleLagMs: resolution.oracleLagMs ?? resolution.lagMs,
        quality: resolution.quality,
        stalenessStatus: resolution.stalenessStatus,
        contractAddress: resolution.metadata?.contractAddress,
      };
    });
    this._marketLogger.startSlot(
      this.slug,
      this._clock.nowMs(),
      this.slotEndMs,
      this._strategyName,
    );

    // Polymarket research: Start heartbeat loop (every 7 seconds)
    if (this._liveMode) {
      this._heartbeatTimer = setInterval(
        () => {
          void this.client.sendHeartbeat();
        },
        7000,
      );
    }

    const self = this;
    const ctx: StrategyContext = {
      slug: this.slug,
      strategyName: this._strategyName,
      strategyConfig: { ...this._strategyConfig },
      slotStartMs: this.slotStartMs,
      slotEndMs: this.slotEndMs,
      clobTokenIds: this._clobTokenIds,
      orderBook: this._orderBook,
      get walletBalanceUsd() {
        return self._tracker.available;
      },
      get openExposureUsd() { return self._openExposureUsd(); },
      get maxOpenExposureUsd() { 
        return (self._riskGate as any).staticLimits?.maxOpenExposureUsd ?? 50; 
      },
      log: this._log,
      getOrderById: this.client.getOrderById.bind(this.client),
      postOrders: this._postOrders.bind(this),
      cancelOrders: this._cancelOrders.bind(this),
      emergencySells: this._emergencySells.bind(this),
      blockBuys: () => {
        this._buyBlocked = true;
      },
      blockSells: () => {
        this._sellBlocked = true;
      },
      pendingOrders: this._pendingOrders,
      orderHistory: this._orderHistory,
      hold: () => {
        this._strategyLocks++;
        let released = false;
        return () => {
          if (!released) {
            released = true;
            this._strategyLocks--;
          }
        };
      },
      ticker: this._ticker,
      getMarketResult: () => {
        const slot = slotFromSlug(this.slug);
        return this.apiQueue.marketResult.get(slot.startTime);
      },
      getAvailableShares: (tokenId: string) => this._tracker.availableShares(tokenId),
      resolution: this._resolution ? new Proxy(this._resolution, {
        get: (target, prop, receiver) => {
          if (prop === "latestAnchor") {
            return () => this._latchedAnchor || target.latestAnchor();
          }
          const val = Reflect.get(target, prop, receiver);
          return typeof val === "function" ? val.bind(target) : val;
        }
      }) : undefined,
      venue: this._venue,
      predictive: {
        binance: this._binance,
        coinbase: this._coinbase,
        aggregate: this._aggregator,
        leadLag: this._leadLag,
      },
      orderFlow: this._orderFlow,
      quant: this._quant,
      clock: this._clock,
    };

    const cleanup = await this._strategy(ctx);
    if (cleanup) this._strategyCleanup = cleanup;
    this._setState("RUNNING");
  }

  private _checkRequiredFeedsReadiness(): { ready: true; reasons: [] } | { ready: false; reasons: string[] } {
    const reasons = this._requiredFeedReadinessReasons(this._clock.nowMs());
    if (reasons.length === 0) return { ready: true, reasons: [] };
    return { ready: false, reasons };
  }

  /**
   * Generic tick for RUNNING: check pending order expiries and fire callbacks.
   * Fills arrive asynchronously via the user channel's onFilled callback.
   * Transitions to STOPPING when the slot ends or all orders drain.
   */
  private async _handleRunning(): Promise<void> {
    if (this._clock.nowMs() >= this.slotEndMs) {
      this._setState("STOPPING");
      this._log(
        `[${this.slug}] Market closed — transitioning to STOPPING`,
        "yellow",
      );
      return;
    }

    await this._checkExpiries();

    // If no pending orders remain, no placements in flight, no strategy holds,
    // and no unfilled positions that a stop-loss may still sell, we're done
    if (
      this._pendingOrders.length === 0 &&
      this._inFlight === 0 &&
      this._strategyLocks === 0 &&
      !this._hasUnfilledPositions()
    ) {
      this._setState("STOPPING");
    }
  }

  /**
   * STOPPING: cancel pending buys, drain sells, emergency sell on timeout.
   */
  private async _handleStopping(): Promise<void> {
    this._strategyCleanup?.();
    this._strategyCleanup = null;

    // Cancel any remaining buys (in case shutdown was called externally)
    await this._cancelPendingBuys();

    const pendingSells = this._pendingOrders.filter((o) => o.action === "sell");

    const remaining = this.remainingSecs;

    if (remaining <= 0) {
      // Slot expired — cancel whatever is left
      if (pendingSells.length > 0) {
        this._log(
          `[${this.slug}] Slot expired with ${pendingSells.length} unfilled SELL order(s) — cancelling`,
          "yellow",
        );
        const response = await this._cancelOrders(
          pendingSells.map((o) => o.orderId),
        );
        // Force-remove any not_canceled (slot is over, nothing we can do)
        for (const id of Object.keys(response.not_canceled)) {
          this._removePendingOrder(id);
        }
      }
      
      const isResolved = this._checkResolutionSync();
      if (!isResolved) return; // Wait for next tick

      this._computePnl();
      await this._autoRedeem();
      this._setState("DONE");
      return;
    }

    // Check expiries for remaining sells
    await this._checkExpiries();

    if (this._pendingOrders.length === 0 && this._inFlight === 0) {
      if (this._hasUnfilledPositions()) {
        const isResolved = this._checkResolutionSync();
        if (!isResolved) return; // Wait for next tick
        this._computePnl();
        await this._autoRedeem();
      } else {
        this._computePnl();
      }
      this._setState("DONE");
    }
  }

  /**
   * Cancel any orders that have passed their expireAtMs.
   * Fills arrive via user channel callbacks — this only handles expiry.
   */
  private async _checkExpiries(): Promise<void> {
    const now = this._clock.nowMs();
    for (const pending of this._pendingOrders) {
      if (now < pending.expireAtMs) continue;
      // Defer expiry for orders that have MATCHED but are awaiting MINED.
      // Cancelling here would race against the in-flight settlement — the
      // trade would be dropped and onFilled never fires.
      if (this._userChannel.isMatched(pending.orderId)) continue;
      // Read partial fill from channel BEFORE cancel (order still tracked here).
      const partialShares = this._userChannel.getMatchedSoFar(pending.orderId);
      // _cancelOrders untracks from channel BEFORE the API call (race-safe).
      await this._cancelOrders([pending.orderId], "expired");
      if (partialShares > 0) {
        this._commitFill(pending, partialShares, 0, "partial_filled");
      } else if (pending.onExpired) {
        this._marketLogger.log(this._createOrderEntry(pending, "expired"));
        void pending.onExpired();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Strategy-facing order APIs
  // ---------------------------------------------------------------------------

  /**
   * Fire-and-forget order placement. Returns immediately — do NOT await the
   * result to know if an order was placed. Use `onFilled` to react to a fill
   * and `onExpired` to react to a cancellation or failed placement.
   * Buys retry up to BUY_MAX_RETRIES times on balance errors; sells retry until slot end.
   */
  private _postOrders(requests: OrderRequest[]): void {
    const maintenance = this._maintenance?.isActive(this._clock.nowMs());
    if (maintenance?.active) {
      const reason = `Polymarket matching engine maintenance: ${maintenance.reason ?? "active"}`;
      this._log(
        `[maintenance] Skipping order placement: ${maintenance.reason}`,
        "yellow",
      );
      for (const item of requests) {
        this._marketLogger.log(
          this._createOrderEntry(item.req, "failed", { reason }),
        );
        this._emitOrderLifecycle(item.req, "failed", { error: reason });
        item.onFailed?.(reason);
      }
      return;
    }

    let buys = requests.filter(
      (o) => o.req.action === "buy" && !this._buyBlocked,
    );
    const sells = requests.filter(
      (o) => o.req.action === "sell" && !this._sellBlocked,
    );

    if (this._liveMode && buys.length > 0) {
      const now = this._clock.nowMs();
      if (this._cancelingOrderIds.size > 0) {
        if (now - this._lastLiveCancelGateLogMs >= 1000) {
          this._log(
            `[${this.slug}] Live placement gated: waiting for ${this._cancelingOrderIds.size} cancel(s) to confirm`,
            "yellow",
          );
          this._lastLiveCancelGateLogMs = now;
        }
        for (const item of buys) item.onFailed?.("cancel in flight");
        buys = [];
      }

      const maxActiveBuysPerSide = parseEnvInt("LIVE_MAX_ACTIVE_BUYS_PER_SIDE", 1);
      const filteredBuys: OrderRequest[] = [];
      for (const item of buys) {
        const activeBuysThisSide = this._pendingOrders.filter((o) => o.action === "buy" && o.tokenId === item.req.tokenId).length;
        const placingBuysThisSide = filteredBuys.filter((o) => o.req.tokenId === item.req.tokenId).length;
        if (activeBuysThisSide + placingBuysThisSide < maxActiveBuysPerSide) {
          filteredBuys.push(item);
        } else {
          item.onFailed?.("live active buy limit reached for side");
        }
      }
      buys = filteredBuys;
    }

    const maxRetries = this._liveMode
      ? parseEnvInt("LIVE_BUY_MAX_RETRIES", 0)
      : parseEnvInt("BUY_MAX_RETRIES", 30);
    const retryDelayMs = parseInt(process.env.BUY_RETRY_DELAY_MS ?? "500", 10);

    if (buys.length > 0) this._placeWithRetry(buys, retryDelayMs, maxRetries);
    if (sells.length > 0) this._placeWithRetry(sells, 500, Infinity);
  }

  private async _cancelOrders(
    orderIds: string[],
    status: "canceled" | "expired" = "canceled",
  ): Promise<CancelOrderResponse> {
    // Skip orders that have MATCHED but are awaiting MINED — cancelling them
    // would unlock the wallet here while the pending settlement still fires
    // onFilled later, double-counting the tracker.
    const cancellable = orderIds.filter(
      (id) => !this._userChannel.isMatched(id),
    );

    for (const id of cancellable) this._cancelingOrderIds.add(id);
    try {
      const response = await this.client.cancelOrders(cancellable);
      const canceled = response?.canceled || [];
      const notCanceled = response?.not_canceled || {};
      for (const id of canceled) {
        this._userChannel.untrackOrder(id);
        const pending = this._pendingOrders.find((o) => o.orderId === id);
        if (pending) {
          this._trackerUnlock(pending);
          this._marketLogger.log(this._createOrderEntry(pending, status));
          this._emitOrderLifecycle(pending, status, {
            orderId: id,
            intentId: pending.intentId,
          });
        }
        this._removePendingOrder(id);
      }
      return { canceled, not_canceled: notCanceled };
    } finally {
      for (const id of cancellable) this._cancelingOrderIds.delete(id);
    }
  }

  private async _emergencySells(orderIds: string[]): Promise<void> {
    const sells = orderIds
      .map((id) =>
        this._pendingOrders.find(
          (o) => o.orderId === id && o.action === "sell",
        ),
      )
      .filter((o): o is PendingOrder => !!o);

    if (sells.length === 0) return;

    // Cancel all in batch
    const response = await this._cancelOrders(sells.map((o) => o.orderId));
    const canceledSells = sells.filter((s) =>
      response.canceled.includes(s.orderId),
    );

    if (canceledSells.length === 0) return;

    await Promise.all(
      canceledSells.map((sell) => this._emergencySellLoop(sell)),
    );
  }

  /**
   * Places a GTC sell at the current best bid and retries on rejection until
   * the order fills or the slot ends. Each retry reads a fresh best bid so the
   * price tracks the market.
   */
  private async _emergencySellLoop(sell: PendingOrder): Promise<void> {
    this._inFlight++;
    return (async () => {
      while (this._clock.nowMs() < this.slotEndMs) {
        const side = sell.tokenId === this._clobTokenIds![0] ? "UP" : "DOWN";
        const bestBid =
          this._orderBook.bestBidPrice(side as "UP" | "DOWN") ?? sell.price;

        let filled = false;
        let failed = false;

        await new Promise<void>((resolve) => {
          this._placeWithRetry([
            {
              req: {
                tokenId: sell.tokenId,
                action: "sell" as const,
                price: bestBid,
                shares: sell.shares,
                orderType: "GTC" as const,
              },
              expireAtMs: this._clock.nowMs() + 2000,
              onFilled: (_filledShares) => {
                filled = true;
                resolve();
              },
              onFailed: (reason) => {
                if (!reason.includes("not enough balance")) failed = true;
                resolve();
              },
              onExpired: () => {
                // GTC expired after 2s — retry with fresh bid
                failed = true;
                resolve();
              },
            },
          ]);
        });

        if (filled) break;

        // If blocked by risk gate synchronously, we must yield the event loop
        // to prevent an infinite microtask spin before we hit the delay below
        if (failed) {
          await new Promise<void>((resolve) => this._clock.setTimeout(resolve, 500));
        }

        if (!failed) break; // unexpected stop (e.g. sell blocked but no failure callback)

        const remainingMs = this.slotEndMs - this._clock.nowMs();
        if (remainingMs <= 0) break;
        await new Promise<void>((resolve) =>
          this._clock.setTimeout(
            () => resolve(),
            Math.min(EMERGENCY_SELL_RETRY_DELAY_MS, Math.max(1, remainingMs)),
          ),
        );
      }
    })()
      .catch((e) =>
        this._log(`[${this.slug}] _emergencySellLoop error: ${e}`, "red"),
      )
      .finally(() => {
        this._inFlight--;
      });
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Commit a fill: update tracker, record in history, remove from pending, log, fire callback.
   */
  private _commitFill(
    pending: PendingOrder,
    shares: number,
    fee: number,
    status: "filled" | "partial_filled" = "filled",
  ): void {
    if (pending.action === "buy") {
      this._tracker.onBuyFilled(
        pending.orderId,
        pending.tokenId,
        pending.price,
        shares,
      );
    } else {
      this._tracker.onSellFilled(
        pending.orderId,
        pending.tokenId,
        pending.price,
        shares,
      );
    }
    this._orderHistory.push({
      action: pending.action,
      price: pending.price,
      shares,
      fee,
      tokenId: pending.tokenId,
    });
    this._removePendingOrder(pending.orderId);
    this._marketLogger.log(
      this._createOrderEntry(pending, "filled", { shares }),
    );
    
    this._emitOrderLifecycle(pending, status, {
      orderId: pending.orderId,
      intentId: pending.intentId,
      shares,
    });

    if (pending.onFilled) pending.onFilled(shares);
  }

  /**
   * Fire-and-forget: places orders and retries any that fail with a balance
   * error (350 ms apart) until the slot ends or all orders are placed.
   */
  private _placeWithRetry(
    items: Array<OrderRequest>,
    retryDelayMs = 350,
    maxRetries = Infinity,
  ): void {
    this._inFlight++;
    (async () => {
      let remaining = [...items];
      let retryCount = 0;
      while (remaining.length > 0) {
        const intents = new Map<OrderRequest, StrategyIntent>();
        // Stop retrying if the relevant block flag was set after this loop started
        const beforeBlock = remaining.length;
        remaining = remaining.filter((item) => {
          if (item.req.action === "buy" && this._buyBlocked) return false;
          if (item.req.action === "sell" && this._sellBlocked) return false;
          return true;
        });
        if (remaining.length === 0) {
          // log if blocked, take 0 item assuming all item kinds are same from postOrder
          if (beforeBlock > 0) {
            const kind = items[0]!.req.action === "buy" ? "buy" : "sell";
            this._log(
              `[${this.slug}] Retry stopped: ${kind} is blocked`,
              "yellow",
            );
          }
          break;
        }

        // Pre-flight: drop orders past their expiry
        remaining = remaining.filter((item) => {
          if (this._clock.nowMs() >= item.expireAtMs) {
            this._emitOrderLifecycle(item.req, "expired", {
              error: "order expired before placement",
            });
            if (item.onFailed) item.onFailed("order expired before placement");
            return false;
          }
          return true;
        });
        if (remaining.length === 0) break;

        remaining = remaining.filter((item) => {
          const intent = this._createOrderIntent(item);
          intents.set(item, intent);

          this._telemetry.push({
            ts: this._clock.nowMs(),
            type: "ORDER_INTENT",
            payload: {
              slug: this.slug,
              intent,
            },
          });
          this._appendEvent("order_intent", "market-lifecycle", {
            intentId: intent.id,
            tokenId: item.req.tokenId,
            side: this._side(item.req.tokenId),
            action: item.req.action,
            price: item.req.price,
            shares: item.req.shares,
            orderType: item.req.orderType,
          }, intent.id);

          const decision = this._riskGate.evaluate(intent, this._createRiskSnapshot());
          
          this._telemetry.push({
            ts: this._clock.nowMs(),
            type: "RISK_DECISION",
            payload: {
                slug: this.slug,
                approved: decision.approved,
                reasons: decision.reasons,
                intent
            }
          });
          this._appendEvent("risk_gate_decision", "market-lifecycle", {
            intent,
            decision,
            approved: decision.approved,
            reasons: decision.reasons,
          }, intent.id);

          this._emitDecisionFeature(decision.approved ? "consider" : "blocked", {
            snapshot: this._createRiskSnapshot(),
            intent,
            decision,
          });

          if (decision.approved) return true;

          const reason = decision.reasons.join("; ");
          const side = this._side(item.req.tokenId);
          let feedDetails = "";
          if (reason.includes("predictive aggregate disagreement") && this._aggregator) {
            const agg = this._aggregator.latest();
            const details: string[] = [];
            for (const [name, f] of Object.entries(agg.feeds)) {
              details.push(`${name}: price=${f.price} quality=${f.quality} age=${f.latestEventAgeMs}ms`);
            }
            feedDetails = ` | Feeds [${details.join(", ")}] div=${agg.divergenceAbs !== null ? `$${agg.divergenceAbs.toFixed(2)}` : "N/A"}`;
          }
          this._log(
            `[${this.slug}] Risk gate blocked ${item.req.action.toUpperCase()} ${side} @ ${item.req.price}: ${reason}${feedDetails}`,
            "yellow",
          );
          this._marketLogger.log(
            this._createOrderEntry(item.req, "failed", { reason }),
          );
          item.onFailed?.(reason);
          return false;
        });
        if (remaining.length === 0) break;

        // Pre-flight: skip network call for orders the tracker knows will fail
        const retryNext: typeof remaining = [];
        let availableCash = this._tracker.available;
        const availableSharesMap = new Map<string, number>();

        remaining = remaining.filter((item) => {
          if (item.req.action === "buy") {
            const cost = item.req.price * item.req.shares;
            if (availableCash >= cost) {
              availableCash -= cost;
              return true;
            } else {
              retryNext.push(item);
              return false;
            }
          } else {
            if (!availableSharesMap.has(item.req.tokenId)) {
              availableSharesMap.set(item.req.tokenId, this._tracker.availableShares(item.req.tokenId));
            }
            const availShares = availableSharesMap.get(item.req.tokenId)!;
            if (availShares >= item.req.shares) {
              availableSharesMap.set(item.req.tokenId, availShares - item.req.shares);
              return true;
            } else {
              retryNext.push(item);
              return false;
            }
          }
        });
        if (remaining.length === 0) {
          if (retryCount === 0) {
            const kind = retryNext[0]!.req.action === "buy" ? "buy" : "sell";
            this._log(
              `[${this.slug}] Retry stopped: wallet balance too low to place ${kind}`,
              "yellow",
            );
          }
          remaining = retryNext;
          retryCount++;
          if (retryCount >= maxRetries) {
            for (const item of remaining) {
              if (item.onFailed) item.onFailed("not enough balance");
            }
            break;
          }
          await new Promise<void>((resolve) =>
            this._clock.setTimeout(() => resolve(), retryDelayMs),
          );
          continue;
        }

        // Lock funds/shares optimistically before async network call to prevent concurrent overspending
        const optimisticOrderIds = remaining.map(() => crypto.randomUUID());
        for (let i = 0; i < remaining.length; i++) {
          const item = remaining[i]!;
          const tempId = optimisticOrderIds[i]!;
          const side = this._side(item.req.tokenId);
          const label = `[${this.slug}] ${item.req.action.toUpperCase()} ${side} @ ${item.req.price} (optimistic)`;
          if (item.req.action === "buy") {
            this._tracker.lockForBuy(tempId, item.req.price, item.req.shares, label);
          } else {
            this._tracker.lockForSell(tempId, item.req.tokenId, item.req.shares, label);
          }
        }

        const placed = await this.client.postMultipleOrders(
          remaining.map((r) => ({
            ...r.req,
            tickSize: this._orderBook.getTickSize(r.req.tokenId),
            feeRateBps: this._orderBook.getFeeRate(r.req.tokenId),
            negRisk: false,
          })),
        );

        for (let i = 0; i < placed.length; i++) {
          const p = placed[i];
          const item = remaining[i]!;
          const tempId = optimisticOrderIds[i]!;
          
          if (!p || !p.orderId) {
            // Unlock optimistic reservation on failure
            const side = this._side(item.req.tokenId);
            const label = `[${this.slug}] ${item.req.action.toUpperCase()} ${side} @ ${item.req.price} (optimistic)`;
            if (item.req.action === "buy") {
              this._tracker.unlockBuy(tempId, label);
            } else {
              this._tracker.unlockSell(tempId, label);
            }

            this._log(`[placement] Order failed: ${p?.errorMsg}`, "red");
            if (
              p?.errorMsg?.includes("not enough balance") &&
              this._clock.nowMs() < this.slotEndMs &&
              retryCount < maxRetries
            ) {
              const balMatch = p.errorMsg.match(
                /balance:\s*(\d+).*?order amount:\s*(\d+)/,
              );
              if (balMatch) {
                const actualBalance = parseInt(balMatch[1]!, 10);
                const orderAmount = parseInt(balMatch[2]!, 10);
                if (actualBalance > 0 && actualBalance < orderAmount) {
                  item.req.shares = actualBalance / 1e6;
                }
              }
              retryNext.push(item);
            } else {
              const reason = p?.errorMsg ?? "unknown";
              const intent = intents.get(item);
              this._log(
                `[${this.slug}] Order placement failed (${item.req.action.toUpperCase()} ${side} @ ${item.req.price}): ${reason}`,
                "red",
              );
              this._emitOrderLifecycle(item.req, "failed", {
                intentId: intent?.id,
                error: reason,
              });
              if (item.onFailed) item.onFailed(reason);
            }
            continue;
          }
          
          // Rename the optimistic reservation to the real orderId
          // This ensures no gap in reservation tracking
          const side = this._side(item.req.tokenId);
          const label = `[${this.slug}] ${item.req.action.toUpperCase()} ${side} @ ${item.req.price}`;
          if (item.req.action === "buy") {
            this._tracker.unlockBuy(tempId, label + " (temp)");
            this._tracker.lockForBuy(p.orderId, item.req.price, item.req.shares, label);
          } else {
            this._tracker.unlockSell(tempId, label + " (temp)");
            this._tracker.lockForSell(p.orderId, item.req.tokenId, item.req.shares, label);
          }

          this._pendingOrders.push({
            orderId: p.orderId,
            tokenId: item.req.tokenId,
            action: item.req.action,
            orderType: item.req.orderType,
            intentId: intents.get(item)?.id,
            price: item.req.price,
            shares: item.req.shares,
            expireAtMs: item.expireAtMs,
            placedAtMs: this._clock.nowMs(),
            onFilled: item.onFilled,
            onExpired: item.onExpired,
            onFailed: item.onFailed,
          });
          this._marketLogger.log(this._createOrderEntry(item.req, "placed"));
          
          this._emitOrderLifecycle(item.req, "placed", {
            orderId: p.orderId,
            intentId: intents.get(item)?.id,
          });
          this._appendEvent("order_submitted", "market-lifecycle", {
            orderId: p.orderId,
            intentId: intents.get(item)?.id,
            tokenId: item.req.tokenId,
            side: this._side(item.req.tokenId),
            action: item.req.action,
            price: item.req.price,
            shares: item.req.shares,
            orderType: item.req.orderType ?? "GTC",
            status: p.status,
          }, intents.get(item)?.id);

          // Wrap the OrderRequest with fill accounting and register with the user channel.
          // The channel calls wrapped.onFilled when the order is fully settled on-chain.
          const orderId = p.orderId;
          const wrapped: OrderRequest = {
            req: item.req,
            expireAtMs: item.expireAtMs,
            onFilled: (gross) => {
              const pending = this._pendingOrders.find(
                (o) => o.orderId === orderId,
              );
              if (!pending) return;
              let fee = 0;
              if (pending.orderType === "FOK" && this._feeRate > 0) {
                fee =
                  gross * this._feeRate * pending.price * (1 - pending.price);
              }
              const net =
                pending.action === "buy" && fee > 0
                  ? gross - fee / pending.price
                  : gross;
              this._commitFill(pending, net, fee);
            },
            onFailed: (reason) => {
              // Suppress async channel "cancelled" events for orders we are actively cancelling.
              // `_cancelOrders` handles untracking, unlocking, and callbacks.
              if (this._cancelingOrderIds.has(orderId) && reason.toLowerCase() === "cancelled") {
                return;
              }
              const pending = this._pendingOrders.find(
                (o) => o.orderId === orderId,
              );
              if (!pending) return;
              this._removePendingOrder(orderId);
              this._trackerUnlock(pending);
              this._marketLogger.log(
                this._createOrderEntry(pending, "failed", { reason }),
              );
              
              this._emitOrderLifecycle(pending, "failed", {
                orderId,
                intentId: pending.intentId,
                error: reason,
              });

              item.onFailed?.(reason);
            },
          };
          this._userChannel.trackOrder(orderId, wrapped);
        }

        if (retryNext.length === 0) break;
        remaining = retryNext;
        retryCount++;
        if (retryCount % 5 === 0) {
          const summary = retryNext
            .map((r) => {
              const side =
                r.req.tokenId === this._clobTokenIds?.[0] ? "UP" : "DOWN";
              return `${r.req.action.toUpperCase()} ${side} @ ${r.req.price} (shares: ${r.req.shares})`;
            })
            .join(", ");
          const errors = placed
            ?.filter((p) => p?.errorMsg)
            .map((p) => p!.errorMsg)
            .join("; ");
          this._log(
            `[${this.slug}] Balance not ready — retrying (attempt ${retryCount}): ${summary} | error: ${errors || "pre-flight rejected"}`,
            "yellow",
          );
        }
        await new Promise<void>((resolve) =>
          this._clock.setTimeout(() => resolve(), retryDelayMs),
        );
      }
    })()
      .catch((e) => {
        if (e instanceof Error && e.message.includes("invariant violation")) {
          this._triggerFatalError(e);
        } else {
          this._log(`[${this.slug}] _placeWithRetry error: ${e}`, "red");
        }
      })
      .finally(() => {
        this._inFlight--;
      });
  }

  private _removePendingOrder(orderId: string): void {
    const idx = this._pendingOrders.findIndex((o) => o.orderId === orderId);
    if (idx !== -1) this._pendingOrders.splice(idx, 1);
  }

  private async _cancelPendingBuys(): Promise<void> {
    const buys = this._pendingOrders.filter((o) => o.action === "buy");
    if (buys.length === 0) return;

    this._log(
      `[${this.slug}] Cancelling ${buys.length} pending BUY order(s)`,
      "yellow",
    );
    await this._cancelOrders(buys.map((o) => o.orderId));
  }

  private _side(tokenId: string): "UP" | "DOWN" {
    return tokenId === this._clobTokenIds?.[0] ? "UP" : "DOWN";
  }

  private _emitOrderLifecycle(
    order: {
      action: "buy" | "sell";
      tokenId: string;
      price: number;
      shares: number;
    },
    status:
      | "placed"
      | "filled"
      | "partial_filled"
      | "canceled"
      | "expired"
      | "failed",
    opts: {
      orderId?: string;
      intentId?: string;
      shares?: number;
      error?: string;
    } = {},
  ): void {
    const intent = opts.intentId ? this._createSyntheticIntent(order, opts.intentId) : undefined;
    this._telemetry.push({
      ts: this._clock.nowMs(),
      type: "ORDER_LIFECYCLE",
      payload: {
        slug: this.slug,
        orderId: opts.orderId,
        intentId: opts.intentId,
        status,
        side: this._side(order.tokenId),
        action: order.action,
        price: order.price,
        shares: opts.shares ?? order.shares,
        error: opts.error,
      },
    });
    const eventType = status === "filled"
      ? "order_filled"
      : status === "partial_filled"
        ? "partial_fill"
        : status === "canceled"
          ? "order_canceled"
          : status === "expired"
            ? "order_expired"
            : status === "placed"
              ? "order_acknowledged"
              : "order_acknowledged";
    this._appendEvent(eventType, "market-lifecycle", {
      orderId: opts.orderId,
      intentId: opts.intentId,
      tokenId: order.tokenId,
      side: this._side(order.tokenId),
      action: order.action,
      price: order.price,
      shares: opts.shares ?? order.shares,
      status,
      error: opts.error,
    }, opts.intentId);
    this._emitDecisionFeature(status === "filled" ? "filled" : status === "placed" ? "placed" : status === "failed" ? "failed" : "consider", {
      snapshot: this._createRiskSnapshot(),
      intent,
      orderStatus: status,
      orderId: opts.orderId,
    });
  }

  private _createSyntheticIntent(
    order: {
      action: "buy" | "sell";
      tokenId: string;
      price: number;
      shares: number;
    },
    intentId: string,
  ): StrategyIntent {
    return {
      id: intentId,
      slug: this.slug,
      strategyName: this._strategyName,
      createdAtMs: this._clock.nowMs(),
      reason: "order lifecycle update",
      triggerEventIds: [],
      round: this._roundWindow(),
      action: order.action,
      side: this._side(order.tokenId),
      tokenId: order.tokenId,
      price: order.price,
      shares: order.shares,
      expireAtMs: this.slotEndMs,
    };
  }

  private _emitDecisionFeature(
    event: "consider" | "blocked" | "placed" | "filled" | "failed" | "settled" | "skipped",
    params: {
      snapshot: RiskSnapshot;
      intent?: StrategyIntent;
      decision?: ReturnType<RiskGate["evaluate"]>;
      orderStatus?: string;
      orderId?: string;
      pnl?: number;
      resolutionDirection?: "UP" | "DOWN";
    },
  ): void {
    const snapshot = createDecisionFeatureSnapshot({
      event,
      ts: this._clock.nowMs(),
      slug: this.slug,
      strategyId: this._strategyName,
      strategyConfig: this._strategyConfig,
      presetId: this._presetId,
      snapshot: params.snapshot,
      intent: params.intent,
      decision: params.decision,
      orderStatus: params.orderStatus,
      orderId: params.orderId,
      pnl: params.pnl,
      resolutionDirection: params.resolutionDirection,
    });
    this._telemetry.push({
      ts: this._clock.nowMs(),
      type: "DECISION_FEATURE_SNAPSHOT",
      payload: snapshot,
    });
    this._appendEvent("strategy_decision", "market-lifecycle", {
      decisionFeature: snapshot,
      intent: params.intent,
      decision: params.decision,
      approved: params.decision?.approved ?? null,
      reasons: params.decision?.reasons ?? [],
      probability: snapshot.quant.probabilityUp,
      impliedProbability: snapshot.intent?.price ?? null,
      noTradeReason:
        snapshot.risk.reasons.length > 0
          ? snapshot.risk.reasons.join("; ")
          : null,
    }, params.intent?.id);
    this._marketLogger.log({ type: "decision_feature", snapshot });
  }

  private _roundWindow(): RoundWindow {
    return {
      slug: this.slug,
      asset: Env.get("MARKET_ASSET"),
      window: Env.get("MARKET_WINDOW"),
      startTimeMs: this.slotStartMs,
      endTimeMs: this.slotEndMs,
    };
  }

  private _createOrderIntent(item: OrderRequest): StrategyIntent {
    const now = this._clock.nowMs();
    return {
      id: `${this.slug}-${item.req.action}-${now}-${crypto.randomUUID()}`,
      slug: this.slug,
      strategyName: this._strategyName,
      createdAtMs: now,
      reason: "strategy requested order placement",
      triggerEventIds: [],
      round: this._roundWindow(),
      action: item.req.action,
      side: this._side(item.req.tokenId),
      tokenId: item.req.tokenId,
      price: item.req.price,
      shares: item.req.shares,
      orderType: item.req.orderType,
      expireAtMs: item.expireAtMs,
    };
  }

  private _createRiskSnapshot(): RiskSnapshot {
    const quant = this._quant?.latest();
    return {
      nowMs: this._clock.nowMs(),
      productionEnabled: Env.get("PROD"),
      maintenance: this._maintenance?.isActive(this._clock.nowMs()) ?? null,
      resolution: this._resolution?.latest() ?? null,
      venue: this._venue.latest(),
      predictiveFeeds: [
        this._binance?.latest() ?? null,
        this._coinbase?.latest() ?? null,
      ].filter((event): event is NonNullable<typeof event> => event !== null),
      predictiveAggregate: this._aggregator?.latest() ?? null,
      leadLag: this._leadLag?.latest() ?? null,
      orderFlow: this._orderFlow?.latest() ?? null,
      probabilityUp: quant?.probabilityUp ?? null,
      sigma: quant?.sigma ?? null,
      openExposureUsd: this._openExposureUsd(),
      sessionPnlUsd: this._pnl,
      clobTokenIds: this._clobTokenIds ?? undefined,
    };
  }
  private async _waitForRequiredFeeds(): Promise<
    | { ready: true; reasons: [] }
    | { ready: false; reasons: string[] }
  > {
    const timeoutMs = Math.max(0, this._feedReadinessTimeoutMs);
    const pollMs = Math.max(1, this._feedReadinessPollMs);
    const deadlineMs = this._clock.nowMs() + timeoutMs;

    while (true) {
      const reasons = this._requiredFeedReadinessReasons(this._clock.nowMs());
      if (reasons.length === 0) return { ready: true, reasons: [] };
      if (timeoutMs === 0 || this._clock.nowMs() >= deadlineMs) {
        return { ready: false, reasons };
      }

      await new Promise<void>((resolve) =>
        this._clock.setTimeout(
          () => resolve(),
          Math.min(pollMs, Math.max(1, deadlineMs - this._clock.nowMs())),
        ),
      );
    }
  }

  private _requiredFeedReadinessReasons(nowMs: number): string[] {
    const snapshot = this._createRiskSnapshot();
    const reasons: string[] = [];
    this._appendFeedReadinessReason(
      "resolution",
      snapshot.resolution,
      nowMs,
      reasons,
    );
    this._appendFeedReadinessReason("venue", snapshot.venue, nowMs, reasons);
    return reasons;
  }

  private _appendFeedReadinessReason(
    label: "resolution" | "venue",
    event: BotFeedEvent | null,
    nowMs: number,
    reasons: string[],
  ): void {
    if (!event) {
      reasons.push(`${label} feed is missing`);
      return;
    }
    if (event.quality === "stale" || event.quality === "missing") {
      reasons.push(`${label} feed quality is ${event.quality}`);
    }
    const maxFeedFreshnessMs =
      DEFAULT_SIMULATION_RISK_LIMITS.maxFeedFreshnessMs;
    const maxSourceFreshnessMs =
      label === "resolution"
        ? DEFAULT_SIMULATION_RISK_LIMITS.maxOracleLagMs
        : maxFeedFreshnessMs;
    const maxReceivedAgeMs =
      label === "resolution" ? Math.max(maxFeedFreshnessMs, 3_000) : maxFeedFreshnessMs;
    if (
      event.freshnessMs !== null &&
      event.freshnessMs > maxSourceFreshnessMs
    ) {
      reasons.push(`${label} feed is stale by freshness threshold`);
    }
    if (nowMs - event.clock.receivedAtMs > maxReceivedAgeMs) {
      reasons.push(`${label} feed is stale by received age threshold`);
    }
  }

  private _openExposureUsd(): number {
    const pendingBuyExposure = this._pendingOrders
      .filter((o) => o.action === "buy")
      .reduce((sum, o) => sum + o.price * o.shares, 0);

    const positions = new Map<
      string,
      { boughtShares: number; boughtCost: number; soldShares: number }
    >();

    for (const order of this._orderHistory) {
      const current = positions.get(order.tokenId) ?? {
        boughtShares: 0,
        boughtCost: 0,
        soldShares: 0,
      };
      if (order.action === "buy") {
        current.boughtShares += order.shares;
        current.boughtCost += order.price * order.shares;
      } else {
        current.soldShares += order.shares;
      }
      positions.set(order.tokenId, current);
    }

    let heldExposure = 0;
    for (const position of positions.values()) {
      if (position.boughtShares <= 0) continue;
      const heldShares = Math.max(
        0,
        position.boughtShares - position.soldShares,
      );
      const averageEntryPrice =
        position.boughtCost / position.boughtShares;
      heldExposure += heldShares * averageEntryPrice;
    }

    return pendingBuyExposure + heldExposure;
  }

  private _createOrderEntry(
    order: {
      action: "buy" | "sell";
      tokenId: string;
      price: number;
      shares: number;
    },
    status: "placed" | "filled" | "failed" | "expired" | "canceled",
    opts?: { shares?: number; reason?: string },
  ) {
    return {
      type: "order" as const,
      action: order.action,
      side: this._side(order.tokenId),
      price: order.price,
      shares: opts?.shares ?? order.shares,
      status,
      reason: opts?.reason,
    };
  }

  /** Lock tracker reservation for a pending order (buy or sell). */
  private _trackerLock(req: OrderRequest, order: PlacedOrder): void {
    const side = this._side(req.req.tokenId);
    const label = `[${this.slug}] ${req.req.action.toUpperCase()} ${side} @ ${req.req.price}`;
    if (req.req.action === "buy") {
      this._tracker.lockForBuy(
        order.orderId,
        req.req.price,
        req.req.shares,
        label,
      );
    } else {
      this._tracker.lockForSell(
        order.orderId,
        req.req.tokenId,
        req.req.shares,
        label,
      );
    }
  }

  /** Unlock tracker reservation for a pending order (buy or sell). */
  private _trackerUnlock(pending: PendingOrder): void {
    const side = this._side(pending.tokenId);
    const label = `[${this.slug}] ${pending.action.toUpperCase()} ${side} @ ${pending.price}`;
    if (pending.action === "buy")
      this._tracker.unlockBuy(pending.orderId, label);
    else this._tracker.unlockSell(pending.orderId, label);
  }

  private _hasUnfilledPositions(): boolean {
    const held = new Map<string, number>();
    for (const o of this._orderHistory) {
      const cur = held.get(o.tokenId) ?? 0;
      if (o.action === "buy") held.set(o.tokenId, cur + o.shares);
      else held.set(o.tokenId, cur - o.shares);
    }
    for (const shares of held.values()) {
      if (shares > 0) return true;
    }
    return false;
  }

  private async _autoRedeem(): Promise<void> {
    if (!this._conditionId) return; // belt-and-suspenders

    this._log(`[${this.slug}] Redeeming positions...`, "dim");
    try {
      await this.client.redeemPositions(this._conditionId, true);
      this._log(`[${this.slug}] Redemption successful`, "green");
    } catch (e) {
      this._log(`[${this.slug}] Redemption failed: ${e}`, "red");
    }
  }

  private _resolutionWaitStartMs: number | null = null;
  private _checkResolutionSync(): boolean {
    const slot = slotFromSlug(this.slug);
    if (!this._marketPriceHandle) {
      this._marketPriceHandle = this.apiQueue.queueMarketPrice(slot);
    }

    const data = this.apiQueue.marketResult.get(slot.startTime);
    if (data?.closePrice) return true;

    if (this._resolutionWaitStartMs === null) {
      this._resolutionWaitStartMs = this._clock.nowMs();
    }

    return false;
  }

  private _triggerFatalError(e: Error): void {
    this._log(`[${this.slug}] FATAL ERROR: ${e.message}`, "red");
    this._isInvalid = true;
    this._telemetry.push({
      ts: this._clock.nowMs(),
      type: "INVALID_RUN",
      payload: { reason: e.message }
    });
    this._setState("DONE");
  }

  private _computePnl(): void {
    if (this._isInvalid) {
      this._log(`[${this.slug}] Skipping PnL computation for invalid run.`, "red");
      throw new Error("Run marked as invalid. PnL suppressed.");
    }
    
    let pnl = 0;
    const held = new Map<string, number>();

    for (const o of this._orderHistory) {
      if (o.action === "sell") pnl += o.price * o.shares;
      else pnl -= o.price * o.shares;
      pnl -= o.fee ?? 0;

      const cur = held.get(o.tokenId) ?? 0;
      if (o.action === "buy") held.set(o.tokenId, cur + o.shares);
      else held.set(o.tokenId, cur - o.shares);
    }

    for (const [tokenId, shares] of held) {
      if (shares < -1e-9) {
        const reason = `negative inventory at settlement for ${tokenId}: ${shares}`;
        this._appendEvent("operator_action", "market-lifecycle", {
          action: "settlement_invariant_violation",
          reason,
          status: "failed",
        });
        throw new Error(`position invariant violation: ${reason}`);
      }
    }

    const slot = slotFromSlug(this.slug).startTime;
    const data = this.apiQueue.marketResult.get(slot);

    if (data?.closePrice) {
      const resolvedUp = data.closePrice > data.openPrice;
      const upToken = this._clobTokenIds![0];
      let unfilledShares = 0;
      let payout = 0;

      for (const [tokenId, shares] of held) {
        if (shares <= 0) continue;
        unfilledShares += shares;
        const isUp = tokenId === upToken;
        const payoutPerShare =
          (resolvedUp && isUp) || (!resolvedUp && !isUp) ? 1.0 : 0.0;
        payout += shares * payoutPerShare;
      }
      pnl += payout;

      this._tracker.onResolution(held, payout);
      this._pnl = parseFloat(pnl.toFixed(4));
      this._log(
        `[${this.slug}] Resolved ${resolvedUp ? "UP" : "DOWN"}. PnL: ${this._pnl >= 0 ? "+" : ""}$${this._pnl.toFixed(2)}`,
        this._pnl >= 0 ? "green" : "red",
      );
      this._marketLogger.log({
        type: "resolution",
        direction: resolvedUp ? "UP" : "DOWN",
        openPrice: data.openPrice,
        closePrice: data.closePrice,
        unfilledShares,
        payout,
        pnl: this._pnl,
      });
      this._telemetry.push({
        ts: this._clock.nowMs(),
        type: "ROUND_RESOLUTION",
        payload: {
          slug: this.slug,
          openPrice: data.openPrice,
          closePrice: data.closePrice,
          direction: resolvedUp ? "UP" : "DOWN",
        },
      });
      this._appendEvent("settlement_result", "market-lifecycle", {
        openPrice: data.openPrice,
        closePrice: data.closePrice,
        direction: resolvedUp ? "UP" : "DOWN",
        payout,
        pnl: this._pnl,
      });
      this._emitDecisionFeature("settled", {
        snapshot: this._createRiskSnapshot(),
        pnl: this._pnl,
        resolutionDirection: resolvedUp ? "UP" : "DOWN",
      });
    } else {
      this._pnl = parseFloat(pnl.toFixed(4));
      this._log(
        `[${this.slug}] Settled. PnL: ${this._pnl >= 0 ? "+" : ""}$${this._pnl.toFixed(2)}`,
        this._pnl >= 0 ? "green" : "red",
      );
    }
    
    this._telemetry.push({
      ts: this._clock.nowMs(),
      type: "ROUND_PNL",
      payload: { slug: this.slug, pnl: this._pnl }
    });
  }

  private _emitSpreadDepthSnapshot(): void {
    const nowMs = this._clock.nowMs();
    if (nowMs - this._lastSpreadDepthEventMs < 1000) return;
    this._lastSpreadDepthEventMs = nowMs;

    const venue = this._venue.latest();
    if (!venue) return;
    const spreadUp =
      venue.bestBidUp !== null && venue.bestAskUp !== null
        ? parseFloat((venue.bestAskUp - venue.bestBidUp).toFixed(6))
        : null;
    const spreadDown =
      venue.bestBidDown !== null && venue.bestAskDown !== null
        ? parseFloat((venue.bestAskDown - venue.bestBidDown).toFixed(6))
        : null;
    const depth = (levels: Array<[number, number]> | undefined) =>
      levels?.slice(0, 5).reduce((sum, [price, size]) => sum + price * size, 0) ?? null;
    this._appendEvent("spread_depth_snapshot", "market-lifecycle", {
      conditionId: this._conditionId,
      clobTokenIds: this._clobTokenIds,
      side: "BOTH",
      bestBidUp: venue.bestBidUp,
      bestAskUp: venue.bestAskUp,
      bestBidDown: venue.bestBidDown,
      bestAskDown: venue.bestAskDown,
      spreadUp,
      spreadDown,
      depthUpUsd:
        venue.up ? parseFloat(((depth(venue.up.bids) ?? 0) + (depth(venue.up.asks) ?? 0)).toFixed(6)) : null,
      depthDownUsd:
        venue.down ? parseFloat(((depth(venue.down.bids) ?? 0) + (depth(venue.down.asks) ?? 0)).toFixed(6)) : null,
      feeRateBps: venue.feeRateBps ?? null,
    });
  }

  private _appendEvent(
    eventType: ProfitEventType,
    source: string,
    payload: ProfitEventPayload,
    intentId?: string,
  ): void {
    if (!this._eventWriter) return;
    void this._eventWriter.append({
      eventType,
      source,
      slug: this.slug,
      roundId: this.slug,
      strategyId: this._strategyName,
      payload,
      eventId: intentId ? `${eventType}-${intentId}-${this._clock.nowMs()}` : undefined,
      receivedTsMs: this._clock.nowMs(),
      processedTsMs: this._clock.nowMs(),
    }).catch((error) => {
      this._log(`[event-store] failed to write ${eventType}: ${error}`, "red");
    });
  }
}
