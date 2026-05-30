import type { ProfitEventEnvelope, MarketBookPayload } from "../event-store/events.ts";
import { calculateMarkouts, type ReferencePricePoint, type FillForMarkout } from "./markout.ts";

export type FillScoreVerdict =
  | "no_fill"
  | "touch_only"
  | "trade_through_fill"
  | "probable_fill"
  | "unknown_insufficient_data";

export type FillScoreResult = {
  verdict: FillScoreVerdict;
  reason: string;
  fillProbability: number;
  adverseSelection: boolean | null;
  fillTsMs: number | null;
  markouts: {
    "1s": number | null;
    "5s": number | null;
    "30s": number | null;
    settlement: number | null;
  };
  markoutReasons: {
    "1s"?: string;
    "5s"?: string;
    "30s"?: string;
    settlement?: string;
  };
};

export type ScoreFillOptions = {
  orderId: string;
  tokenId: string;
  action: "buy" | "sell";
  side: "UP" | "DOWN";
  price: number;
  shares: number;
  placedTsMs: number;
  queuePosition?: number | null;
  maxWaitMs?: number;
  skipSort?: boolean;
};

/**
 * Extract bestBid from a book payload.
 * Prefers explicit bestBid, falls back to first element of bids array (raw L2 snapshots).
 */
function extractBestBid(payload: MarketBookPayload): number | null {
  if (payload.bestBid !== undefined && payload.bestBid !== null) return payload.bestBid;
  if (Array.isArray(payload.bids) && payload.bids.length > 0) {
    const top = payload.bids[0];
    if (Array.isArray(top) && typeof top[0] === "number" && Number.isFinite(top[0])) return top[0];
  }
  return null;
}

/**
 * Extract bestAsk from a book payload.
 * Prefers explicit bestAsk, falls back to first element of asks array (raw L2 snapshots).
 */
function extractBestAsk(payload: MarketBookPayload): number | null {
  if (payload.bestAsk !== undefined && payload.bestAsk !== null) return payload.bestAsk;
  if (Array.isArray(payload.asks) && payload.asks.length > 0) {
    const top = payload.asks[0];
    if (Array.isArray(top) && typeof top[0] === "number" && Number.isFinite(top[0])) return top[0];
  }
  return null;
}

/**
 * Check if a maker resting order has been touched by the book.
 *
 * Conservative maker-fill touch semantics:
 *   - maker BUY at P: we are resting on the BID side. Touch occurs when bestBid >= P
 *     (the bid queue has moved up to meet our price, meaning an aggressor could hit us).
 *   - maker SELL at P: we are resting on the ASK side. Touch occurs when bestAsk <= P
 *     (the ask queue has moved down to meet our price).
 *
 * Note: a touch is NOT a fill. It only means our price was reached.
 * Trade-through evidence (market_trade) is required for a fill verdict.
 */
function isMakerTouch(action: "buy" | "sell", orderPrice: number, bid: number | null, ask: number | null): boolean {
  if (action === "buy") {
    // Resting on bid side — touch when bestBid reaches our price
    return bid !== null && bid >= orderPrice - 1e-9;
  } else {
    // Resting on ask side — touch when bestAsk drops to our price
    return ask !== null && ask <= orderPrice + 1e-9;
  }
}

export class ConservativeFillScorer {
  evaluate(opts: ScoreFillOptions, events: ProfitEventEnvelope[]): FillScoreResult {
    const sorted = opts.skipSort ? events : [...events].sort((a, b) => a.processedTsMs - b.processedTsMs);

    let verdict: FillScoreVerdict = "unknown_insufficient_data";
    let reason = "no relevant data found";
    let fillProbability = 0;
    let fillTsMs: number | null = null;

    let cumulativeTradeAtPrice = 0;
    let hasTouch = false;
    let hasData = false;
    const queuePosition = opts.queuePosition ?? Infinity;

    const references: ReferencePricePoint[] = [];

    // Running best-bid/ask state for our token/side, updated as book events arrive.
    // These are used to build markout reference points and to detect touches.
    let currentBid: number | null = null;
    let currentAsk: number | null = null;

    // Binary search to find start index
    let startIndex = 0;
    let low = 0;
    let high = sorted.length - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const midEvent = sorted[mid];
      if (!midEvent) break;
      const ts = midEvent.processedTsMs ?? midEvent.receivedTsMs ?? 0;
      if (ts < opts.placedTsMs) {
        low = mid + 1;
      } else {
        startIndex = mid;
        high = mid - 1;
      }
    }
    if (low === sorted.length) startIndex = sorted.length;

