import { OrderBook } from "../../tracker/orderbook.ts";
import { PriceLevelMap } from "../../utils/price-level-map.ts";
import type { ReplayLogReader, ReplayEvent } from "./replay-log-reader.ts";
import type { Clock } from "./data-sources.ts";

export class ReplayOrderBook extends OrderBook {
  private lastUp: any = null;
  private lastDown: any = null;

  constructor(reader: ReplayLogReader, clock: Clock, tradeTape?: any) {
    super(clock, tradeTape);
    reader.subscribe((evt) => this.handleEvent(evt));
  }

  override isReady(): boolean {
    // In replay mode, consider the book ready as soon as subscription is established.
    // This prevents stalls if the log contains sparse snapshots.
    return this.assetIds[0] !== "" && this.assetIds[1] !== "";
  }

  override subscribe(clobTokenIds: string[]) {
    console.log(`[ReplayOrderBook] subscribe: ids=[${clobTokenIds.join(", ")}]`);
    this.assetIds = clobTokenIds;
    this.books.clear();
    this.tickSizes.clear();
    this.feeRates.clear();

    // Apply buffered data if we have it
    if (this.lastUp) {
        console.log(`[ReplayOrderBook] applying buffered UP snapshot`);
        this.applyReplaySnapshot(this.assetIds[0]!, this._parseBidsAsks(this.lastUp));
    }
    if (this.lastDown) {
        console.log(`[ReplayOrderBook] applying buffered DOWN snapshot`);
        this.applyReplaySnapshot(this.assetIds[1]!, this._parseBidsAsks(this.lastDown));
    }

    // No WebSocket in replay
  }

  override destroy() {
    // No-op
  }

  private _parseBidsAsks(data: any) {
    // Handle both raw level arrays and {bids, asks} objects
    if (data.bids && data.asks) return data;
    return { bids: [], asks: [] }; // Fallback
  }

  private handleEvent(evt: ReplayEvent) {
    if (evt.type === "orderbook_snapshot") {
      this.lastUp = evt.up || this.lastUp;
      this.lastDown = evt.down || this.lastDown;

      if (!this.assetIds[0] || !this.assetIds[1]) return;

      this.applyReplaySnapshot(this.assetIds[0], this._parseBidsAsks(evt.up));
      this.applyReplaySnapshot(this.assetIds[1], this._parseBidsAsks(evt.down));
    } else if (evt.type === "market_book_snapshot") {
      this.applyReplaySnapshot(evt.payload.tokenId, evt.payload);
    } else if (evt.type === "market_book_delta") {
      const book = this.getOrCreateBook(evt.payload.tokenId);
      if (evt.payload.bidChanges) {
        for (const [p, s] of evt.payload.bidChanges) {
          if (s === 0) book.bids.delete(p);
          else book.bids.set(p, s);
        }
      }
      if (evt.payload.askChanges) {
        for (const [p, s] of evt.payload.askChanges) {
          if (s === 0) book.asks.delete(p);
          else book.asks.set(p, s);
        }
      }
    } else if (evt.type === "market_trade" || evt.type === "last_trade_price") {
      const price = evt.payload.price;
      const size = evt.payload.shares;
      if (price !== undefined) {
        this.lastTradePrices.set(evt.payload.tokenId, price);
      }
      if (size !== undefined) {
        this.lastTradeSizes.set(evt.payload.tokenId, size);
      }
      // Trigger update for tape if needed
    } else {
      return;
    }
    
    // Mock some defaults if missing
    if (this.assetIds[0] && !this.tickSizes.has(this.assetIds[0])) this.tickSizes.set(this.assetIds[0], "0.001");
    if (this.assetIds[1] && !this.tickSizes.has(this.assetIds[1])) this.tickSizes.set(this.assetIds[1], "0.001");
    if (this.assetIds[0] && !this.feeRates.has(this.assetIds[0])) this.feeRates.set(this.assetIds[0], 10);
    if (this.assetIds[1] && !this.feeRates.has(this.assetIds[1])) this.feeRates.set(this.assetIds[1], 10);

    // Notify listeners (like MarketLifecycle)
    this.notify();
  }

  private applyReplaySnapshot(assetId: string, data: any) {
    if (!data) return;
    let book = this.books.get(assetId);
    if (!book) {
      book = {
        bids: new PriceLevelMap("desc"),
        asks: new PriceLevelMap("asc"),
      };
      this.books.set(assetId, book);
    }
    book.bids.clear();
    book.asks.clear();
    if (data.bids) {
      for (const [p, s] of data.bids) book.bids.set(p, s);
    }
    if (data.asks) {
      for (const [p, s] of data.asks) book.asks.set(p, s);
    }
  }
}
