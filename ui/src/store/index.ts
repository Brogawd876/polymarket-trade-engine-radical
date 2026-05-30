import { create } from 'zustand';
import type { TelemetryEvent, FeedQuality, PredictiveAggregateSnapshot, LeadLagSnapshot, OrderIntentSnapshot, DecisionFeatureSnapshot } from '../types/telemetry';

interface FeedState {
    status: "connected" | "stale" | "error" | "forbidden";
    quality: FeedQuality;
    message?: string;
    lastUpdated: number;
}

interface MarketState {
    price: number;
    bid: number | null;
    ask: number | null;
    slotStartMs?: number;
    slotEndMs?: number;
    priceToBeat?: number | null;
    gap?: number | null;
    direction?: "UP" | "DOWN" | "TIE" | null;
    upBid?: number | null;
    upAsk?: number | null;
    downBid?: number | null;
    downAsk?: number | null;
    probabilityUp: number | null;
    sigma: number | null;
    lastUpdated: number;
}

interface RiskDecision {
    ts: number;
    slug: string;
    approved: boolean;
    reasons: string[];
    intent: OrderIntentSnapshot;
}

export type ExecutionRowKind = 'intent' | 'risk' | 'order' | 'settlement' | 'resolution';
export type ExecutionRowStatus =
    | 'attempted'
    | 'allowed'
    | 'blocked'
    | 'placed'
    | 'filled'
    | 'partial_filled'
    | 'canceled'
    | 'expired'
    | 'failed'
    | 'settled'
    | 'resolved';

export interface ExecutionRow {
    id: string;
    ts: number;
    kind: ExecutionRowKind;
    status: ExecutionRowStatus;
    slug: string;
    side?: "UP" | "DOWN";
    action?: "buy" | "sell" | "cancel" | "hold";
    orderId?: string;
    intentId?: string;
    price?: number;
    shares?: number;
    pnl?: number;
    reason?: string;
    reasons?: string[];
    sourceEvent: TelemetryEvent['type'];
}

interface RoundResolution {
    openPrice: number;
    closePrice: number;
    direction: "UP" | "DOWN";
}

interface ChartDataPoint {
    time: number; // Unix timestamp in seconds
    value: number;
}

export interface AppState {
    // Connection State
    isConnected: boolean;
    setConnected: (status: boolean) => void;

    // Backend System Status (from REST /api/status)
    operatorStatus: import('../types/telemetry').OperatorStatus | null;
    setOperatorStatus: (status: import('../types/telemetry').OperatorStatus) => void;

    // Latest Telemetry State
    bootInfo: { version: string; mode: string; strategy: string } | null;
    feeds: Record<string, FeedState>;
    markets: Record<string, MarketState>;
    lifecycleStates: Record<string, string>;
    predictiveAggregate: PredictiveAggregateSnapshot | null;
    leadLag: LeadLagSnapshot | null;
    latestRiskDecisions: RiskDecision[];
    executionRows: ExecutionRow[];
    eventTimeline: TelemetryEvent[];
    sessionPnl: { pnl: number; loss: number } | null;
    roundPnl: Record<string, number>;
    roundResolutions: Record<string, RoundResolution>;
    replayProgress: { totalEvents: number; processedEvents: number; isDone: boolean; virtualTimeMs: number } | null;
    decisionSnapshots: DecisionFeatureSnapshot[];
    
    // Chart Series (derived from events)
    priceHistory: Record<string, ChartDataPoint[]>;

