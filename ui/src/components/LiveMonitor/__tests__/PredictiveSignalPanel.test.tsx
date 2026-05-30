import { describe, expect, it } from 'vitest';
import { formatDivergencePct } from '../PredictiveSignalPanel';

describe('PredictiveSignalPanel', () => {
    it('formats backend divergence percent without multiplying by 100 again', () => {
        const binancePrice = 78135.20;
        const coinbasePrice = 78135.50;
        const averagePrice = (binancePrice + coinbasePrice) / 2;
        const backendDivergencePct = ((coinbasePrice - binancePrice) / averagePrice) * 100;

        expect(formatDivergencePct(backendDivergencePct)).toBe('0.0004%');
    });
});
