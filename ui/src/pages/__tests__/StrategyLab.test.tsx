import '../../test/dom';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StrategyLab from '../StrategyLab';
import { useStore } from '../../store';

const fixture = {
    path: 'logs/filled-order.log',
    label: 'btc-updown-5m-1778891400 (simulation)',
    replayable: true,
    validationStatus: 'valid',
    slug: 'btc-updown-5m-1778891400',
};

const completedBatch = {
    id: 'batch-1',
    state: 'completed',
    progress: { totalRuns: 1, completedRuns: 1 },
    summary: {
        totalRuns: 1,
        completed: 1,
        failed: 0,
        canceled: 0,
        winRate: 1,
        totalPnl: 1.05,
        avgPnl: 1.05,
        bestPnl: 1.05,
        worstPnl: 1.05,
        blocked: 0,
        problems: 0,
        byStrategy: [{
            strategy: 'simulation',
            baseStrategy: 'simulation',
            label: 'simulation',
            paperEligible: true,
            runs: 1,
            completed: 1,
            failed: 0,
            canceled: 0,
            wins: 1,
            losses: 0,
            noTrades: 0,
            tradeCount: 1,
            winRate: 1,
            tradeRate: 1,
            totalPnl: 1.05,
            avgPnl: 1.05,
            bestPnl: 1.05,
            worstPnl: 1.05,
            blocked: 0,
            problems: 0,
            score: 21.5,
        }],
        recommendation: {
            strategy: 'simulation',
            label: 'simulation',
            score: 21.5,
            readyForPaper: true,
            rationale: ['Ranked #1 by safety-weighted score (21.50).'],
        },
    },
    runs: [{
        id: 'run-1',
        strategy: 'simulation',
        file: fixture.path,
        slug: fixture.slug,
        status: 'completed',
        baseStrategy: 'simulation',
        variantLabel: 'simulation',
        paperEligible: true,
        pnl: 1.05,
        direction: 'DOWN',
        openPrice: 79136.21,
        closePrice: 79122.36,
        counts: { intents: 2, allowed: 2, blocked: 0, fills: 2, problems: 0, settlements: 1 },
        verdict: 'win',
    }],
};

describe('StrategyLab', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        useStore.setState({ isConnected: true });
    });

    afterEach(() => {
        cleanup();
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('loads strategy choices and replayable fixtures', async () => {
        globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
            const target = String(url);
            if (target.endsWith('/strategy-lab/strategies')) return Response.json({
                strategies: ['late-entry', 'simulation'],
                variants: [
                    { id: 'late-entry-loose', label: 'late-entry loose', strategy: 'late-entry', description: 'Looser replay tuning', config: {}, paperEligible: false },
                    { id: 'simulation', label: 'simulation', strategy: 'simulation', description: 'Baseline', config: {}, paperEligible: true },
                ],
            });
            if (target.endsWith('/replay-fixtures')) return Response.json({ files: [fixture] });
            return Response.json({});
        }) as typeof fetch;

        const view = render(<StrategyLab />);

        expect(await view.findByText('Strategy Lab')).toBeTruthy();
        expect((await view.findAllByText('simulation')).length).toBeGreaterThanOrEqual(1);
        expect((await view.findAllByText('late-entry loose')).length).toBeGreaterThanOrEqual(1);
        expect(await view.findByText(fixture.label)).toBeTruthy();
    });

    it('disables Run Batch with no strategy or no fixture', async () => {
        globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
            const target = String(url);
            if (target.endsWith('/strategy-lab/strategies')) return Response.json({ strategies: ['simulation'] });
            if (target.endsWith('/replay-fixtures')) return Response.json({ files: [fixture] });
            return Response.json({});
        }) as typeof fetch;

        const view = render(<StrategyLab />);
        const strategyCheckbox = await view.findByLabelText('simulation');
        fireEvent.click(strategyCheckbox);

        expect((view.getByText('Run Batch').closest('button') as HTMLButtonElement).disabled).toBe(true);
    });

    it('renders completed batch summary and result rows', async () => {
        globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
            const target = String(url);
            if (target.endsWith('/strategy-lab/strategies')) return Response.json({ strategies: ['simulation'] });
            if (target.endsWith('/replay-fixtures')) return Response.json({ files: [fixture] });
            if (target.endsWith('/strategy-lab/batches')) return Response.json({ success: true, batchId: 'batch-1', batch: { ...completedBatch, state: 'running' } });
            if (target.endsWith('/strategy-lab/batches/batch-1')) return Response.json({ success: true, batch: completedBatch });
            return Response.json({});
        }) as typeof fetch;

        const view = render(<StrategyLab />);
        fireEvent.click(await view.findByText('Run Batch'));

        expect((await view.findAllByText('100%')).length).toBeGreaterThanOrEqual(1);
        expect((await view.findAllByText('$1.05')).length).toBeGreaterThanOrEqual(1);
        expect(await view.findByText('win')).toBeTruthy();
        expect(await view.findByText('DOWN: $79136.21 -> $79122.36')).toBeTruthy();
        expect(await view.findByText('Recommendation')).toBeTruthy();
        expect(await view.findByText('Variant Ranking')).toBeTruthy();
        expect(await view.findByText('paper candidate')).toBeTruthy();
    });

    it('shows failed rows without breaking the table', async () => {
        const failedBatch = {
            ...completedBatch,
            state: 'failed',
            summary: { ...completedBatch.summary, completed: 0, failed: 1, winRate: null, totalPnl: 0, avgPnl: null },
            runs: [{
                ...completedBatch.runs[0],
                status: 'failed',
                verdict: 'failed',
                pnl: null,
                error: 'Replay log parse failed',
            }],
        };

        globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
            const target = String(url);
            if (target.endsWith('/strategy-lab/strategies')) return Response.json({ strategies: ['simulation'] });
            if (target.endsWith('/replay-fixtures')) return Response.json({ files: [fixture] });
            if (target.endsWith('/strategy-lab/batches')) return Response.json({ success: true, batchId: 'batch-1', batch: { ...failedBatch, state: 'running' } });
            if (target.endsWith('/strategy-lab/batches/batch-1')) return Response.json({ success: true, batch: failedBatch });
            return Response.json({});
        }) as typeof fetch;

        const view = render(<StrategyLab />);
        fireEvent.click(await view.findByText('Run Batch'));

        await waitFor(() => expect(view.getAllByText('failed').length).toBeGreaterThanOrEqual(1));
        expect(view.getByText('Replay log parse failed')).toBeTruthy();
    });
});
