import { createReadStream } from "fs";
import * as readline from "readline";
import type { 
  RoundWindow
} from "./data-sources.ts";

export type ReplayEvent = 
  | { ts: number; type: "orderbook_snapshot"; up: any; down: any }
  | { ts: number; type: "ticker"; assetPrice: number; binancePrice?: number; coinbasePrice?: number; divergence?: number | null }
  | { ts: number; type: "slot"; action: "start" | "end"; slug: string; startTime: number; endTime: number; strategy: string }
  | { ts: number; type: "market_price"; openPrice: number; gap?: number; priceToBeat?: number }
  | { ts: number; type: "chainlink_resolution"; price: number; rawOracleAnswer?: string; roundId?: string; answeredInRound?: string; chainUpdatedAtMs?: number | null; localReceivedAtMs?: number; oracleLagMs?: number | null; quality?: string; stalenessStatus?: string; source?: string; sourceType?: string; contractAddress?: string }
  | { ts: number; type: "resolution"; direction?: "UP" | "DOWN"; openPrice: number; closePrice: number; unfilledShares?: number; payout?: number; pnl?: number }
  | { ts: number; type: string; [key: string]: any };

export class ReplayLogReader {
  private fileStream: readline.Interface;
  private iterator: AsyncIterator<string>;
  private nextEvent: ReplayEvent | null = null;
  private _isDone = false;
  private cursor = 0;
  private virtualNowMs = 0;
  private currentRound: RoundWindow | null = null;
  private handlers = new Set<(evt: ReplayEvent) => void>();
  private latestState = new Map<string, ReplayEvent>();
  public isInitialized = false;

  constructor(private logPath: string, private opts: { tolerant?: boolean } = {}) {
    this.fileStream = readline.createInterface({
      input: createReadStream(logPath),
      crlfDelay: Infinity
    });
    this.iterator = this.fileStream[Symbol.asyncIterator]();
  }

  async init(): Promise<void> {
    if (this.isInitialized) return;
    await this._loadNext();
    if (this.nextEvent) {
      this.virtualNowMs = this.nextEvent.ts;
    } else {
      throw new Error(`Replay log ${this.logPath} contains no usable events.`);
    }
    this.isInitialized = true;
  }

  private async _loadNext(): Promise<void> {
    while (true) {
      const { value, done } = await this.iterator.next();
      if (done) {
        this._isDone = true;
        this.nextEvent = null;
        return;
      }
      const line = value.trim();
      if (!line) continue;
      
      try {
        const evt = JSON.parse(line) as ReplayEvent;
        if (typeof evt.ts !== "number" || !evt.type) {
          throw new Error("missing numeric ts or type");
        }
        this.nextEvent = evt;
        return;
      } catch (e) {
        if (!this.opts.tolerant) {
          throw new Error(`Replay log parse failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  subscribe(handler: (evt: ReplayEvent) => void): () => void {
    this.handlers.add(handler);
    for (const evt of this.latestState.values()) {
        handler(evt);
    }
    return () => this.handlers.delete(handler);
  }

  get nowMs(): number {
    return this.virtualNowMs;
  }

  get round(): RoundWindow | null {
    return this.currentRound;
  }

  get eventCount(): number {
    return this.cursor + (this.nextEvent ? 1 : 0);
  }

  get allEvents(): readonly ReplayEvent[] {
    throw new Error("allEvents is not available in streaming mode");
  }

  get processedEventCount(): number {
    return this.cursor;
  }

  async advanceTo(newNowMs: number): Promise<void> {
    while (this.nextEvent && this.nextEvent.ts <= newNowMs) {
      const evt = this.nextEvent;
      if (evt.type === "slot" && evt.action === "start") {
        this.currentRound = {
          slug: evt.slug,
          asset: "btc",
          window: "5m",
          startTimeMs: evt.startTime,
          endTimeMs: evt.endTime
        };
      }
      this.latestState.set(evt.type, evt);
      for (const h of this.handlers) h(evt);
      this.cursor++;
      await this._loadNext();
    }
    this.virtualNowMs = newNowMs;
  }

  peekNextTs(): number | null {
    return this.nextEvent ? this.nextEvent.ts : null;
  }

  isDone(): boolean {
    return this._isDone;
  }
}
