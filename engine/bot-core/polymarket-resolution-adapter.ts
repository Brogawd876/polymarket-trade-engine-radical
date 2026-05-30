import {
  type ResolutionSourceAdapter,
  type ResolutionPriceEvent,
  type RoundWindow,
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
import { fetchWithRetry } from "../../utils/fetch-retry.ts";
import { 
  type TelemetrySink, 
  NullTelemetrySink 
} from "../telemetry/index.ts";

const MAX_STALENESS_MS = 1000;

export class PolymarketResolutionAdapter implements ResolutionSourceAdapter {
  readonly role = "resolution";
  readonly source = "polymarket-combined";
  private asset: BotAsset;
  private ws?: ReconnectingWs;
  private _latest: ResolutionPriceEvent | null = null;
  private handlers = new Set<(event: ResolutionPriceEvent) => void>();
  private apiSymbol: string;
  private polymarketSymbol: string;
  private _clock: Clock;
  private _telemetry: TelemetrySink;

  constructor(clock?: Clock, telemetry?: TelemetrySink) {
    this._clock = clock ?? new RealClock();
    this._telemetry = telemetry ?? new NullTelemetrySink();
    this.asset = Env.get("MARKET_ASSET");
    const assetConfig = Env.getAssetConfig();
    this.apiSymbol = assetConfig.apiSymbol;
    this.polymarketSymbol = assetConfig.polymarketSymbol;
  }

  isReady(): boolean {
    return this._latest !== null;
  }

  async start(): Promise<void> {
    const WS_URL = "wss://ws-live-data.polymarket.com";

    this.ws = createReconnectingWs({
      url: WS_URL,
      label: "PolymarketResolution",
      onopen: (ws) => {
        ws.send(
          JSON.stringify({
            action: "subscribe",
            subscriptions: [
              {
                topic: "crypto_prices_chainlink",
                type: "update",
                filters: JSON.stringify({ symbol: this.polymarketSymbol }),
              },
            ],
          }),
        );
        this._telemetry.push({
          ts: this._clock.nowMs(),
          type: "FEED_STATUS",
          payload: { feed: "polymarket-resolution", status: "connected", quality: "live" }
        });
      },
      onmessage: (event) => {
        if (!event.data) return;
        const json = JSON.parse(event.data as string);
        const price: number = json.payload?.value;
        if (typeof price !== "number") return;

        const sourceTimestampMs: number | null = json.timestamp;
        const clock = createEventClock({
          sourceTimestampMs,
          receivedAtMs: this._clock.nowMs(),
        });

        const resEvent: ResolutionPriceEvent = {
          id: `poly-rtds-${clock.monotonicReceivedNs}`,
          role: "resolution",
          source: "polymarket-chainlink-rtds",
          sourceType: "polymarket_chainlink_rtds",
          asset: this.asset,
          kind: "live",
          price,
          clock,
          quality: this.isStale(clock) ? "stale" : "live",
          freshnessMs: measureFreshness(clock),
          lagMs: 0,
        };

        this._latest = resEvent;
        this.notify(resEvent);
      },
      isTerminal: (event) => {
        if (event.code === 4003 || event.reason.toLowerCase().includes("forbidden")) {
          const msg = "Polymarket access appears to be blocked from this network or region (403 Forbidden).";
          this._telemetry.push({
            ts: this._clock.nowMs(),
            type: "FEED_STATUS",
            payload: { feed: "polymarket-resolution", status: "forbidden", quality: "missing", message: msg }
          });
          return msg;
        }
        return null;
      },
      onerror: (err) => {
        this._telemetry.push({
          ts: this._clock.nowMs(),
          type: "FEED_STATUS",
          payload: { feed: "polymarket-resolution", status: "error", quality: "missing", message: String(err) }
        });
        console.error("Polymarket Resolution WS error:", JSON.stringify(err));
      }
    });
  }

  async stop(): Promise<void> {
    this.ws?.destroy();
    this.ws = undefined;
  }

  latest(): ResolutionPriceEvent | null {
    return this._latest;
  }

  latestAnchor(): ResolutionPriceEvent | null {
    return this._latest;
  }

  subscribe(handler: (event: ResolutionPriceEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private notify(event: ResolutionPriceEvent) {
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

  async priceToBeat(round: RoundWindow): Promise<ResolutionPriceEvent | null> {
    const data = await this.fetchMarketData(round);
    if (!data?.openPrice) return null;

    const clock = createEventClock({
      receivedAtMs: this._clock.nowMs(),
    });
    return {
      id: `poly-api-open-${round.slug}`,
      role: "resolution",
      source: "polymarket-crypto-price-api",
      sourceType: "polymarket_crypto_price_api",
      asset: this.asset,
      kind: "open",
      price: data.openPrice,
      clock,
      quality: "live",
      freshnessMs: null,
      lagMs: 0,
      round,
    };
  }

  async closePrice(round: RoundWindow): Promise<ResolutionPriceEvent | null> {
    const data = await this.fetchMarketData(round);
    if (!data?.closePrice) return null;

    const clock = createEventClock({
      receivedAtMs: this._clock.nowMs(),
    });
    return {
      id: `poly-api-close-${round.slug}`,
      role: "resolution",
      source: "polymarket-crypto-price-api",
      sourceType: "polymarket_crypto_price_api",
      asset: this.asset,
      kind: "close",
      price: data.closePrice,
      clock,
      quality: "live",
      freshnessMs: null,
      lagMs: 0,
      round,
    };
  }

  private async fetchMarketData(round: RoundWindow) {
    const variantMap: Record<string, string> = {
      "5m": "fiveminute",
      "15m": "fifteen",
    };
    const variant = variantMap[round.window] ?? "fiveminute";

    const url = new URL("https://polymarket.com/api/crypto/crypto-price");
    url.searchParams.set("symbol", this.apiSymbol);
    url.searchParams.set("variant", variant);
    url.searchParams.set("eventStartTime", round.startTimeMs.toString());
    url.searchParams.set("endDate", round.endTimeMs.toString());

    try {
      const res = await fetchWithRetry(url, {
        options: { headers: { Accept: "application/json" } },
        useCurl: false,
        totalRetry: 3,
      });
      return (await res.json()) as {
        openPrice: number;
        closePrice: number | null;
      };
    } catch (e) {
      console.error(`Error fetching resolution market data for ${round.slug}:`, e);
      return null;
    }
  }
}
