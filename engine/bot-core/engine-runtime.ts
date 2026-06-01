import { APIQueue } from "../../tracker/api-queue.ts";
import type { EarlyBirdClient } from "../client.ts";
import { EarlyBirdSimClient, PolymarketEarlyBirdClient } from "../client.ts";
import { MarketLifecycle } from "../market-lifecycle.ts";
import { PolymarketUserChannel, SimUserChannel } from "../user-channel.ts";
import type { UserChannel } from "../user-channel.ts";
import { loadState, saveState, type CompletedMarketState } from "../state.ts";
import { getSlug } from "../../utils/slot.ts";
import { log } from "../log.ts";
import { recover } from "../recovery.ts";
import { MaintenanceTracker } from "../../utils/maintenance.ts";
import {
  DEFAULT_STRATEGY,
  type Strategy,
  resolveStrategySelection,
} from "../strategy/index.ts";
import { WalletTracker } from "../wallet-tracker.ts";
import { TickerTracker } from "../../tracker/ticker.ts";
import { OrderBook } from "../../tracker/orderbook.ts";
import { TradeTapeTracker } from "../../tracker/trade-tape.ts";
import { Env } from "../../utils/config.ts";
import {
  ChainlinkResolutionAdapter,
  BinancePredictiveAdapter,
  CoinbasePredictiveAdapter,
  DefaultPredictiveAggregator,
  DefaultLeadLagMonitor,
  DefaultQuantMonitor,
  ReplayLogReader,
  ReplayPredictiveAdapter,
  ReplayVenueAdapter,
  ReplayResolutionAdapter,
  ReplayTickerTracker,
  ReplayOrderBook,
  type ReplayMarketResult,
  type ResolutionSourceAdapter,
  type PredictiveFeedAdapter,
  type VenueDataAdapter,
  type RoundWindow,
  type BotFeedEvent,
  type Clock,
  RealClock,
  buildBotInfrastructure,
} from "./index.ts";
import { 
  TerminalAccessError, 
  InsufficientBalanceError, 
  LossLimitExceededError 
} from "../../utils/errors.ts";
import { 
  type TelemetrySink, 
  NullTelemetrySink, 
  type TelemetryEvent 
} from "../telemetry/index.ts";
import {
  NdjsonEventWriter,
  type EventWriter,
} from "../event-store/writer.ts";
import type { VenueMetadata } from "./index.ts";
import { CounterfactualRiskGate, type CounterfactualRiskMode } from "../replay/counterfactual-risk-gate.ts";
import { MarketSpawner } from "./market-spawner.ts";
import { type RiskGate } from "./risk-gate.ts";

const SAVE_INTERVAL_MS = 5000;

export type EngineRuntimeOptions = {
  clock?: Clock;
  persistState?: boolean;
  telemetry?: TelemetrySink;
  strategyConfigOverride?: Record<string, unknown>;
  presetId?: string;
  orderBookFactory?: (clock: Clock, tradeTape: TradeTapeTracker) => OrderBook;
  eventWriter?: EventWriter;
  marketLogMode?: "normal" | "disabled";
  replayVenueMetadata?: Partial<VenueMetadata>;
  conservativeFill?: boolean;
  riskMode?: CounterfactualRiskMode;
  bypassRiskReasons?: string[];
  initialBalance?: number;
};

export type EngineStatus = {
  mode: "live" | "sim" | "replay";
  strategy: string;
  activeLifecycles: number;
  isShuttingDown: boolean;
  sessionPnl: number;
  sessionLoss: number;
  summary: string;
};

export class EngineRuntime {
  private _completedMarkets: CompletedMarketState[] = [];
  private _client: EarlyBirdClient;
  private _apiQueue = new APIQueue();
  private _sessionPnl = 0;
  private _sessionLoss = 0;
  private _shuttingDown = false;
  private _spawner!: MarketSpawner;
  private _lastSaveMs = 0;
  private readonly _strategyName: string;
  private readonly _strategy: Strategy;
  private readonly _strategyConfig: Record<string, unknown>;
  private readonly _presetId?: string;
  private readonly _slotOffset: number;

