import {
  type PredictiveFeedAdapter,
  type PredictivePriceEvent,
  type BotAsset,
  createEventClock,
  measureFreshness,
  type Clock,
  RealClock,
} from "./data-sources.ts";
import { Env } from "../../utils/config.ts";
import {
  createReconnectingWs,
  type ReconnectingWs,
} from "../../utils/reconnecting-ws.ts";

import { 
  type TelemetrySink, 
  NullTelemetrySink 
} from "../telemetry/index.ts";

const MAX_STALENESS_MS = 1000;

export class CoinbasePredictiveAdapter implements PredictiveFeedAdapter {
  readonly role = "predictive";
  readonly source = "coinbase-ticker";
  private asset: BotAsset;
  private ws?: ReconnectingWs;
  private _latest: PredictivePriceEvent | null = null;
  private handlers = new Set<(event: PredictivePriceEvent) => void>();
  private productId: string;
  private _clock: Clock;
  private _telemetry: TelemetrySink;

  constructor(clock?: Clock, telemetry?: TelemetrySink) {
    this._clock = clock ?? new RealClock();
    this._telemetry = telemetry ?? new NullTelemetrySink();
    this.asset = Env.get("MARKET_ASSET");
    const assetConfig = Env.getAssetConfig();
    this.productId = assetConfig.coinbaseProduct;
  }

  isReady(): boolean {
    return this._latest !== null;
  }

  async start(): Promise<void> {
    const WS_URL = "wss://ws-feed.exchange.coinbase.com";

    this.ws = createReconnectingWs({
      url: WS_URL,
      label: "CoinbasePredictive",
      onopen: (ws) => {
        ws.send(
          JSON.stringify({
            type: "subscribe",
            product_ids: [this.productId],
            channels: ["ticker"],
          }),
        );
        this._telemetry.push({
          ts: this._clock.nowMs(),
          type: "FEED_STATUS",
          payload: { feed: "coinbase", status: "connected", quality: "live" }
        });
      },
      onmessage: (event) => this.handleMessage(event),
      onerror: (err) => {
        this._telemetry.push({
          ts: this._clock.nowMs(),
          type: "FEED_STATUS",
          payload: { feed: "coinbase", status: "error", quality: "missing", message: String(err) }
        });
        console.error("Coinbase Predictive WS error:", JSON.stringify(err));
      }
    });
  }

  async stop(): Promise<void> {
    this.ws?.destroy();
    this.ws = undefined;
  }

  latest(): PredictivePriceEvent | null {
    return this._latest;
  }

  subscribe(handler: (event: PredictivePriceEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  handleMessage(event: MessageEvent) {
    if (!event.data) return;
    const receivedAtMs = this._clock.nowMs();
    const monotonicReceivedNs = process.hrtime.bigint();

    const json = JSON.parse(event.data as string);
    if (json.type !== "ticker") return;

    const price = parseFloat(json.price);
    if (!price) return;

    // Coinbase provides "time" as an ISO string
    const sourceTimestampMs = json.time ? new Date(json.time).getTime() : null;

    const clock = createEventClock({
      sourceTimestampMs,
      receivedAtMs,
      monotonicReceivedNs,
    });

    const predEvent: PredictivePriceEvent = {
      id: `coinbase-ticker-${clock.monotonicReceivedNs}`,
      role: "predictive",
      source: this.source,
      asset: this.asset,
      kind: "ticker",
      price,
      exchange: "coinbase",
      clock,
      quality: this.isStale(clock) ? "stale" : "live",
      freshnessMs: measureFreshness(clock),
      lagMs: 0,
    };

    this._latest = predEvent;
    this.notify(predEvent);
  }

  private notify(event: PredictivePriceEvent) {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  private isStale(clock: {
    sourceTimestampMs: number | null;
    receivedAtMs: number;
  }): boolean {
    if (clock.sourceTimestampMs === null) return false;
    return clock.receivedAtMs - clock.sourceTimestampMs > MAX_STALENESS_MS;
  }
}