    for (let i = startIndex; i < sorted.length; i++) {
      const evt = sorted[i];
      if (!evt) continue;

      // ── Book events ────────────────────────────────────────────────────────
      if (evt.eventType === "market_book_snapshot" || evt.eventType === "market_book_delta") {
        const payload = evt.payload as MarketBookPayload;

        // Rule: ignore wrong tokenId
        if (payload.tokenId !== opts.tokenId) continue;

        hasData = true;

        // Derive best bid/ask — prefer explicit fields, fall back to bids/asks arrays
        const newBid = extractBestBid(payload);
        const newAsk = extractBestAsk(payload);

        // Update running state (carry forward if this event only updates one side)
        if (newBid !== null) currentBid = newBid;
        if (newAsk !== null) currentAsk = newAsk;

        // Build markout reference point using our token's side
        const isUp = opts.side === "UP";
        const ref: ReferencePricePoint = {
          tsMs: evt.processedTsMs,
          upBid:  isUp   ? currentBid  : undefined,
          upAsk:  isUp   ? currentAsk  : undefined,
          downBid: !isUp ? currentBid  : undefined,
          downAsk: !isUp ? currentAsk  : undefined,
          upMid:   isUp && currentBid !== null && currentAsk !== null
            ? (currentBid + currentAsk) / 2
            : undefined,
          downMid: !isUp && currentBid !== null && currentAsk !== null
            ? (currentBid + currentAsk) / 2
            : undefined,
        };
        references.push(ref);

        // Touch detection — only before a fill is confirmed
        if (fillTsMs === null && !hasTouch) {
          if (isMakerTouch(opts.action, opts.price, currentBid, currentAsk)) {
            hasTouch = true;
          }
        }
      }

      // ── Trade events ───────────────────────────────────────────────────────
      // last_trade_price: v1 ignores entirely — not used for fill evidence or markout reference.
      // market_trade is the only event that creates fill evidence.
      if (fillTsMs === null && evt.eventType === "market_trade") {
        const payload = evt.payload as any;

        // Rule: ignore wrong tokenId
        if (payload.tokenId !== opts.tokenId) continue;

        hasData = true;
        const tradePrice: number = payload.price;
        const tradeSize: number = payload.shares;

        // Trade-through: market traded beyond our resting price
        //   BUY resting at P: trade below P means price ran through our level
        //   SELL resting at P: trade above P means price ran through our level
        const tradedThrough =
          opts.action === "buy"
            ? tradePrice < opts.price - 1e-9
            : tradePrice > opts.price + 1e-9;

        const tradedAt = Math.abs(tradePrice - opts.price) < 1e-9;

        if (tradedThrough) {
          verdict = "trade_through_fill";
          reason = "trade-through crossed resting maker price";
          fillProbability = 1;
          fillTsMs = evt.processedTsMs;
        } else if (tradedAt) {
          // Exact-price trade: accumulate volume. Fill only when cumulative
          // volume >= queuePosition + shares. Unknown queue (Infinity) can never be satisfied.
          cumulativeTradeAtPrice += tradeSize;
          if (isFinite(queuePosition) && cumulativeTradeAtPrice >= queuePosition + opts.shares) {
            verdict = "probable_fill";
            reason = "exact-price trade volume satisfied queue position";
            fillProbability = 1;
            fillTsMs = evt.processedTsMs;
          }
        }
      }
    }

    // ── Resolve non-fill verdict ───────────────────────────────────────────
    if (fillTsMs === null) {
      if (hasData && hasTouch) {
        verdict = "touch_only";
        reason = "price reached resting level but trade-through or queue satisfaction missing";
        fillProbability = 0;
      } else if (hasData) {
        verdict = "no_fill";
        reason = "price never reached resting level";
        fillProbability = 0;
      }
      // else: remains unknown_insufficient_data
    }

    // ── Markouts ──────────────────────────────────────────────────────────
    const markouts = {
      "1s": null as number | null,
      "5s": null as number | null,
      "30s": null as number | null,
      settlement: null as number | null,
    };
    const markoutReasons: Record<string, string> = {};
    let adverseSelection: boolean | null = null;

    if (fillTsMs !== null) {
      const fillForMarkout: FillForMarkout = {
        orderId: opts.orderId,
        tsMs: fillTsMs,
        side: opts.side,
        action: opts.action,
        price: opts.price,
      };

      const mkResults = calculateMarkouts(fillForMarkout, references, { maxObservationDistanceMs: 5000, skipSort: true });

      for (const res of mkResults) {
        const label =
          res.horizon === 1000 ? "1s"
          : res.horizon === 5000 ? "5s"
          : res.horizon === 30000 ? "30s"
          : "settlement";
        if (res.available && res.value !== null) {
          markouts[label as keyof typeof markouts] = res.value;
        } else if (res.reason) {
          markoutReasons[label] = res.reason;
        }
      }

      const m1s = markouts["1s"];
      const m5s = markouts["5s"];
      if (m1s !== null && m1s < 0) adverseSelection = true;
      else if (m5s !== null && m5s < 0) adverseSelection = true;
      else if (m1s !== null || m5s !== null) adverseSelection = false;
    } else {
      markoutReasons["1s"] = "missing_fill";
      markoutReasons["5s"] = "missing_fill";
      markoutReasons["30s"] = "missing_fill";
      markoutReasons["settlement"] = "missing_fill";
    }

    return {
      verdict,
      reason,
      fillProbability,
      adverseSelection,
      fillTsMs,
      markouts,
      markoutReasons,
    };
  }
}
