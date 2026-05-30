import {
  type EventWriter,
  NdjsonEventWriter,
} from "../event-store/writer.ts";
import { APIQueue, type EventResponse } from "../../tracker/api-queue.ts";
import {
  createReconnectingWs,
  type ReconnectingWs,
} from "../../utils/reconnecting-ws.ts";
import { type Clock, RealClock } from "../bot-core/data-sources.ts";

const DEFAULT_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

function normalizeTradeAction(side: unknown): "buy" | "sell" | undefined {
  if (typeof side !== "string") return undefined;
  const normalized = side.toLowerCase();
  if (normalized === "buy" || normalized === "sell") return normalized;
  return undefined;
}

export type RawL2RecorderOptions = {
  writer?: EventWriter;
  clock?: Clock;
  wsUrl?: string;
};

export class RawL2Recorder {
  private writer: EventWriter;
  private clock: Clock;
  private wsUrl: string;
  private ws?: ReconnectingWs;
  private pendingWrites: Promise<void>[] = [];

  private activeSlug: string | null = null;
  private assetIds: string[] = [];
  private tokenSides = new Map<string, "UP" | "DOWN">();

  private _health = {
    connected: false,
    reconnectCount: 0,
    decodeErrorCount: 0,
    messagesReceived: 0,
    messagesWritten: 0,
    writeErrorCount: 0,
    unknownMessageCount: 0,
    lastMessageAgeMs: 0,
    lastMessageTs: 0,
    lastError: "",
  };

  constructor(opts: RawL2RecorderOptions = {}) {
    this.writer = opts.writer ?? new NdjsonEventWriter();
    this.clock = opts.clock ?? new RealClock();
    this.wsUrl = opts.wsUrl ?? process.env.ORDERBOOK_WS_URL ?? DEFAULT_WS_URL;
  }

  get health() {
    return {
      ...this._health,
      lastMessageAgeMs:
        this._health.lastMessageTs > 0
          ? this.clock.nowMs() - this._health.lastMessageTs
          : 0,
    };
  }

  private enqueueWrite(eventInput: any) {
    const p = this.writer
      .append(eventInput)
      .then(() => {
        this._health.messagesWritten++;
      })
      .catch((e: any) => {
        this._health.writeErrorCount++;
        this._health.lastError = "Write error: " + e.message;
      });

    this.pendingWrites.push(p);

    p.finally(() => {
      const idx = this.pendingWrites.indexOf(p);
      if (idx !== -1) {
        this.pendingWrites.splice(idx, 1);
      }
    });
  }

  async start(slug: string): Promise<void> {
    if (this.activeSlug) {
      throw new Error("Recorder is already running");
    }

    this.activeSlug = slug;

    this.enqueueWrite({
      eventType: "recorder_started",
      source: "raw-l2-recorder",
      slug,
      payload: { mode: "capture" },
    });

    const queue = new APIQueue();
    await queue.queueEventDetails(slug);
    const details = queue.eventDetails.get(slug);

    if (!details || !details.markets || details.markets.length === 0) {
      throw new Error(`Failed to resolve market details for slug: ${slug}`);
    }

    const market = details.markets[0];
    if (!market) {
      throw new Error(`Market not found for slug: ${slug}`);
    }
    
    let tokenIds: string[];
    try {
      tokenIds = JSON.parse(market.clobTokenIds);
    } catch (e) {
      throw new Error(`Failed to parse clobTokenIds: ${market.clobTokenIds}`);
    }

    this.assetIds = [tokenIds[0]!, tokenIds[1]!];
    this.tokenSides.set(this.assetIds[0]!, "UP");
    this.tokenSides.set(this.assetIds[1]!, "DOWN");

    this.enqueueWrite({
      eventType: "market_resolved_for_recording",
      source: "raw-l2-recorder",
      slug,
      payload: {
        conditionId: market.conditionId,
        clobTokenIds: this.assetIds,
      },
    });

    this.connectWs();
  }

  private connectWs() {
    this.ws = createReconnectingWs({
      url: this.wsUrl,
      label: "RawL2Recorder",
      onopen: (ws) => {
        this._health.connected = true;
        this.enqueueWrite({
          eventType: "feed_connected",
          source: "raw-l2-recorder",
          slug: this.activeSlug ?? undefined,
          payload: { url: this.wsUrl, reconnectCount: this._health.reconnectCount },
        });

        ws.send(
          JSON.stringify({
            type: "market",
            assets_ids: this.assetIds,
            custom_feature_enabled: true,
          }),
        );
      },
      onclose: () => {
        this._health.connected = false;
        this._health.reconnectCount++;
        this.enqueueWrite({
          eventType: "feed_disconnected",
          source: "raw-l2-recorder",
          slug: this.activeSlug ?? undefined,
          payload: { reconnectCount: this._health.reconnectCount },
        });
      },
      onmessage: (event) => this.handleMessage(event),
      isTerminal: (event) => {
        if (event.code === 4003 || event.reason.toLowerCase().includes("forbidden")) {
          return "Polymarket access appears to be blocked from this network or region (403 Forbidden).";
        }
        return null;
      },
    });
  }

