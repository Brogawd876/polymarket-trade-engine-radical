import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../index';
import type { TelemetryEvent } from '../../types/telemetry';

describe('Telemetry Store', () => {
    beforeEach(() => {
        useStore.setState({
            isConnected: false,
            operatorStatus: null,
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
            priceHistory: {},
        });
    });

    it('processes SYSTEM_BOOT event', () => {
        const store = useStore.getState();
        store.processEvent({
            ts: 1000,
            type: 'SYSTEM_BOOT',
            payload: { version: '1.0.0', mode: 'sim', strategy: 'test' }
        });

        const updated = useStore.getState();
        expect(updated.bootInfo).toEqual({ version: '1.0.0', mode: 'sim', strategy: 'test' });
        expect(updated.eventTimeline).toHaveLength(1);
    });

    it('processes MARKET_TICK and maintains price history', () => {
        const store = useStore.getState();
        // The asset is now correctly typed as BotAsset = "btc" | "eth" ...
        store.processEvent({
            ts: 1000,
            type: 'MARKET_TICK',
            payload: {
                slug: 'BTC-5M',
                asset: 'btc',
                price: 65000,
                bid: 0.52,
                ask: 0.53,
                slotStartMs: 1778977500000,
                slotEndMs: 1778977800000,
                priceToBeat: 64950,
                gap: 50,
                direction: 'UP',
                upBid: 0.52,
                upAsk: 0.53,
                downBid: 0.47,
                downAsk: 0.48
            }
        });

        let updated = useStore.getState();
        expect(updated.markets['BTC-5M'].price).toBe(65000);
        expect(updated.markets['BTC-5M'].priceToBeat).toBe(64950);
        expect(updated.markets['BTC-5M'].direction).toBe('UP');
        expect(updated.markets['BTC-5M'].upBid).toBe(0.52);
        expect(updated.markets['BTC-5M'].downAsk).toBe(0.48);
        expect(updated.priceHistory['BTC-5M']).toHaveLength(1);
        expect(updated.priceHistory['BTC-5M'][0]).toEqual({ time: 1, value: 65000 });

        // Add tick in same second (duplicate timestamp should replace or skip)
        store.processEvent({
            ts: 1500,
            type: 'MARKET_TICK',
            payload: { slug: 'BTC-5M', asset: 'btc', price: 65005, bid: 64995, ask: 65015 }
        });

        updated = useStore.getState();
        expect(updated.priceHistory['BTC-5M']).toHaveLength(1);
        expect(updated.priceHistory['BTC-5M'][0].value).toBe(65005);

        // Add tick in next second
        store.processEvent({
            ts: 2000,
            type: 'MARKET_TICK',
            payload: { slug: 'BTC-5M', asset: 'btc', price: 65010, bid: null, ask: null }
        });

        updated = useStore.getState();
        expect(updated.priceHistory['BTC-5M']).toHaveLength(2);
    });

    it('processes PREDICTIVE_AGGREGATE event with correct backend shape', () => {
        const store = useStore.getState();
        const event: TelemetryEvent = {
            ts: 12345,
            type: 'PREDICTIVE_AGGREGATE',
            payload: {
                asset: 'btc',
                timestampMs: 12345,
                price: 65000,
                feeds: {
                    'binance': { price: 65001, quality: 'live', latestEventAgeMs: 10, arrivalDelayMs: 5 }
                },
                divergenceAbs: 1.5,
                divergencePct: 0.0001,
                disagreement: false
            }
        };
        store.processEvent(event);
        const updated = useStore.getState();
        expect(updated.predictiveAggregate?.price).toBe(65000);
        expect(updated.predictiveAggregate?.divergencePct).toBe(0.0001);
    });

    it('processes LEAD_LAG_UPDATE event with correct backend shape', () => {
        const store = useStore.getState();
        const event: TelemetryEvent = {
            ts: 12345,
            type: 'LEAD_LAG_UPDATE',
            payload: {
                asset: 'btc',
                timestampMs: 12345,
                feeds: {
                    'binance': { feed: 'binance', sampleCount: 100, latestArrivalDelayMs: 5, trailingAverageArrivalDelayMs: 6 }
                },
                observedTimingLeader: 'binance',
                observedTimingRunnerUp: 'coinbase',
                averageDelaySpreadMs: 10,
                leadershipConfidence: 'strong',
                sufficientSamples: true
            }
        };
        store.processEvent(event);
        const updated = useStore.getState();
        expect(updated.leadLag?.observedTimingLeader).toBe('binance');
        expect(updated.leadLag?.leadershipConfidence).toBe('strong');
    });

    it('processes FEED_STATUS event with string union quality', () => {
        const store = useStore.getState();
        const event: TelemetryEvent = {
            ts: 12345,
            type: 'FEED_STATUS',
            payload: {
                feed: 'binance',
                status: 'connected',
                quality: 'live'
            }
        };
        store.processEvent(event);
        const updated = useStore.getState();
        expect(updated.feeds['binance'].quality).toBe('live');
    });

    it('processes ROUND_RESOLUTION event', () => {
        const store = useStore.getState();
        store.processEvent({
            ts: 3000,
            type: 'ROUND_RESOLUTION',
            payload: {
                slug: 'btc-updown-5m-1778978400',
                openPrice: 78166.35,
                closePrice: 78170.42,
                direction: 'UP'
            }
        });

        const updated = useStore.getState();
        expect(updated.roundResolutions['btc-updown-5m-1778978400']).toEqual({
            openPrice: 78166.35,
            closePrice: 78170.42,
            direction: 'UP'
        });
        expect(updated.executionRows[0]).toEqual(expect.objectContaining({
            kind: 'resolution',
            status: 'resolved',
            slug: 'btc-updown-5m-1778978400',
            side: 'UP'
        }));
    });

    it('builds execution blotter rows from intent, risk, order, and PnL telemetry', () => {
        const store = useStore.getState();
        const intent = {
            id: 'intent-1',
            slug: 'btc-updown-5m-1778978400',
            strategyName: 'simulation',
            createdAtMs: 1000,
            reason: 'strategy requested order placement',
            triggerEventIds: [],
            round: {
                slug: 'btc-updown-5m-1778978400',
                asset: 'btc' as const,
                window: '5m',
                startTimeMs: 1778978400000,
                endTimeMs: 1778978700000
            },
            action: 'buy' as const,
            side: 'UP' as const,
            tokenId: 'up-token',
            price: 0.49,
            shares: 5,
            orderType: 'GTC' as const,
            expireAtMs: 1778978700000
        };

        store.processEvent({
            ts: 1000,
            type: 'ORDER_INTENT',
            payload: { slug: intent.slug, intent }
        });
        store.processEvent({
            ts: 1001,
            type: 'RISK_DECISION',
            payload: {
                slug: intent.slug,
                approved: false,
                reasons: ['predictive disagreement'],
                intent
            }
        });
        store.processEvent({
            ts: 1002,
            type: 'ORDER_LIFECYCLE',
            payload: {
                slug: intent.slug,
                orderId: 'order-1',
                intentId: intent.id,
                status: 'failed',
                side: 'UP',
                action: 'buy',
                price: 0.49,
                shares: 5,
                error: 'rejected by venue'
            }
        });
        store.processEvent({
            ts: 1003,
            type: 'ROUND_PNL',
            payload: { slug: intent.slug, pnl: -1.2 }
        });

        const rows = useStore.getState().executionRows;
        expect(rows).toHaveLength(4);
        expect(rows[3]).toEqual(expect.objectContaining({ kind: 'intent', status: 'attempted', intentId: 'intent-1' }));
        expect(rows[2]).toEqual(expect.objectContaining({ kind: 'risk', status: 'blocked', reason: 'predictive disagreement' }));
        expect(rows[1]).toEqual(expect.objectContaining({ kind: 'order', status: 'failed', orderId: 'order-1', intentId: 'intent-1' }));
        expect(rows[0]).toEqual(expect.objectContaining({ kind: 'settlement', status: 'settled', pnl: -1.2 }));
    });
});

