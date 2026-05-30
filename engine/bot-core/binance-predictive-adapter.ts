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

export class BinancePredictiveAdapter implements PredictiveFeedAdapter {
  readonly role = "predictive";
  readonly source = "binance-ticker";
  private asset: BotAsset;
  private ws?: ReconnectingWs;
  private _latest: PredictivePriceEvent | null = null;
  private handlers = new Set<(event: PredictivePriceEvent) => void>();
  private streamName: string;
  private _clock: Clock;
  private _telemetry: TelemetrySink;

  constructor(clock?: Clock, telemetry?: TelemetrySink) {
    this._clock = clock ?? new RealClock();
    this._telemetry = telemetry ?? new NullTelemetrySink();
    this.asset = Env.get("MARKET_ASSET");
    const assetConfig = Env.getAssetConfig();
    this.streamName = assetConfig.binanceStream;
  }

  isReady(): boolean {
    return this._latest !== null;
  }

  async start(): Promise<void> {
    const endpoint = Env.get("BINANCE_US") === true
      ? "stream.binance.us"
      : "data-stream.binance.com";
    const WS_URL = `wss://${endpoint}/ws/${this.streamName}@ticker`;

    this.ws = createReconnectingWs({
      url: WS_URL,
      label: "BinancePredictive",
      onopen: () => {
        this._telemetry.push({
          ts: this._clock.nowMs(),
          type: "FEED_STATUS",
          payload: { feed: "binance", status: "connected", quality: "live" }
        });
      },
      onmessage: (event) => this.handleMessage(event),
      onerror: (err) => {
        this._telemetry.push({
          ts: this._clock.nowMs(),
          type: "FEED_STATUS",
          payload: { feed: "binance", status: "error", quality: "missing", message: String(err) }
        });
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
    const price = parseFloat(json.c);
    const volume = parseFloat(json.v);
    if (!price) return;

    const sourceTimestampMs: number | null = json.E;
    const clock = createEventClock({
      sourceTimestampMs,
      receivedAtMs,
      monotonicReceivedNs,
    });

    const predEvent: PredictivePriceEvent = {
      id: `binance-ticker-${clock.monotonicReceivedNs}`,
      role: "predictive",
      source: this.source,
      asset: this.asset,
      kind: "ticker",
      price,
      volume,
      exchange: "binance",
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