  private readonly _statePath: string;
  private readonly _rounds: number | null; // null = unlimited
  private readonly _prod: boolean;
  private readonly _minSessionPnl: number;
  private readonly _maxSessionProfit: number;
  private readonly _alwaysLog: boolean;
  private _initialBalanceOverride?: number;
  private _tracker!: WalletTracker;
  private _ticker: TickerTracker;
  private _tradeTape: TradeTapeTracker;
  private _resolution: ResolutionSourceAdapter;
  private _binance: PredictiveFeedAdapter;
  private _coinbase: PredictiveFeedAdapter;
  private _aggregator: DefaultPredictiveAggregator;
  private _leadLag: DefaultLeadLagMonitor;
  private _quant: DefaultQuantMonitor;
  private _maintenance: MaintenanceTracker;
  private _userChannelFactory: (() => UserChannel) | null = null;
  private _replayReader: ReplayLogReader | null = null;
  private _clock: Clock;
  private _persistState = true;
  private _conservativeFill = false;
  private _telemetry: TelemetrySink;
  private _eventWriter: EventWriter;
  private readonly _marketLogMode: "normal" | "disabled";
  private readonly _replayVenueMetadata?: Partial<VenueMetadata>;
  private readonly _riskGate: RiskGate;
  private _runCompletedEventEmitted = false;
  private readonly _orderBookFactory?: (
    clock: Clock,
    tradeTape: TradeTapeTracker,
  ) => OrderBook;

  constructor(
    strategyName: string | undefined,
    slotOffset = 1,
    prod = false,
    rounds: number | null = null,
    alwaysLog = false,
    replayFile?: string,
    clockOrOptions?: Clock | EngineRuntimeOptions,
  ) {
    const runtime =
      clockOrOptions && "nowMs" in clockOrOptions
        ? { clock: clockOrOptions }
        : (clockOrOptions ?? {});
    this._prod = prod;
    this._statePath = prod
      ? "state/early-bird-prod.json"
      : "state/early-bird.json";
    this._rounds = rounds;
    const resolvedStrategy = resolveStrategySelection(strategyName ?? DEFAULT_STRATEGY);
    this._strategyName = resolvedStrategy.selection;
    this._strategy = resolvedStrategy.strategy;
    this._strategyConfig = { ...resolvedStrategy.config, ...(runtime.strategyConfigOverride ?? {}) };
    this._presetId = runtime.presetId;
    this._slotOffset = slotOffset;
    this._alwaysLog = alwaysLog;
    this._minSessionPnl = parseFloat(process.env.MAX_SESSION_LOSS ?? "3");
    this._maxSessionProfit = parseFloat(process.env.MAX_SESSION_PROFIT ?? "1000000");
    this._clock = runtime.clock ?? new RealClock();
    this._telemetry = runtime.telemetry ?? new NullTelemetrySink();
    this._marketLogMode = runtime.marketLogMode ?? "normal";
    this._replayVenueMetadata = runtime.replayVenueMetadata;
    this._eventWriter =
      runtime.eventWriter ??
      new NdjsonEventWriter({
        runId: `early-bird-${replayFile ? "replay" : prod ? "live" : "sim"}-${crypto.randomUUID()}`,
        nowMs: () => this._clock.nowMs(),
      });
    this._orderBookFactory = runtime.orderBookFactory;
    const persistState = runtime.persistState ?? !replayFile;
    const conservativeFill = runtime.conservativeFill ?? false;
    this._initialBalanceOverride = runtime.initialBalance;

    this._riskGate = new CounterfactualRiskGate({
      mode: runtime.riskMode ?? "normal",
      bypassReasons: runtime.bypassRiskReasons,
      replayOnly: !!replayFile,
    });

    const infra = buildBotInfrastructure({
      replayFile,
      clock: this._clock,
      telemetry: this._telemetry,
      strategyConfig: this._strategyConfig,
    });

    if (infra.replayReader) {
      this._replayReader = infra.replayReader;
    }
    this._ticker = infra.ticker as TickerTracker;
    this._resolution = infra.resolution;
    this._binance = infra.binance;
    this._coinbase = infra.coinbase;
    this._aggregator = infra.aggregator;
    this._leadLag = infra.leadLag;
    this._quant = infra.quant;
    this._tradeTape = new TradeTapeTracker({
      asset: Env.get("MARKET_ASSET"),
      clock: this._clock,
    });
    this._maintenance = new MaintenanceTracker();
    this._apiQueue = new APIQueue({
      maintenance: this._maintenance,
    });

    if (prod) {
      this._client = new PolymarketEarlyBirdClient();
    } else {
      this._client = new EarlyBirdSimClient((tokenId) => {
        const lifecycles = this._spawner ? this._spawner.getActiveLifecycles() : new Map<string, MarketLifecycle>();
        for (const lifecycle of lifecycles.values()) {
          const snap = lifecycle.getBookSnapshot(tokenId);
          if (snap) return snap;
        }
        return {
          bids: [],
          asks: [],
          lastTradePrice: null,
          lastTradeSize: null,
        };
      }, {
        clock: this._clock,
        fixedDelayMs: replayFile ? 0 : undefined,
        conservativeFill: runtime.conservativeFill,
      });
    }

    this._persistState = persistState;
    this._conservativeFill = conservativeFill;

    this._telemetry.push({
      ts: this._clock.nowMs(),
      type: "SYSTEM_BOOT",
      payload: {
        version: "0.0.1",
        mode: replayFile ? "replay" : (prod ? "live" : "sim"),
        strategy: this._strategyName
      }
    });
    void this._eventWriter.append({
      eventType: "run_started",
      source: "early-bird",
      strategyId: this._strategyName,
      payload: {
        mode: replayFile ? "replay" : (prod ? "live" : "sim"),
        status: "started",
        commitSha: process.env.GIT_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA || "local",
      },
    }).catch((error) => {
      log.write(`[event-store] failed to write run_started: ${error}`, "red");
    });
  }

