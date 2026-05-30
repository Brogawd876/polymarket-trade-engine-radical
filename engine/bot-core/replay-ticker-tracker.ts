import { TickerTracker } from "../../tracker/ticker.ts";
import type { ReplayLogReader, ReplayEvent } from "./replay-log-reader.ts";

export class ReplayTickerTracker extends TickerTracker {
  private _binancePrice?: number;
  private _coinbasePrice?: number;
  private _assetPrice?: number;

  constructor(reader: ReplayLogReader) {
    super();
    reader.subscribe((evt) => this.handleEvent(evt));
  }

  override get price() {
    return this._assetPrice ?? this._binancePrice ?? this._coinbasePrice;
  }

  override get binancePrice() {
    return this._binancePrice;
  }

  override get coinbasePrice() {
    return this._coinbasePrice;
  }

  override schedule() {
    // No-op for replay
  }

  override waitForReady(): Promise<void> {
    return Promise.resolve();
  }

  override destroy() {
    // No-op for replay
  }

  private handleEvent(evt: ReplayEvent) {
    if (evt.type === "ticker") {
      this._binancePrice = evt.binancePrice;
      this._coinbasePrice = evt.coinbasePrice;
      this._assetPrice = evt.assetPrice;
    }
  }
}