    // Actions
    processEvent: (event: TelemetryEvent) => void;
    clearEvents: () => void;
    clearAllTelemetry: () => void;
    }

    const MAX_TIMELINE_EVENTS = 100;
    const MAX_CHART_POINTS = 1000;
    const MAX_EXECUTION_ROWS = 200;
    const REPLAY_MARKET_RENDER_INTERVAL_MS = 1_000;

    function pushExecutionRow(rows: ExecutionRow[], row: ExecutionRow) {
    return [row, ...rows].slice(0, MAX_EXECUTION_ROWS);
    }

    export const useStore = create<AppState>((set) => ({
    isConnected: false,
    setConnected: (isConnected) => set({ isConnected }),

    operatorStatus: null,
    setOperatorStatus: (status) => set({ operatorStatus: status }),

    bootInfo: null,
    feeds: {},
    markets: {},
    lifecycleStates: {},
    predictiveAggregate: null,
    leadLag: null,
    latestRiskDecisions: [],
    executionRows: [],
    eventTimeline: [],
    sessionPnl: null,
    roundPnl: {},
    roundResolutions: {},
    replayProgress: null,
    decisionSnapshots: [],
    priceHistory: {},

    clearEvents: () => set({ eventTimeline: [], executionRows: [], priceHistory: {}, decisionSnapshots: [] }),

    clearAllTelemetry: () => set({
        bootInfo: null,
        feeds: {},
        markets: {},
        lifecycleStates: {},
        predictiveAggregate: null,
        leadLag: null,
        latestRiskDecisions: [],
        executionRows: [],
        eventTimeline: [],
        sessionPnl: null,
        roundPnl: {},
        roundResolutions: {},
        replayProgress: null,
        decisionSnapshots: [],
        priceHistory: {},
    }),

    processEvent: (event) => set((state) => {
        if (state.bootInfo?.mode === 'replay') {
            if (event.type === 'MARKET_TICK') {
                const lastMarket = state.markets[event.payload.slug];
                if (lastMarket && event.ts - lastMarket.lastUpdated < REPLAY_MARKET_RENDER_INTERVAL_MS) {
                    return state;
                }
            }
            if (
                event.type === 'PREDICTIVE_AGGREGATE' &&
                state.predictiveAggregate &&
                event.ts - state.predictiveAggregate.timestampMs < REPLAY_MARKET_RENDER_INTERVAL_MS
            ) {
                return state;
            }
            if (
                event.type === 'LEAD_LAG_UPDATE' &&
                state.leadLag &&
                event.ts - state.leadLag.timestampMs < REPLAY_MARKET_RENDER_INTERVAL_MS
            ) {
                return state;
            }
        }

        const nextState = { ...state };
        
        // Add to timeline
        nextState.eventTimeline = [event, ...state.eventTimeline].slice(0, MAX_TIMELINE_EVENTS);

        switch (event.type) {
            case "SYSTEM_BOOT":
                nextState.bootInfo = event.payload;
                break;
            case "FEED_STATUS":
                nextState.feeds = {
                    ...state.feeds,
                    [event.payload.feed]: {
                        status: event.payload.status,
                        quality: event.payload.quality,
                        message: event.payload.message,
                        lastUpdated: event.ts
                    }
                };
                break;
            case "LIFECYCLE_STATE":
                nextState.lifecycleStates = {
                    ...state.lifecycleStates,
                    [event.payload.slug]: event.payload.to
                };
                break;
            case "MARKET_TICK": {
                const {
                    slug,
                    price,
                    bid,
                    ask,
                    slotStartMs,
                    slotEndMs,
                    priceToBeat,
                    gap,
                    direction,
                    upBid,
                    upAsk,
                    downBid,
                    downAsk
                } = event.payload;
                nextState.markets = {
                    ...state.markets,
                    [slug]: {
                        price,
                        bid,
                        ask,
                        slotStartMs,
                        slotEndMs,
                        priceToBeat,
                        gap,
                        direction,
                        upBid,
                        upAsk,
                        downBid,
                        downAsk,
                        probabilityUp: event.payload.probabilityUp ?? null,
                        sigma: event.payload.sigma ?? null,
                        lastUpdated: event.ts
                    }
                };
                // Update chart history
                const currentHistory = state.priceHistory[slug] || [];
                const newPoint = { time: Math.floor(event.ts / 1000), value: price };
                // avoid duplicate timestamps by replacing the last one if it matches
                const lastPoint = currentHistory[currentHistory.length - 1];
                let newHistory;
                if (lastPoint && lastPoint.time === newPoint.time) {
                    newHistory = [...currentHistory.slice(0, -1), newPoint];
                } else {
                    newHistory = [...currentHistory, newPoint].slice(-MAX_CHART_POINTS);
                }
                nextState.priceHistory = {
                    ...state.priceHistory,
                    [slug]: newHistory
                };
                break;
            }
            case "PREDICTIVE_AGGREGATE":
                nextState.predictiveAggregate = event.payload;
                break;
            case "LEAD_LAG_UPDATE":
                nextState.leadLag = event.payload;
                break;
            case "RISK_DECISION":
                nextState.latestRiskDecisions = [
                    { ts: event.ts, ...event.payload },
                    ...state.latestRiskDecisions
                ].slice(0, 10);
                nextState.executionRows = pushExecutionRow(nextState.executionRows, {
                    id: `risk-${event.ts}-${event.payload.intent.id}`,
                    ts: event.ts,
                    kind: 'risk',
                    status: event.payload.approved ? 'allowed' : 'blocked',
                    slug: event.payload.slug,
                    side: event.payload.intent.side,
                    action: event.payload.intent.action,
                    intentId: event.payload.intent.id,
                    price: event.payload.intent.price,
                    shares: event.payload.intent.shares,
                    reason: event.payload.reasons.join('; '),
                    reasons: event.payload.reasons,
                    sourceEvent: event.type
                });
                break;
            case "ORDER_INTENT":
                nextState.executionRows = pushExecutionRow(nextState.executionRows, {
                    id: `intent-${event.ts}-${event.payload.intent.id}`,
                    ts: event.ts,
                    kind: 'intent',
                    status: 'attempted',
                    slug: event.payload.slug,
                    side: event.payload.intent.side,
                    action: event.payload.intent.action,
                    intentId: event.payload.intent.id,
                    price: event.payload.intent.price,
                    shares: event.payload.intent.shares,
                    reason: event.payload.intent.reason,
                    sourceEvent: event.type
                });
                break;
            case "ORDER_LIFECYCLE":
                nextState.executionRows = pushExecutionRow(nextState.executionRows, {
                    id: `order-${event.ts}-${event.payload.orderId ?? event.payload.intentId ?? `${event.payload.action}-${event.payload.side}`}-${event.payload.status}`,
                    ts: event.ts,
                    kind: 'order',
                    status: event.payload.status,
                    slug: event.payload.slug,
                    side: event.payload.side,
                    action: event.payload.action,
                    orderId: event.payload.orderId,
                    intentId: event.payload.intentId,
                    price: event.payload.price,
                    shares: event.payload.shares,
                    reason: event.payload.error,
                    sourceEvent: event.type
                });
                break;
            case "ROUND_PNL":
                nextState.roundPnl = {
                    ...state.roundPnl,
                    [event.payload.slug]: event.payload.pnl
                };
                nextState.executionRows = pushExecutionRow(nextState.executionRows, {
                    id: `pnl-${event.ts}-${event.payload.slug}`,
                    ts: event.ts,
                    kind: 'settlement',
                    status: 'settled',
                    slug: event.payload.slug,
                    pnl: event.payload.pnl,
                    sourceEvent: event.type
                });
                break;
            case "ROUND_RESOLUTION":
                nextState.roundResolutions = {
                    ...state.roundResolutions,
                    [event.payload.slug]: {
                        openPrice: event.payload.openPrice,
                        closePrice: event.payload.closePrice,
                        direction: event.payload.direction
                    }
                };
                nextState.executionRows = pushExecutionRow(nextState.executionRows, {
                    id: `resolution-${event.ts}-${event.payload.slug}`,
                    ts: event.ts,
                    kind: 'resolution',
                    status: 'resolved',
                    slug: event.payload.slug,
                    side: event.payload.direction,
                    price: event.payload.closePrice,
                    reason: `Open $${event.payload.openPrice.toFixed(2)} -> close $${event.payload.closePrice.toFixed(2)}`,
                    sourceEvent: event.type
                });
                break;
            case "SESSION_PNL":
                nextState.sessionPnl = event.payload;
                break;
            case "REPLAY_PROGRESS":
                nextState.replayProgress = event.payload;
                break;
            case "DECISION_FEATURE_SNAPSHOT":
                nextState.decisionSnapshots = [event.payload, ...state.decisionSnapshots].slice(0, 100);
                break;
        }

        return nextState;
    })
}));
