import '../../../test/dom';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoundDecisionPanel } from '../RoundDecisionPanel';
import { useStore } from '../../../store';

describe('RoundDecisionPanel', () => {
    afterEach(() => {
        cleanup();
    });

    beforeEach(() => {
        useStore.setState({
            markets: {},
            lifecycleStates: {},
            roundResolutions: {},
        });
    });

    it('renders live round truth from backend-shaped market telemetry', () => {
        useStore.setState({
            markets: {
                'btc-updown-5m-1778978400': {
                    price: 78168.80,
                    bid: 0.51,
                    ask: 0.52,
                    slotStartMs: Date.now() - 10_000,
                    slotEndMs: Date.now() + 240_000,
                    priceToBeat: 78166.35,
                    gap: 2.45,
                    direction: "UP",
                    upBid: 0.51,
                    upAsk: 0.52,
                    downBid: 0.48,
                    downAsk: 0.49,
                    probabilityUp: null,
                    sigma: null,
                    lastUpdated: Date.now(),
                },

            },
            lifecycleStates: {
                'btc-updown-5m-1778978400': 'RUNNING',
            },
        });

        const view = render(<RoundDecisionPanel />);

        expect(view.getByText('btc-updown-5m-1778978400')).toBeTruthy();
        expect(view.getByText('LIVE')).toBeTruthy();
        expect(view.getByText('UP')).toBeTruthy();
        expect(view.getByText('$78168.80')).toBeTruthy();
        expect(view.getByText('$78166.35')).toBeTruthy();
        expect(view.getByText('+$2.45')).toBeTruthy();
    });

    it('distinguishes ended awaiting-resolution state from final resolution', () => {
        useStore.setState({
            markets: {
                'btc-updown-5m-1778978400': {
                    price: 78160,
                    bid: 0.04,
                    ask: 0.05,
                    slotEndMs: Date.now() - 1_000,
                    priceToBeat: 78166.35,
                    gap: -6.35,
                    direction: 'DOWN',
                    probabilityUp: null,
                    sigma: null,
                    lastUpdated: Date.now(),
                },
            },
            lifecycleStates: {
                'btc-updown-5m-1778978400': 'STOPPING',
            },
        });

        const view = render(<RoundDecisionPanel />);
        expect(view.getByText('CLOSING')).toBeTruthy();
        expect(view.getByText('Ended')).toBeTruthy();
        expect(view.getByText('0:00')).toBeTruthy();
        expect(view.getByText('Current Result')).toBeTruthy();
        expect(view.getByText('DOWN')).toBeTruthy();

        useStore.setState({
            roundResolutions: {
                'btc-updown-5m-1778978400': {
                    openPrice: 78166.35,
                    closePrice: 78160,
                    direction: 'DOWN',
                },
            },
        });
        view.rerender(<RoundDecisionPanel />);

        expect(view.getByText('RESOLVED DOWN')).toBeTruthy();
        expect(view.getByText('Final Result')).toBeTruthy();
        expect(view.getByText('FINAL')).toBeTruthy();
    });
});