  async start(): Promise<void> {
    try {
      log.write("[startup] Starting");
      if (this._replayReader) {
        await this._replayReader.init();
      }
      this._ticker.schedule();
      log.write("[startup] Waiting for ticker ready");
      await this._ticker.waitForReady();
      log.write(`[startup] ${Env.getAssetConfig().apiSymbol} ticker ready`);

      log.write("[startup] Starting resolution adapter");
      await this._resolution.start();
      log.write(`[startup] ${Env.getAssetConfig().apiSymbol} resolution adapter ready`);

      log.write("[startup] Starting binance adapter");
      await this._binance.start();
      log.write(`[startup] ${Env.getAssetConfig().apiSymbol} binance predictive adapter ready`);

      log.write("[startup] Starting coinbase adapter");
      await this._coinbase.start();
      log.write(`[startup] ${Env.getAssetConfig().apiSymbol} coinbase predictive adapter ready`);

      log.write("[startup] Initializing client");
      await this._client.init();
      log.write("[startup] Client initialized");

      if (this._prod) {
        const creds = (this._client as PolymarketEarlyBirdClient).getApiCreds();
        this._userChannelFactory = () =>
          new PolymarketUserChannel({ creds, client: this._client, clock: this._clock });
      } else {
        const simClient = this._client as EarlyBirdSimClient;
        this._userChannelFactory = () =>
          new SimUserChannel({
            getBook: (tokenId) => {
              const lifecycles = this._spawner ? this._spawner.getActiveLifecycles() : new Map<string, MarketLifecycle>();
        for (const lifecycle of lifecycles.values()) {
                const snap = lifecycle.getBookSnapshot(tokenId);
                if (snap) return snap;
              }
              return {
                bids: [],
                asks: [],
                lastTradePrice: null,
                lastTradeSize: null,
              };
            },
            cancelCallbacks: simClient.cancelCallbacks,
            clock: this._clock,
            conservativeFill: this._conservativeFill,
          });
      }

      // Seed wallet tracker
      let initialBalance: number;
      if (this._prod) {
        await this._client.updateUSDCBalance();
        initialBalance = await this._client.getUSDCBalance();
        log.write(`[startup] On-chain balance: $${initialBalance.toFixed(2)}`);
        if (initialBalance === 0) {
          throw new InsufficientBalanceError(
            "Wallet balance is $0.00. Fund your funder wallet with pUSD before starting the engine.\n" +
            "Run `bun scripts/pusd.ts wrap` to convert USDC.e → pUSD, or see docs/MIGRATE_V2.md."
          );
        }
      } else {
        initialBalance = this._initialBalanceOverride ?? parseFloat(process.env.WALLET_BALANCE ?? "50");
        log.write(`[startup] Sim balance: $${initialBalance.toFixed(2)}`);
      }
      this._tracker = new WalletTracker(initialBalance, (msg) =>
        log.write(msg, "dim"),
      );

      log.write(
        `[startup] Min session PnL exit: $${this._minSessionPnl.toFixed(2)}`,
      );


      this._spawner = new MarketSpawner({
        botContext: {
          ticker: this._ticker,
          resolution: this._resolution,
          binance: this._binance,
          coinbase: this._coinbase,
          aggregator: this._aggregator,
          leadLag: this._leadLag,
          quant: this._quant,
          replayReader: this._replayReader ? this._replayReader : undefined,
        },
        client: this._client,
        apiQueue: this._apiQueue,
        tradeTape: this._tradeTape,
        orderBookFactory: this._orderBookFactory,
        strategyName: this._strategyName,
        strategy: this._strategy,
        strategyConfig: this._strategyConfig,
        presetId: this._presetId,
        slotOffset: this._slotOffset,
        prod: this._prod,
        marketLogMode: this._marketLogMode,
        rounds: this._rounds,
        riskGate: this._riskGate,
        clock: this._clock,
        telemetry: this._telemetry,
        alwaysLog: this._alwaysLog,
        eventWriter: this._eventWriter,
        maintenance: this._maintenance,
        conservativeFill: this._conservativeFill,
        tracker: this._tracker,
        userChannelFactory: this._userChannelFactory!,
        replayVenueMetadata: this._replayVenueMetadata,
        onLifecycleDone: (slug, lifecycle) => {
          this._sessionPnl = parseFloat((this._sessionPnl + lifecycle.pnl).toFixed(4));
          if (lifecycle.pnl < 0) {
            this._sessionLoss = parseFloat((this._sessionLoss + lifecycle.pnl).toFixed(4));
          }
          log.write(`[${slug}] Session PnL: ${this._sessionPnl >= 0 ? "+" : ""}$${this._sessionPnl.toFixed(2)}`, this._sessionPnl >= 0 ? "green" : "red");
          this._telemetry.push({
            ts: this._clock.nowMs(),
            type: "SESSION_PNL",
            payload: { pnl: this._sessionPnl, loss: this._sessionLoss }
          });
          this._completedMarkets.push({
            slug,
            strategyName: lifecycle.strategyName,
            pnl: lifecycle.pnl,
            orderHistory: lifecycle.orderHistory,
          });

          if (Math.abs(this._sessionLoss) >= this._minSessionPnl) {
            this._startShutdown(`Session loss limit reached (total losses: $${this._sessionLoss.toFixed(2)}, threshold: -$${this._minSessionPnl.toFixed(2)}).`);
          }
          if (this._sessionPnl >= this._maxSessionProfit) {
            this._startShutdown(`Session profit target reached (total PnL: +$${this._sessionPnl.toFixed(2)}, target: +$${this._maxSessionProfit.toFixed(2)}).`);
          }
        },
        onTerminalError: (slug, err) => {
          this._startShutdown("Terminal Access Error");
        },
        onRoundsExhausted: () => {
          this._startShutdown(`All ${this._rounds} round(s) complete.`);
        }
      });

      if (this._replayReader) {
        log.write("[startup] Replay mode: skipping saved state recovery.");
      } else {
        const state = loadState(this._statePath);
        if (state) {
          log.write(`[startup] Loading state from ${this._statePath}`);
          this._sessionPnl = state.sessionPnl;
          this._sessionLoss = state.sessionLoss ?? 0;

          if (Math.abs(this._sessionLoss) >= this._minSessionPnl) {
            throw new LossLimitExceededError(
              `Session loss from previous session ($${this._sessionLoss.toFixed(2)}) already meets or exceeds the MAX_SESSION_LOSS threshold (-$${this._minSessionPnl.toFixed(2)}). ` +
              `To start fresh, reset "sessionLoss" to 0 in ${this._statePath}, or increase MAX_SESSION_LOSS in your .env.`
            );
          }

          // Sim recovery: replay order history to reconstruct balance
          if (!this._prod) {
            for (const market of state.activeMarkets) {
              for (const order of market.orderHistory) {
                if (order.action === "buy")
                  this._tracker.debit(order.price * order.shares);
                else this._tracker.credit(order.price * order.shares);
              }
            }
          }

          const recovered = await recover(
            state,
            this._client,
            this._apiQueue,
            (msg, color) => log.write(msg, color),
            this._tracker,
            this._ticker,
            this._userChannelFactory!,
            this._orderBookFactory,
            this._clock,
            this._tradeTape,
            this._prod,
          );
          for (const [slug, lifecycle] of recovered) {
            this._spawner.injectRecoveredLifecycle(slug, lifecycle);
          }
          if (this._prod && this._persistState) {
            this._saveState();
          }
        } else {
          log.write("[startup] No saved state found. Starting fresh.");
        }
      }

      process.on("exit", () => {
        log.flush();
        if (this._persistState) this._saveState();
      });

      const onSignal = (sig: string) => {
        log.write(
          `[shutdown] ${sig} received. Initiating graceful shutdown...`,
          "yellow",
        );
        log.flush();
        if (this._persistState) this._saveState();
        this._startShutdown(`${sig} received.`);
      };
      process.on("SIGINT", () => onSignal("SIGINT"));
      process.on("SIGTERM", () => onSignal("SIGTERM"));

      await this._spawner.start();
    } catch (e) {
      if (e instanceof TerminalAccessError) {
        throw new Error(`Terminal Access Error: ${e.message}`);
      }
      throw e;
    }
  }

