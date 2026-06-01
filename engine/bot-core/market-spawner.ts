import type { BotInfrastructure, VenueMetadata, ReplayMarketResult } from "./index.ts";
import type { EarlyBirdClient } from "../client.ts";
import type { APIQueue } from "../../tracker/api-queue.ts";
import type { TradeTapeTracker } from "../../tracker/trade-tape.ts";
import { OrderBook } from "../../tracker/orderbook.ts";
import type { RiskGate } from "./risk-gate.ts";
import type { TelemetrySink } from "../telemetry/index.ts";
import type { EventWriter } from "../event-store/writer.ts";
import type { MaintenanceTracker } from "../../utils/maintenance.ts";
import type { Strategy } from "../strategy/index.ts";
import type { UserChannel } from "../user-channel.ts";
import type { WalletTracker } from "../wallet-tracker.ts";
import type { Clock } from "./data-sources.ts";
import { getSlug } from "../../utils/slot.ts";
import { ReplayVenueAdapter } from "./replay-venue-adapter.ts";
import { ReplayOrderBook } from "./replay-orderbook.ts";
import { MarketLifecycle } from "../market-lifecycle.ts";
import { TerminalAccessError } from "../../utils/errors.ts";
import { log } from "../log.ts";

export interface MarketSpawnerOptions {
  botContext: BotInfrastructure;
  client: EarlyBirdClient;
  apiQueue: APIQueue;
  tradeTape: TradeTapeTracker;
  orderBookFactory?: (clock: Clock, tradeTape: TradeTapeTracker) => OrderBook;
  strategyName: string;
  strategy: Strategy;
  strategyConfig: Record<string, unknown>;
  presetId?: string;
  slotOffset: number;
  prod: boolean;
  marketLogMode: "normal" | "disabled";
  rounds: number | null;
  riskGate: RiskGate;
  clock: Clock;
  telemetry: TelemetrySink;
  alwaysLog: boolean;
  eventWriter: EventWriter;
  maintenance: MaintenanceTracker;
  conservativeFill: boolean;
  tracker: WalletTracker;
  userChannelFactory: () => UserChannel;
  replayVenueMetadata?: Partial<VenueMetadata>;

  onLifecycleDone: (slug: string, lifecycle: MarketLifecycle) => void;
  onTerminalError: (slug: string, error: TerminalAccessError) => void;
  onRoundsExhausted: () => void;
}

export class MarketSpawner {
  private _lifecycles = new Map<string, MarketLifecycle>();
  private _completedSlugs = new Set<string>();
  private _shuttingDown = false;
  private _roundsCreated = 0;
  private _tickInterval: unknown = null;
  private _lastPrefetchMs = 0;
  private _opts: MarketSpawnerOptions;

  constructor(options: MarketSpawnerOptions) {
    this._opts = options;
  }

  public get isShuttingDown(): boolean { return this._shuttingDown; }

  /**
   * Restores a lifecycle from persistent state into the active orchestration pool.
   * This is explicitly used for production crash-recovery by EarlyBird.
   * 
   * @throws Error if the spawner is already shutting down.
   * @throws Error if a lifecycle with the given slug already exists.
   */
  public injectRecoveredLifecycle(slug: string, lifecycle: MarketLifecycle): void {
    if (this._shuttingDown) {
      throw new Error(`[spawner] Cannot inject recovered lifecycle ${slug} during shutdown.`);
    }
    if (this._lifecycles.has(slug)) {
      throw new Error(`[spawner] Cannot inject recovered lifecycle ${slug}: already exists.`);
    }
    this._lifecycles.set(slug, lifecycle);
  }

  public getActiveLifecycles(): Map<string, MarketLifecycle> {
    return new Map(this._lifecycles);
  }

  public applyReplayMarketResult(result: ReplayMarketResult): void {
    if (!this._opts.botContext.replayReader) return;
    this._opts.apiQueue.marketResult.set(result.startTime, {
      startTime: result.startTime,
      endTime: result.endTime,
      completed: result.completed,
      openPrice: result.openPrice,
      closePrice: result.closePrice,
    });
  }

  public get activeLifecycleCount(): number {
    return this._lifecycles.size;
  }

  public async start(): Promise<void> {
    if (!this._opts.botContext.replayReader) {
      log.write("[startup] Initializing predictive pre-fetching...");
      await this._opts.apiQueue.prefetchFutureRounds();
      this._lastPrefetchMs = this._opts.clock.nowMs();

      this._tickInterval = this._opts.clock.setInterval(() => {
        this._tick().catch((e) => {
          if (e instanceof TerminalAccessError) {
            console.error(`\n[fatal] ${e.message}\n`);
            this._opts.onTerminalError("spawner", e);
            this.startShutdown();
          } else {
            log.write(`[engine] tick error: ${e}`, "red");
          }
        });
      }, 10);
    }
  }

