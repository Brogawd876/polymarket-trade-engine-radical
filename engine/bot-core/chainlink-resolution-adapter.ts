import { Contract, JsonRpcProvider, formatUnits, isAddress } from "ethers";
import {
  type BotAsset,
  type Clock,
  createEventClock,
  type FeedQuality,
  RealClock,
  type ResolutionPriceEvent,
  type ResolutionSourceAdapter,
  type RoundWindow,
} from "./data-sources.ts";
import { Env } from "../../utils/config.ts";
import { type TelemetrySink, NullTelemetrySink } from "../telemetry/index.ts";

import { POLYGON_CONTRACTS } from "../../utils/contracts.ts";

const BTC_USD_POLYGON_AGGREGATOR = POLYGON_CONTRACTS.CHAINLINK_BTC_USD;
const DEFAULT_POLYGON_RPC_URL = "https://polygon-rpc.com";
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_STALE_AFTER_MS = 60_000;
const DEFAULT_MAX_RPC_FAILURES = 3;

const AGGREGATOR_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
] as const;

export type ChainlinkRoundData = {
  roundId: bigint;
  answer: bigint;
  startedAt: bigint;
  updatedAt: bigint;
  answeredInRound: bigint;
};

export interface ChainlinkFeedReader {
  latestRoundData(): Promise<ChainlinkRoundData>;
  decimals(): Promise<number>;
  description(): Promise<string>;
}

export type ChainlinkResolutionHealth = {
  status: "starting" | "live" | "stale" | "degraded" | "stopped";
  consecutiveRpcFailures: number;
  lastRpcError: string | null;
  lastSuccessfulPollAtMs: number | null;
  lastRoundId: string | null;
  oracleLagMs: number | null;
  stale: boolean;
};

export type ChainlinkResolutionAdapterOptions = {
  asset?: BotAsset;
  rpcUrl?: string;
  contractAddress?: string;
  pollIntervalMs?: number;
  staleAfterMs?: number;
  maxRpcFailures?: number;
  clock?: Clock;
  telemetry?: TelemetrySink;
  reader?: ChainlinkFeedReader;
};