  private handleMessage(event: MessageEvent) {
    this._health.messagesReceived++;
    const now = this.clock.nowMs();
    this._health.lastMessageTs = now;

    if (!event.data) return;

    let data: any;
    try {
      data = JSON.parse(event.data as string);
    } catch (e) {
      this._health.decodeErrorCount++;
      this.enqueueWrite({
        eventType: "feed_decode_error",
        source: "raw-l2-recorder",
        payload: { raw: event.data },
      });
      return;
    }

    try {
      if (Array.isArray(data)) {
        for (const book of data) {
          this.processBookSnapshot(book, now);
        }
        return;
      }

      if (data.event_type === "book") {
        this.processBookSnapshot(data, now);
      } else if (data.event_type === "price_change") {
        this.processPriceChange(data, now);
      } else if (data.event_type === "trades" || data.event_type === "trade") {
        this.processTrade(data, now);
      } else if (data.event_type === "tick_size_change") {
        this.processTickSizeChange(data, now);
      } else if (data.event_type === "last_trade_price") {
        this.processLastTradePrice(data, now);
      } else {
        // Unknown raw message
        this._health.unknownMessageCount++;
        this.enqueueWrite({
          eventType: "raw_market_message",
          source: "polymarket-clob",
          receivedTsMs: now,
          payload: { raw: data },
        });
      }
    } catch (e: any) {
      this._health.lastError = e.message;
    }
  }

  private processBookSnapshot(msg: any, receivedTsMs: number) {
    this.enqueueWrite({
      eventType: "market_book_snapshot",
      source: "polymarket-clob",
      slug: this.activeSlug ?? undefined,
      receivedTsMs,
      payload: {
        tokenId: msg.asset_id,
        side: this.tokenSides.get(msg.asset_id),
        bids: msg.bids.map((b: any) => [parseFloat(b.price), parseFloat(b.size)]),
        asks: msg.asks.map((a: any) => [parseFloat(a.price), parseFloat(a.size)]),
        raw: { tick_size: msg.tick_size }, // Keep small raw metadata
      },
    });
  }

  private processPriceChange(msg: any, receivedTsMs: number) {
    for (const change of msg.price_changes) {
      const isBid = change.side === "BUY";
      const lvl: [number, number] = [parseFloat(change.price), parseFloat(change.size)];
      this.enqueueWrite({
        eventType: "market_book_delta",
        source: "polymarket-clob",
        slug: this.activeSlug ?? undefined,
        receivedTsMs,
        payload: {
          tokenId: change.asset_id,
          side: this.tokenSides.get(change.asset_id),
          bidChanges: isBid ? [lvl] : undefined,
          askChanges: !isBid ? [lvl] : undefined,
          bestBid: change.best_bid ? parseFloat(change.best_bid) : null,
          bestAsk: change.best_ask ? parseFloat(change.best_ask) : null,
        },
      });
    }
  }

  private processTrade(msg: any, receivedTsMs: number) {
    this.enqueueWrite({
      eventType: "market_trade",
      source: "polymarket-clob",
      slug: this.activeSlug ?? undefined,
      receivedTsMs,
      sourceTsMs: parseInt(msg.timestamp),
      payload: {
        tokenId: msg.asset_id,
        side: this.tokenSides.get(msg.asset_id),
        action: normalizeTradeAction(msg.side),
        price: parseFloat(msg.price),
        shares: parseFloat(msg.size),
        makerTaker: "unknown", // Public feed trades do not indicate perfectly
      },
    });
  }

  private processTickSizeChange(msg: any, receivedTsMs: number) {
    this.enqueueWrite({
      eventType: "market_status_change",
      source: "polymarket-clob",
      slug: this.activeSlug ?? undefined,
      receivedTsMs,
      payload: {
        tokenId: msg.asset_id,
        raw: { new_tick_size: msg.new_tick_size },
      },
    });
  }

  private processLastTradePrice(msg: any, receivedTsMs: number) {
    const sourceTsMs = Number.parseInt(msg.timestamp, 10);
    const price = Number.parseFloat(msg.price);
    const shares = msg.size !== undefined ? Number.parseFloat(msg.size) : null;
    this.enqueueWrite({
      eventType: "last_trade_price",
      source: "polymarket-clob",
      slug: this.activeSlug ?? undefined,
      receivedTsMs,
      sourceTsMs: Number.isFinite(sourceTsMs) ? sourceTsMs : undefined,
      payload: {
        tokenId: msg.asset_id,
        side: this.tokenSides.get(msg.asset_id),
        action: normalizeTradeAction(msg.side),
        price,
        shares: shares ?? undefined,
        raw: {
          fee_rate_bps: msg.fee_rate_bps,
          market: msg.market,
          event_type: msg.event_type,
        },
      },
    });

    // Polymarket documents market-channel last_trade_price as the public trade
    // execution print. Emit market_trade only when the message carries the
    // fields required by conservative fill scoring.
    if (
      typeof msg.asset_id === "string" &&
      Number.isFinite(price) &&
      shares !== null &&
      Number.isFinite(shares) &&
      Number.isFinite(sourceTsMs)
    ) {
      this.enqueueWrite({
        eventType: "market_trade",
        source: "polymarket-clob",
        slug: this.activeSlug ?? undefined,
        receivedTsMs,
        sourceTsMs,
        payload: {
          tokenId: msg.asset_id,
          side: this.tokenSides.get(msg.asset_id),
          action: normalizeTradeAction(msg.side),
          price,
          shares,
          makerTaker: "unknown",
          tradePrintSource: "clob_market_last_trade_price",
          raw: { fee_rate_bps: msg.fee_rate_bps, market: msg.market },
        },
      });
    }
  }

  async stop(): Promise<void> {
    if (this.ws) {
      this.ws.destroy();
      this.ws = undefined;
    }

    await Promise.allSettled(this.pendingWrites);
    
    // Write completion synchronously to guarantee it makes it
    try {
      await this.writer.append({
        eventType: "recorder_completed",
        source: "raw-l2-recorder",
        slug: this.activeSlug ?? undefined,
        payload: { health: this.health },
      });
    } catch (e) {}

    await this.writer.close();
    this.activeSlug = null;
  }
}
