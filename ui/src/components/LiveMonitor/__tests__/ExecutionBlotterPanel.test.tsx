import '../../../test/dom';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecutionBlotterPanel, matchesExecutionFilter } from '../ExecutionBlotterPanel';
import { useStore, type ExecutionRow } from '../../../store';

describe('ExecutionBlotterPanel', () => {
    afterEach(() => {
        cleanup();
    });

    beforeEach(() => {
        useStore.setState({
            executionRows: [],
        });
    });

    it('renders execution rows and expands risk reasons', () => {
        useStore.setState({
            executionRows: [
                {
                    id: 'risk-1',
                    ts: 1778978401000,
                    kind: 'risk',
                    status: 'blocked',
                    slug: 'btc-updown-5m-1778978400',
                    side: 'UP',
                    action: 'buy',
                    intentId: 'intent-1',
                    price: 0.49,
                    shares: 5,
                    reason: 'predictive disagreement; stale venue/orderbook information',
                    reasons: ['predictive disagreement', 'stale venue/orderbook information'],
                    sourceEvent: 'RISK_DECISION',
                },
                {
                    id: 'order-1',
                    ts: 1778978400000,
                    kind: 'order',
                    status: 'placed',
                    slug: 'btc-updown-5m-1778978400',
                    side: 'UP',
                    action: 'buy',
                    orderId: 'order-1',
                    intentId: 'intent-1',
                    price: 0.49,
                    shares: 5,
                    sourceEvent: 'ORDER_LIFECYCLE',
                },
            ],
        });

        const view = render(<ExecutionBlotterPanel />);

        expect(view.getByText('Execution Blotter')).toBeTruthy();
        expect(view.getByText('BLOCKED')).toBeTruthy();
        expect(view.getByText('PLACED')).toBeTruthy();
        fireEvent.click(view.getByText('predictive disagreement; stale venue/orderbook information'));
        expect(view.getByText('Source:')).toBeTruthy();
        expect(view.getByText('intent-1')).toBeTruthy();
        expect(view.getByText('stale venue/orderbook information')).toBeTruthy();
    });

    it('filters blocked rows', () => {
        const placed: ExecutionRow = {
            id: 'placed',
            ts: 1,
            kind: 'order',
            status: 'placed',
            slug: 'round',
            sourceEvent: 'ORDER_LIFECYCLE',
        };
        const blocked: ExecutionRow = {
            id: 'blocked',
            ts: 2,
            kind: 'risk',
            status: 'blocked',
            slug: 'round',
            sourceEvent: 'RISK_DECISION',
        };

        expect(matchesExecutionFilter(placed, 'blocked')).toBe(false);
        expect(matchesExecutionFilter(blocked, 'blocked')).toBe(true);
    });
});