  get replayReader(): ReplayLogReader | null {
    return this._replayReader;
  }

  get activeLifecycleCount(): number {
    return this._spawner ? this._spawner.activeLifecycleCount : 0;
  }

  get isShuttingDown(): boolean {
    return this._shuttingDown;
  }

  getStatus(): EngineStatus {
      return {
          mode: this._replayReader ? "replay" : (this._prod ? "live" : "sim"),
          strategy: this._strategyName,
          activeLifecycles: (this._spawner ? this._spawner.activeLifecycleCount : 0),
          isShuttingDown: this._shuttingDown,
          sessionPnl: this._sessionPnl,
          sessionLoss: this._sessionLoss,
          summary: this.replayStateSummary()
      };
  }

  replayStateSummary(): string {
    return [...(this._spawner ? this._spawner.getActiveLifecycles().values() : [])]
      .map((l) => `${l.slug}:${l.state}(pending=${l.pendingOrders.length})`)
      .join(", ");
  }

  nextReplayDeadlineMs(): number | null {
    let next: number | null = null;
    const consider = (value: number) => {
      if (value >= this._clock.nowMs() && (next === null || value < next)) {
        next = value;
      }
    };
    const lifecycles = this._spawner ? this._spawner.getActiveLifecycles() : new Map<string, MarketLifecycle>();
        for (const lifecycle of lifecycles.values()) {
      consider(lifecycle.slotEndMs);
      for (const order of lifecycle.pendingOrders) {
        consider(order.expireAtMs);
      }
    }
    return next;
  }

