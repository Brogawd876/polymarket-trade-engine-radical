import type { BotFeedEvent, RoundWindow } from "./data-sources.ts";

export type StrategyIntentSide = "UP" | "DOWN";
export type StrategyIntentAction = "buy" | "sell" | "cancel" | "hold";
export type StrategyIntentOrderType = "GTC" | "FOK";

export type StrategyIntentBase = {
  id: string;
  slug: string;
  strategyName: string;
  createdAtMs: number;
  reason: string;
  triggerEventIds: string[];
  round: RoundWindow;
};

export type PlaceOrderIntent = StrategyIntentBase & {
  action: "buy" | "sell";
  side: StrategyIntentSide;
  tokenId: string;
  price: number;
  shares: number;
  orderType?: StrategyIntentOrderType;
  expireAtMs: number;
};

export type CancelOrderIntent = StrategyIntentBase & {
  action: "cancel";
  orderIds: string[];
};

export type HoldIntent = StrategyIntentBase & {
  action: "hold";
};

export type StrategyIntent =
  | PlaceOrderIntent
  | CancelOrderIntent
  | HoldIntent;

export type StrategyDecisionContext = {
  round: RoundWindow;
  resolution: BotFeedEvent | null;
  venue: BotFeedEvent | null;
  predictiveFeeds: BotFeedEvent[];
};

export function createIntentId(prefix = "intent"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function isPlaceOrderIntent(
  intent: StrategyIntent,
): intent is PlaceOrderIntent {
  return intent.action === "buy" || intent.action === "sell";
}
