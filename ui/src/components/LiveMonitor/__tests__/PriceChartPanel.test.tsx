import '../../../test/dom';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PriceChartPanel } from '../PriceChartPanel';
import { useStore } from '../../../store';

const createPriceLine = vi.fn();
const removePriceLine = vi.fn();
const setData = vi.fn();

vi.mock('lightweight-charts', () => ({
    ColorType: { Solid: 'Solid' },
    LineSeries: 'LineSeries',
    LineStyle: { Dashed: 2 },
    createChart: () => ({
        addLineSeries: () => ({
            setData,
            createPriceLine,
            removePriceLine,
        }),
        addSeries: () => ({
            setData,
            createPriceLine,
            removePriceLine,
        }),
        applyOptions: vi.fn(),
        remove: vi.fn(),
    }),
}));

describe('PriceChartPanel', () => {
    afterEach(() => {
        cleanup();
    });

    beforeEach(() => {
        createPriceLine.mockReset();
        removePriceLine.mockReset();
        setData.mockReset();
        createPriceLine.mockReturnValue({ id: 'target-line' });
        useStore.setState({
            markets: {},
            priceHistory: {},
        });
    });

    it('creates a target price line from the active market price to beat', () => {
        useStore.setState({
            markets: {
                'btc-updown-5m-1778978400': {
                    price: 78168.80,
                    bid: 0.51,
                    ask: 0.52,
                    priceToBeat: 78166.35,
                    probabilityUp: null,
                    sigma: null,
                    lastUpdated: 1778978460000,
                },
            },
            priceHistory: {
                'btc-updown-5m-1778978400': [
                    { time: 1778978400, value: 78166.35 },
                    { time: 1778978460, value: 78168.80 },
                ],
            },
        });

        const view = render(<PriceChartPanel />);

        expect(view.getByTestId('chart-target-label').textContent).toContain('Target $78166.35');
        expect(createPriceLine).toHaveBeenCalledWith(expect.objectContaining({
            price: 78166.35,
            title: 'Target',
        }));
    });
});