export class ChainlinkResolutionAdapter
  implements ResolutionSourceAdapter
{
  readonly role = "resolution" as const;
  readonly source = "chainlink-polygon-btc-usd";

  private readonly asset: BotAsset;
  private readonly rpcUrl: string;
  private readonly contractAddress: string;
  private readonly pollIntervalMs: number;
  private readonly staleAfterMs: number;
  private readonly maxRpcFailures: number;
  private readonly clock: Clock;
  private readonly telemetry: TelemetrySink;
  private readonly reader: ChainlinkFeedReader;
  private readonly processStartMs: number;

  private timer: any = null;
  private latestEvent: ResolutionPriceEvent | null = null;
  private latchedAnchor: ResolutionPriceEvent | null = null;
  private observedEvents: ResolutionPriceEvent[] = [];
  private handlers = new Set<(event: ResolutionPriceEvent) => void>();
  private decimalsValue: number | null = null;
  private descriptionValue: string | null = null;
  private lastSignature: string | null = null;
  private healthState: ChainlinkResolutionHealth = {
    status: "starting",
    consecutiveRpcFailures: 0,
    lastRpcError: null,
    lastSuccessfulPollAtMs: null,
    lastRoundId: null,
    oracleLagMs: null,
    stale: true,
  };

  constructor(opts: ChainlinkResolutionAdapterOptions = {}) {
    this.asset = opts.asset ?? Env.get("MARKET_ASSET");
    this.rpcUrl = opts.rpcUrl ?? process.env.POLYGON_RPC_URL ?? DEFAULT_POLYGON_RPC_URL;
    this.contractAddress =
      opts.contractAddress ??
      process.env.CHAINLINK_BTC_USD_POLYGON_ADDRESS ??
      BTC_USD_POLYGON_AGGREGATOR;
    if (!isAddress(this.contractAddress)) {
      throw new Error(`Invalid Chainlink feed address: ${this.contractAddress}`);
    }
    this.pollIntervalMs =
      opts.pollIntervalMs ??
      (parseInt(process.env.CHAINLINK_POLL_INTERVAL_MS ?? "", 10) ||
        DEFAULT_POLL_INTERVAL_MS);
    this.staleAfterMs =
      opts.staleAfterMs ??
      (parseInt(process.env.CHAINLINK_STALE_AFTER_MS ?? "", 10) ||
        DEFAULT_STALE_AFTER_MS);
    this.maxRpcFailures =
      opts.maxRpcFailures ??
      (parseInt(process.env.CHAINLINK_MAX_RPC_FAILURES ?? "", 10) ||
        DEFAULT_MAX_RPC_FAILURES);
    this.clock = opts.clock ?? new RealClock();
    this.processStartMs = this.clock.nowMs();
    this.telemetry = opts.telemetry ?? new NullTelemetrySink();
    this.reader =
      opts.reader ??
      (new Contract(
        this.contractAddress,
        AGGREGATOR_ABI,
        new JsonRpcProvider(this.rpcUrl),
      ) as unknown as ChainlinkFeedReader);
  }

  async start(): Promise<void> {
    await this.pollOnce();
    this.timer = this.clock.setInterval(() => {
      this.pollOnce().catch(() => {});
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) this.clock.clearInterval(this.timer);
    this.timer = null;
    this.healthState = { ...this.healthState, status: "stopped" };
  }

  isReady(): boolean {
    return this.latestEvent !== null && this.health().status === "live";
  }

  latest(): ResolutionPriceEvent | null {
    const event = this.latestEvent;
    if (!event) return null;
    if (event.stalenessStatus === "degraded") return event;
    const stale = this.isEventStale(event);
    if (!stale) return event;
    return {
      ...event,
      quality: "stale",
      stalenessStatus: "stale",
    };
  }

  latestAnchor(): ResolutionPriceEvent | null {
    if (!this.latchedAnchor) return null;
    if (!this.isEventStale(this.latchedAnchor)) return this.latchedAnchor;
    return {
      ...this.latchedAnchor,
      quality: "stale",
      stalenessStatus: "stale",
    };
  }

  subscribe(handler: (event: ResolutionPriceEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async priceToBeat(round: RoundWindow): Promise<ResolutionPriceEvent | null> {
    // Check if we already have a latched anchor for this specific round
    if (this.latchedAnchor && this.latchedAnchor.round?.slug === round.slug) {
      return this.latestAnchor();
    }

    const anchorSource = this.findOpeningAnchor(round);
    if (!anchorSource) {
      console.warn(
        `[Chainlink] Blocking fair-value: missing authoritative Chainlink opening anchor for ${round.slug}`,
      );
      this.latchedAnchor = null;
      return null;
    }

    const anchor = {
      ...anchorSource,
      id: `${anchorSource.id}-open-${round.slug}`,
      kind: "open" as const,
      priceToBeat: anchorSource.price,
      round,
    };
    this.latchedAnchor = anchor;
    return anchor;
  }

  async closePrice(round: RoundWindow): Promise<ResolutionPriceEvent | null> {
    const latest = this.latest();
    if (!latest) return null;
    return {
      ...latest,
      id: `${latest.id}-close-${round.slug}`,
      kind: "close",
      round,
    };
  }

  health(): ChainlinkResolutionHealth {
    const latest = this.latestEvent;
    const stale = latest ? this.isEventStale(latest) : true;
    const status =
      this.healthState.status === "stopped"
        ? "stopped"
        : this.healthState.consecutiveRpcFailures >= this.maxRpcFailures
          ? "degraded"
          : stale
            ? "stale"
            : "live";
    return {
      ...this.healthState,
      status,
      stale,
    };
  }

  async pollOnce(): Promise<ResolutionPriceEvent | null> {
    try {
      const [round, decimals, description] = await Promise.all([
        this.reader.latestRoundData(),
        this.getDecimals(),
        this.getDescription(),
      ]);
      const event = this.toEvent(round, decimals, description);
      this.latestEvent = event;
      this.rememberEvent(event);
      this.healthState = {
        status: event.quality === "live" ? "live" : "stale",
        consecutiveRpcFailures: 0,
        lastRpcError: null,
        lastSuccessfulPollAtMs: event.clock.receivedAtMs,
        lastRoundId: event.roundId ?? null,
        oracleLagMs: event.oracleLagMs ?? null,
        stale: event.quality === "stale",
      };
      this.emitIfChanged(event);
      return event;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.healthState = {
        ...this.healthState,
        status: "degraded",
        consecutiveRpcFailures: this.healthState.consecutiveRpcFailures + 1,
        lastRpcError: message,
      };
      this.telemetry.push({
        ts: this.clock.nowMs(),
        type: "FEED_STATUS",
        payload: {
          feed: this.source,
          status: "error",
          quality: "missing",
          message,
        },
      });
      if (this.latestEvent) {
        this.latestEvent = {
          ...this.latestEvent,
          quality: "stale",
          stalenessStatus: "degraded",
        };
      }
      return null;
    }
  }

  private async getDecimals(): Promise<number> {
    if (this.decimalsValue !== null) return this.decimalsValue;
    this.decimalsValue = Number(await this.reader.decimals());
    return this.decimalsValue;
  }

  private async getDescription(): Promise<string> {
    if (this.descriptionValue !== null) return this.descriptionValue;
    this.descriptionValue = await this.reader.description();
    return this.descriptionValue;
  }

  private toEvent(
    round: ChainlinkRoundData,
    decimals: number,
    description: string,
  ): ResolutionPriceEvent {
    const localReceivedAtMs = this.clock.nowMs();
    const chainUpdatedAtMs = Number(round.updatedAt) * 1000;
    const chainStartedAtMs = Number(round.startedAt) * 1000;
    const oracleLagMs = Math.max(0, localReceivedAtMs - chainUpdatedAtMs);
    const quality: FeedQuality = oracleLagMs > this.staleAfterMs ? "stale" : "live";
    const clock = createEventClock({
      sourceTimestampMs: chainUpdatedAtMs,
      receivedAtMs: localReceivedAtMs,
      processedAtMs: localReceivedAtMs,
    });

    return {
      id: `chainlink-polygon-btc-usd-${round.roundId.toString()}`,
      role: "resolution",
      source: this.source,
      sourceType: "chainlink_polygon",
      asset: this.asset,
      kind: "live",
      price: Number(formatUnits(round.answer, decimals)),
      rawOracleAnswer: round.answer.toString(),
      roundId: round.roundId.toString(),
      answeredInRound: round.answeredInRound.toString(),
      chainStartedAtMs,
      chainUpdatedAtMs,
      localReceivedAtMs,
      oracleLagMs,
      clock,
      quality,
      stalenessStatus: quality === "live" ? "fresh" : "stale",
      freshnessMs: oracleLagMs,
      lagMs: oracleLagMs,
      metadata: {
        contractAddress: this.contractAddress,
        description,
        decimals,
        network: "polygon",
      },
    };
  }

  private emitIfChanged(event: ResolutionPriceEvent): void {
    const signature = [
      event.roundId,
      event.rawOracleAnswer,
      event.chainStartedAtMs,
      event.chainUpdatedAtMs,
      event.answeredInRound,
      event.quality,
      event.stalenessStatus,
    ].join("|");
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.telemetry.push({
      ts: this.clock.nowMs(),
      type: "FEED_STATUS",
      payload: {
        feed: this.source,
        status: event.quality === "live" ? "connected" : "stale",
        quality: event.quality,
        message: `round=${event.roundId ?? "unknown"} oracleLagMs=${event.oracleLagMs ?? "unknown"}`,
      },
    });
    for (const handler of this.handlers) handler(event);
  }

  private rememberEvent(event: ResolutionPriceEvent): void {
    const signature = [
      event.roundId,
      event.rawOracleAnswer,
      event.chainStartedAtMs,
      event.chainUpdatedAtMs,
      event.answeredInRound,
    ].join("|");
    const last = this.observedEvents[this.observedEvents.length - 1];
    const lastSignature = last
      ? [
          last.roundId,
          last.rawOracleAnswer,
          last.chainStartedAtMs,
          last.chainUpdatedAtMs,
          last.answeredInRound,
        ].join("|")
      : null;
    if (signature !== lastSignature) {
      this.observedEvents.push(event);
      if (this.observedEvents.length > 512) this.observedEvents.shift();
    }
  }

  private findOpeningAnchor(round: RoundWindow): ResolutionPriceEvent | null {
    const candidates = [...this.observedEvents];
    const latest = this.latest();
    if (latest) candidates.push(latest);

    return candidates
      .filter((event) => {
        const updatedAt = event.chainUpdatedAtMs ?? event.clock.sourceTimestampMs;
        if (updatedAt === null || updatedAt === undefined) return false;
        if (updatedAt > round.startTimeMs) return false;
        return event.quality === "live" && event.stalenessStatus !== "stale" && event.stalenessStatus !== "missing" && event.stalenessStatus !== "degraded";
      })
      .sort((a, b) => {
        const aUpdatedAt = a.chainUpdatedAtMs ?? a.clock.sourceTimestampMs ?? 0;
        const bUpdatedAt = b.chainUpdatedAtMs ?? b.clock.sourceTimestampMs ?? 0;
        return bUpdatedAt - aUpdatedAt;
      })[0] ?? null;
  }

  private isEventStale(event: ResolutionPriceEvent): boolean {
    const updatedAtMs = event.chainUpdatedAtMs ?? event.clock.sourceTimestampMs;
    if (updatedAtMs === null || updatedAtMs === undefined) return true;
    return this.clock.nowMs() - updatedAtMs > this.staleAfterMs;
  }
}