  public async stop(): Promise<void> {
    this.startShutdown();
    if (this._tickInterval) {
      this._opts.clock.clearInterval(this._tickInterval);
      this._tickInterval = null;
    }

    // Wait for lifecycles to settle
    let attempts = 0;
    while (this._lifecycles.size > 0 && attempts < 20) {
      await this.tickOnce();
      await new Promise((r) => setTimeout(r, 500));
      attempts++;
    }
    if (this._lifecycles.size > 0) {
      log.write(`[shutdown] ${this._lifecycles.size} lifecycle(s) failed to stop cleanly. Force clearing.`, "red");
      this._lifecycles.clear();
    }
  }

  public async tickOnce(): Promise<void> {
    await this._tick();
  }

  public startShutdown(): void {
    if (this._shuttingDown) return;
    this._shuttingDown = true;
    log.write("[shutdown] Signalling all lifecycles to cancel.", "yellow");

    for (const [, lifecycle] of this._lifecycles) {
      lifecycle.shutdown();
    }

    const stoppingCount = [...this._lifecycles.values()].filter(
      (l) => l.state === "STOPPING",
    ).length;

    if (stoppingCount > 0) {
      log.write(
        `[shutdown] Waiting for ${stoppingCount} lifecycle(s) to settle...`,
      );
    }
  }

  private async _tick(): Promise<void> {
    const roundsExhausted =
      this._opts.rounds !== null && this._roundsCreated >= this._opts.rounds;
      
    if (!this._shuttingDown && !roundsExhausted) {
      const slug = this._opts.botContext.replayReader
        ? this._opts.botContext.replayReader.round?.slug
        : getSlug(this._opts.slotOffset);

      if (slug && !this._lifecycles.has(slug) && !this._completedSlugs.has(slug)) {
        const venue = this._opts.botContext.replayReader
          ? new ReplayVenueAdapter(this._opts.botContext.replayReader, this._opts.replayVenueMetadata)
          : undefined;

        const orderBook = this._opts.botContext.replayReader
          ? new ReplayOrderBook(this._opts.botContext.replayReader, this._opts.clock, this._opts.tradeTape)
          : this._opts.orderBookFactory
            ? this._opts.orderBookFactory(this._opts.clock, this._opts.tradeTape)
            : new OrderBook(this._opts.clock, this._opts.tradeTape);

        this._lifecycles.set(
          slug,
          new MarketLifecycle({
            slug,
            apiQueue: this._opts.apiQueue,
            client: this._opts.client,
            log: (msg, color) => log.write(msg, color),
            strategyName: this._opts.strategyName,
            strategy: this._opts.strategy,
            strategyConfig: this._opts.strategyConfig,
            presetId: this._opts.presetId,
            tracker: this._opts.tracker,
            ticker: this._opts.botContext.ticker,
            userChannel: this._opts.userChannelFactory(),
            resolution: this._opts.botContext.resolution,
            binance: this._opts.botContext.binance,
            coinbase: this._opts.botContext.coinbase,
            aggregator: this._opts.botContext.aggregator,
            leadLag: this._opts.botContext.leadLag,
            quant: this._opts.botContext.quant,
            maintenance: this._opts.maintenance,
            venue,
            orderBook,
            riskGate: this._opts.riskGate,
            clock: this._opts.clock,
            telemetry: this._opts.telemetry,
            alwaysLog: this._opts.alwaysLog,
            marketLogMode: this._opts.marketLogMode,
            eventWriter: this._opts.eventWriter,
            liveMode: this._opts.prod,
          }),
        );
        this._roundsCreated++;
      }
    }

    // Tick all lifecycles
    const done: string[] = [];
    for (const [slug, lifecycle] of this._lifecycles) {
      try {
        await lifecycle.tick();
      } catch (e) {
        if (e instanceof TerminalAccessError) {
          console.error(`\n[fatal] [${slug}] ${e.message}\n`);
          this._opts.onTerminalError(slug, e);
          lifecycle.shutdown();
        } else {
          log.write(`[${slug}] tick error: ${e}`, "red");
        }
      }
      if (lifecycle.state === "DONE") done.push(slug);
    }


    // Process completed lifecycles
    for (const slug of done) {
      const lifecycle = this._lifecycles.get(slug);
      if (!lifecycle) continue;
      
      this._opts.onLifecycleDone(slug, lifecycle);
      
      this._lifecycles.delete(slug);
      this._completedSlugs.add(slug);
    }

    if (!this._shuttingDown && roundsExhausted && this._lifecycles.size === 0) {
      this._opts.onRoundsExhausted();
    }


    // Periodic predictive pre-fetching (every 10 minutes)
    const PREFETCH_INTERVAL_MS = 10 * 60 * 1000;
    if (
      !this._opts.botContext.replayReader &&
      !this._shuttingDown &&
      this._opts.clock.nowMs() - this._lastPrefetchMs >= PREFETCH_INTERVAL_MS
    ) {
      this._lastPrefetchMs = this._opts.clock.nowMs();
      this._opts.apiQueue.prefetchFutureRounds().catch((e) => {
        log.write(`[engine] background prefetch error: ${e}`, "red");
      });
    }
  }
}