  async tickOnce(): Promise<void> {
    if (this._spawner) await this._spawner.tickOnce();
  }

  startShutdown(reason: string): void {
    this._startShutdown(reason);
  }

  applyReplayMarketResult(result: ReplayMarketResult): void {
    if (!this._replayReader) return;
    if (this._spawner) this._spawner.applyReplayMarketResult(result);
    this._apiQueue.marketResult.set(result.startTime, {
      startTime: result.startTime,
      endTime: result.endTime,
      completed: result.completed,
      openPrice: result.openPrice,
      closePrice: result.closePrice,
    });
  }

  async stop(): Promise<void> {
    this._startShutdown("Explicit stop requested");
    if (this._spawner) await this._spawner.stop();
    this._ticker.destroy();
    this._resolution.stop();
    this._binance.stop();
    this._coinbase.stop();
    await this._emitRunCompleted("canceled");
    log.write("[engine-runtime] Stopped all adapters", "dim");
  }

  private async _emitRunCompleted(status: "completed" | "failed" | "canceled"): Promise<void> {
    if (this._runCompletedEventEmitted) return;
    this._runCompletedEventEmitted = true;
    await this._eventWriter.append({
      eventType: "run_completed",
      source: "early-bird",
      strategyId: this._strategyName,
      payload: {
        status,
        mode: this._replayReader ? "replay" : (this._prod ? "live" : "sim"),
        reason: this._shuttingDown ? "shutdown" : undefined,
      },
    }).catch((error) => {
      log.write(`[event-store] failed to write run_completed: ${error}`, "red");
    });
    await this._eventWriter.close().catch((error) => {
      log.write(`[event-store] failed to close writer: ${error}`, "red");
    });
  }

  private _startShutdown(reason: string): void {
    if (this._shuttingDown) return;
    this._shuttingDown = true;
    log.write(`[shutdown] ${reason}`, "yellow");
    log.write("[shutdown] Signalling all lifecycles to cancel.", "yellow");

    if (this._spawner) this._spawner.startShutdown();

    const stoppingCount = [...(this._spawner ? this._spawner.getActiveLifecycles().values() : [])].filter(
      (l) => l.state === "STOPPING",
    ).length;

    if (stoppingCount > 0) {
      log.write(
        `[shutdown] Waiting for ${stoppingCount} lifecycle(s) to settle...`,
      );
    }
  }

  private _saveState(): void {
    if (!this._persistState) return;
    this._lastSaveMs = this._clock.nowMs();
    const activeMarkets = [...(this._spawner ? this._spawner.getActiveLifecycles().entries() : [])]
      .filter(([, l]) => l.state === "RUNNING" || l.state === "STOPPING")
      .map(([slug, l]) => ({
        slug,
        state: l.state as "RUNNING" | "STOPPING",
        strategyName: l.strategyName,
        conditionId: l.conditionId!,
        clobTokenIds: l.clobTokenIds!,
        pendingOrders: l.pendingOrders,
        orderHistory: l.orderHistory,
      }));

    saveState(this._statePath, {
      sessionPnl: this._sessionPnl,
      sessionLoss: this._sessionLoss,
      activeMarkets,
      completedMarkets: this._completedMarkets,
    });
  }
}

