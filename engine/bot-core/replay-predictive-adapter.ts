import { 
  type PredictiveFeedAdapter, 
  type PredictivePriceEvent, 
  type BotAsset,
  createEventClock 
} from "./data-sources.ts";
import type { ReplayLogReader, ReplayEvent } from "./replay-log-reader.ts";

export class ReplayPredictiveAdapter implements PredictiveFeedAdapter {
  readonly role = "predictive";
  readonly source: string;
  private handlers = new Set<(event: PredictivePriceEvent) => void>();
  private _latest: PredictivePriceEvent | null = null;
  private exchange: "binance" | "coinbase";
  private asset: BotAsset = "btc";

  constructor(exchange: "binance" | "coinbase", reader: ReplayLogReader) {
    this.exchange = exchange;
    this.source = `replay-${exchange}`;
    reader.subscribe((evt) => this.handleEvent(evt));
  }

  isReady(): boolean {
    return this._latest !== null;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  latest(): PredictivePriceEvent | null {
    return this._latest;
  }

  subscribe(handler: (event: PredictivePriceEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private handleEvent(evt: ReplayEvent) {
    if (evt.type !== "ticker") return;

    const price = this.exchange === "binance" ? evt.binancePrice : evt.coinbasePrice;
    if (price === undefined || price === null) return;

    const clock = createEventClock({
      receivedAtMs: evt.ts,
      processedAtMs: evt.ts,
      monotonicReceivedNs: BigInt(evt.ts),
    });

    const predEvent: PredictivePriceEvent = {
      id: `replay-${this.exchange}-${evt.ts}`,
      role: "predictive",
      source: this.source,
      asset: this.asset,
      kind: "ticker",
      price,
      exchange: this.exchange,
      clock,
      quality: "live",
      freshnessMs: 0,
      lagMs: 0,
    };

    this._latest = predEvent;
    for (const h of this.handlers) h(predEvent);
  }
}
