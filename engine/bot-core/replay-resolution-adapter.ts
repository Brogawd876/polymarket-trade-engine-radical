import { 
  type ResolutionSourceAdapter, 
  type ResolutionPriceEvent, 
  type RoundWindow,
  type BotAsset,
  createEventClock 
} from "./data-sources.ts";
import type { ReplayLogReader, ReplayEvent } from "./replay-log-reader.ts";

export class ReplayResolutionAdapter implements ResolutionSourceAdapter {
  readonly role = "resolution";
  readonly source = "replay-resolution";
  private handlers = new Set<(event: ResolutionPriceEvent) => void>();
  private _latest: ResolutionPriceEvent | null = null;
  private latchedAnchor: ResolutionPriceEvent | null = null;
  private asset: BotAsset = "btc";

  constructor(reader: ReplayLogReader) {
    this.reader = reader;
    reader.subscribe((evt) => this.handleEvent(evt));
  }

  private reader: ReplayLogReader;

  isReady(): boolean {
    return this._latest !== null;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  latest(): ResolutionPriceEvent | null {
    return this._latest;
  }

  latestAnchor(): ResolutionPriceEvent | null {
    return this.latchedAnchor;
  }

  subscribe(handler: (event: ResolutionPriceEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async priceToBeat(round: RoundWindow): Promise<ResolutionPriceEvent | null> {
    if (this.latchedAnchor && this.latchedAnchor.round?.slug === round.slug) {
      return this.latchedAnchor;
    }
    // Replay expectation: kind: 'open' event in log must precede this call
    return this.latchedAnchor;
  }

  async closePrice(round: RoundWindow): Promise<ResolutionPriceEvent | null> {
    return this._latest;
  }

  private handleEvent(evt: ReplayEvent) {
    if (evt.type === "market_price") {
      const clock = createEventClock({
        receivedAtMs: evt.ts,
        processedAtMs: evt.ts,
        monotonicReceivedNs: BigInt(evt.ts),
      });

      const resEvent: ResolutionPriceEvent = {
        id: `replay-res-market-${evt.ts}`,
        role: "resolution",
        source: this.source,
        sourceType: "replay",
        asset: this.asset,
        kind: "open",
        price: evt.openPrice,
        priceToBeat: evt.priceToBeat ?? evt.openPrice,
        clock,
        quality: "live",
        freshnessMs: 0,
        lagMs: 0,
        round: this.reader.round ?? undefined
      };

      this._latest = resEvent;
      // Only latch kind: 'open' once per round slug
      if (!this.latchedAnchor || this.latchedAnchor.round?.slug !== resEvent.round?.slug) {
          this.latchedAnchor = resEvent;
      }
      for (const h of this.handlers) h(resEvent);
    }
 else if (evt.type === "chainlink_resolution") {
      const chainUpdatedAtMs = typeof evt.chainUpdatedAtMs === "number" ? evt.chainUpdatedAtMs : null;
      const receivedAtMs = evt.localReceivedAtMs ?? evt.ts;
      const clock = createEventClock({
        sourceTimestampMs: chainUpdatedAtMs,
        receivedAtMs,
        processedAtMs: evt.ts,
        monotonicReceivedNs: BigInt(evt.ts),
      });

      const resEvent: ResolutionPriceEvent = {
        id: `replay-chainlink-${evt.roundId ?? evt.ts}`,
        role: "resolution",
        source: evt.source ?? this.source,
        sourceType: evt.sourceType === "chainlink_polygon" ? "chainlink_polygon" : "replay",
        asset: this.asset,
        kind: "live",
        price: evt.price,
        priceToBeat: this._latest?.priceToBeat,
        rawOracleAnswer: evt.rawOracleAnswer,
        roundId: evt.roundId,
        answeredInRound: evt.answeredInRound,
        chainUpdatedAtMs,
        localReceivedAtMs: receivedAtMs,
        oracleLagMs: evt.oracleLagMs ?? null,
        clock,
        quality: evt.quality === "stale" || evt.quality === "missing" ? evt.quality : "live",
        stalenessStatus: evt.stalenessStatus === "stale" || evt.stalenessStatus === "missing" || evt.stalenessStatus === "degraded" ? evt.stalenessStatus : "fresh",
        freshnessMs: evt.oracleLagMs ?? null,
        lagMs: evt.oracleLagMs ?? null,
        round: this.reader.round ?? undefined,
        metadata: {
          contractAddress: evt.contractAddress,
          network: "polygon",
        },
      };

      this._latest = resEvent;
      for (const h of this.handlers) h(resEvent);
    } else if (evt.type === "ticker") {
      if (evt.assetPrice === undefined || evt.assetPrice === null) return;

      const clock = createEventClock({
        receivedAtMs: evt.ts,
        processedAtMs: evt.ts,
        monotonicReceivedNs: BigInt(evt.ts),
      });

      const resEvent: ResolutionPriceEvent = {
        id: `replay-res-live-${evt.ts}`,
        role: "resolution",
        source: this.source,
        sourceType: "replay",
        asset: this.asset,
        kind: "live",
        price: evt.assetPrice,
        priceToBeat: this._latest?.priceToBeat,
        clock,
        quality: "live",
        freshnessMs: 0,
        lagMs: 0,
        round: this.reader.round ?? undefined
      };

      this._latest = resEvent;
      for (const h of this.handlers) h(resEvent);
    }
  }
}
