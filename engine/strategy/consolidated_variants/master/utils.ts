import type { StrategyContext } from "./types";

export type PriceSignal = {
  cancel: () => void;
};

const DEFAULT_POLL_MS = 100;

/**
 * Poll the order book until bestAsk reaches or exceeds `targetPrice`,
 * then invoke `onReached`. Cancelable via the returned signal.
 */
export function waitForAsk(
  ctx: StrategyContext,
  side: "UP" | "DOWN",
  targetPrice: number,
  onReached: (price: number) => void,
  pollMs = DEFAULT_POLL_MS,
): PriceSignal {
  const interval = ctx.clock.setInterval(() => {
    const bestAsk = ctx.orderBook.bestAskInfo(side)?.price;
    if (!bestAsk || isNaN(Number(bestAsk))) return;
    if (bestAsk >= targetPrice) {
      ctx.clock.clearInterval(interval);
      onReached(bestAsk);
    }
  }, pollMs);
  return { cancel: () => ctx.clock.clearInterval(interval) };
}

/**
 * Poll the order book until bestBid drops to or below `targetPrice`,
 * then invoke `onReached`. Cancelable via the returned signal.
 */
export function waitForBid(
  ctx: StrategyContext,
  side: "UP" | "DOWN",
  targetPrice: number,
  onReached: (price: number) => void,
  pollMs = DEFAULT_POLL_MS,
): PriceSignal {
  const interval = ctx.clock.setInterval(() => {
    const bestBid = ctx.orderBook.bestBidPrice(side);
    if (!bestBid || isNaN(Number(bestBid))) return;
    if (bestBid <= targetPrice) {
      ctx.clock.clearInterval(interval);
      onReached(bestBid);
    }
  }, pollMs);
  return { cancel: () => ctx.clock.clearInterval(interval) };
}
