import type { 
  BotAsset, 
  FeedQuality, 
  PredictiveAggregateSnapshot, 
  LeadLagSnapshot,
} from "../bot-core/data-sources.ts";
import type { StrategyIntent } from "../bot-core/strategy-intent.ts";
import type { DecisionFeatureSnapshot } from "../decision-features.ts";

export type TelemetryEvent = {
  ts: number; // Engine's nowMs()
} & (
  | { type: "SYSTEM_BOOT"; payload: { version: string; mode: "live" | "sim" | "replay"; strategy: string } }
  | { type: "FEED_STATUS"; payload: { feed: string; status: "connected" | "stale" | "error" | "forbidden"; quality: FeedQuality; message?: string } }
  | { type: "LIFECYCLE_STATE"; payload: { slug: string; from: string; to: string } }
  | { type: "MARKET_TICK"; payload: { slug: string; asset: BotAsset; price: number; bid: number | null; ask: number | null; slotStartMs?: number; slotEndMs?: number; priceToBeat?: number | null; gap?: number | null; direction?: "UP" | "DOWN" | "TIE" | null; upBid?: number | null; upAsk?: number | null; downBid?: number | null; downAsk?: number | null; probabilityUp?: number | null; sigma?: number | null } }
  | { type: "PREDICTIVE_AGGREGATE"; payload: PredictiveAggregateSnapshot }
  | { type: "LEAD_LAG_UPDATE"; payload: LeadLagSnapshot }
  | { type: "ORDER_INTENT"; payload: { slug: string; intent: StrategyIntent } }
  | { type: "RISK_DECISION"; payload: { slug: string; approved: boolean; reasons: string[]; intent: StrategyIntent } }
  | { type: "ORDER_LIFECYCLE"; payload: { slug: string; orderId?: string; intentId?: string; status: "placed" | "filled" | "partial_filled" | "canceled" | "expired" | "failed"; side: "UP" | "DOWN"; action: "buy" | "sell"; price: number; shares: number; error?: string } }
  | { type: "ROUND_PNL"; payload: { slug: string; pnl: number } }
  | { type: "ROUND_OBSERVABILITY"; payload: { slug: string; markouts: Record<string, number>; adverseSelection: number } }
  | { type: "ROUND_RESOLUTION"; payload: { slug: string; openPrice: number; closePrice: number; direction: "UP" | "DOWN" } }
  | { type: "SESSION_PNL"; payload: { pnl: number; loss: number } }
  | { type: "REPLAY_PROGRESS"; payload: { totalEvents: number; processedEvents: number; isDone: boolean; virtualTimeMs: number } }
  | { type: "DECISION_FEATURE_SNAPSHOT"; payload: DecisionFeatureSnapshot }
);

export interface TelemetrySink {
  push(event: TelemetryEvent): void;
}
