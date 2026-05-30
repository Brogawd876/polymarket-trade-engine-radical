import { OrderBook } from "../../tracker/orderbook.ts";
import { APIQueue } from "../../tracker/api-queue.ts";
import {
  type VenueDataAdapter,
  type VenueOrderBookEvent,
  type VenueMetadata,
  type RoundWindow,
  type BotAsset,
  createEventClock,
  type Clock,
  RealClock,
} from "./data-sources.ts";

export class PolymarketVenueAdapter implements VenueDataAdapter {
  readonly role = "venue";
  readonly source = "polymarket-clob";
  private asset: BotAsset;
  private orderBook: OrderBook;
  private apiQueue: APIQueue;
  private _latest: VenueOrderBookEvent | null = null;
  private handlers = new Set<(event: VenueOrderBookEvent) => void>();
  private currentRound: RoundWindow | null = null;
  private cleanupListener?: () => void;
  private _clock: Clock;

  constructor(asset: BotAsset, orderBook: OrderBook, apiQueue: APIQueue, clock?: Clock) {
    this.asset = asset;
    this.orderBook = orderBook;
    this.apiQueue = apiQueue;
    this._clock = clock ?? new RealClock();
  }

  isReady(): boolean {
    return this._latest !== null;
  }

  async start(): Promise<void> {
    this.cleanupListener = this.orderBook.onUpdate(() => {
      this.emitEvent();
    });
    this.emitEvent();
  }

  async stop(): Promise<void> {
    this.cleanupListener?.();
    this.cleanupListener = undefined;
  }

  latest(): VenueOrderBookEvent | null {
    if (this.currentRound && this.orderBook.isReady()) {
      this._latest = this.createEvent();
    }
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
    this.currentRound = round;

    let metadata: VenueMetadata | null = null;

    if (
      existingMetadata?.conditionId &&
      existingMetadata?.clobTokenIds &&
      existingMetadata?.feeRateBps !== undefined
    ) {
      metadata = {
        conditionId: existingMetadata.conditionId,
        clobTokenIds: existingMetadata.clobTokenIds,
        feeRateBps: existingMetadata.feeRateBps,
        closed: existingMetadata.closed ?? false,
      };
    } else {
      await this.apiQueue.queueEventDetails(round.slug);
      const event = this.apiQueue.eventDetails.get(round.slug);
      if (!event) return null;
      const market = event.markets[0];
      if (!market) return null;

      const tokenIds: string[] = JSON.parse(market.clobTokenIds);
      metadata = {
        conditionId: market.conditionId,
        clobTokenIds: [tokenIds[0]!, tokenIds[1]!],
        feeRateBps: market.feeSchedule?.rate ?? 0,
        closed: market.closed ?? false,
      };
    }

    // Connect orderbook to the round's tokens
    this.orderBook.subscribe(metadata.clobTokenIds);

    return metadata;
  }

  private emitEvent() {
    const venueEvent = this.createEvent();
    if (!venueEvent) return;

    this._latest = venueEvent;
    this.notify(venueEvent);
  }

  private createEvent(): VenueOrderBookEvent | null {
    if (!this.currentRound) return null;

    const clock = createEventClock({
      receivedAtMs: this._clock.nowMs(),
    });

    const snapshot = this.orderBook.getSnapshotData();
    const upId = this.orderBook.getTokenId("UP");

    return {
      id: `poly-clob-${clock.monotonicReceivedNs}`,
      role: "venue",
      source: this.source,
      asset: this.asset,
      kind: "orderbook",
      clock,
      quality: "live",
      freshnessMs: null,
      lagMs: 0,
      round: this.currentRound,
      up: snapshot.up,
      down: snapshot.down,
      bestBidUp: this.orderBook.bestBidPrice("UP"),
      bestAskUp: this.orderBook.bestAskPrice("UP"),
      bestBidDown: this.orderBook.bestBidPrice("DOWN"),
      bestAskDown: this.orderBook.bestAskPrice("DOWN"),
      feeRateBps: upId ? this.orderBook.getFeeRate(upId) : undefined,
    };
  }

  private notify(event: VenueOrderBookEvent) {
    for (const handler of this.handlers) {
      handler(event);
    }
  }
}
