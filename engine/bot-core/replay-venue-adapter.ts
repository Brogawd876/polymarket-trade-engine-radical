import { 
  type VenueDataAdapter, 
  type VenueOrderBookEvent, 
  type VenueMetadata,
  type RoundWindow,
  type BotAsset,
  createEventClock 
} from "./data-sources.ts";
import type { ReplayLogReader, ReplayEvent } from "./replay-log-reader.ts";

export class ReplayVenueAdapter implements VenueDataAdapter {
  readonly role = "venue";
  readonly source = "replay-polymarket-clob";
  private handlers = new Set<(event: VenueOrderBookEvent) => void>();
  private _latest: VenueOrderBookEvent | null = null;
  private _lastOrderBook: ReplayEvent | null = null;
  private currentRound: RoundWindow | null = null;
  private asset: BotAsset = "btc";
  private readonly replayMetadata?: Partial<VenueMetadata>;

  constructor(reader: ReplayLogReader, replayMetadata?: Partial<VenueMetadata>) {
    this.replayMetadata = replayMetadata;
    reader.subscribe((evt) => this.handleEvent(evt));
  }

  isReady(): boolean {
    return this._latest !== null;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  latest(): VenueOrderBookEvent | null {
    return this._latest;
  }

  subscribe(handler: (event: VenueOrderBookEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async initRound(
    round: RoundWindow,
    existingMetadata?: Partial<VenueMetadata>,
  ): Promise<VenueMetadata | null> {
    console.log(`[ReplayVenueAdapter] initRound: ${round.slug}`);
    this.currentRound = round;
    if (this._lastOrderBook) this.handleEvent(this._lastOrderBook);
    const metadata = existingMetadata ?? this.replayMetadata;
    return {
      conditionId: metadata?.conditionId ?? "replay-condition",
      clobTokenIds: metadata?.clobTokenIds ?? ["replay-up", "replay-down"],
      feeRateBps: metadata?.feeRateBps ?? 0.001,
      closed: metadata?.closed ?? false,
    };
  }

  private handleEvent(evt: ReplayEvent) {
    if (evt.type !== "orderbook_snapshot") return;
    this._lastOrderBook = evt;
    if (!this.currentRound) return;

    const clock = createEventClock({
      receivedAtMs: evt.ts,
      processedAtMs: evt.ts,
      monotonicReceivedNs: BigInt(evt.ts),
    });

    const venueEvent: VenueOrderBookEvent = {
      id: `replay-poly-${evt.ts}`,
      role: "venue",
      source: this.source,
      asset: this.asset,
      kind: "orderbook",
      clock,
      quality: "live",
      freshnessMs: 0,
      lagMs: 0,
      round: this.currentRound,
      up: evt.up,
      down: evt.down,
      bestBidUp: evt.up?.bids?.[0]?.[0] ?? null,
      bestAskUp: evt.up?.asks?.[0]?.[0] ?? null,
      bestBidDown: evt.down?.bids?.[0]?.[0] ?? null,
      bestAskDown: evt.down?.asks?.[0]?.[0] ?? null,
      feeRateBps: 0.001,
    };

    this._latest = venueEvent;
    for (const h of this.handlers) h(venueEvent);
  }
}
