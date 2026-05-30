import '../../test/dom';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LiveReadiness from '../LiveReadiness';

describe('LiveReadiness', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
        cleanup();
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('loads modules, presets, fixtures, and validates custom code failures', async () => {
        globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            const target = String(url);
            if (target.endsWith('/strategy/modules') && !target.endsWith('/validate')) {
                return Response.json({
                    modules: [{
                        id: 'simulation',
                        label: 'simulation',
                        version: '1.0.0',
                        description: 'Baseline',
                        defaultConfig: {},
                        paperEligible: true,
                        liveEligible: false,
                        source: 'built-in',
                        validationStatus: 'valid',
                        validationErrors: [],
                    }],
                });
            }
            if (target.endsWith('/strategy/presets')) {
                return Response.json({
                    presets: [{
                        id: 'simulation',
                        moduleId: 'simulation',
                        label: 'simulation',
                        config: {},
                        configHash: 'abc123',
                        riskProfile: 'paper',
                        notes: '',
                        promotionStatus: 'paper_candidate',
                    }],
                });
            }
            if (target.endsWith('/replay-fixtures')) {
                return Response.json({ files: [{ path: 'logs/a.log', label: 'a', replayable: true }] });
            }
            if (target.endsWith('/strategy/evidence')) {
                return Response.json({ evidence: [] });
            }
            if (target.endsWith('/strategy/modules/validate')) {
                expect(init?.method).toBe('POST');
                return Response.json({ success: false, errors: ['Source code must include an evaluate function'] }, { status: 400 });
            }
            return Response.json({});
        }) as typeof fetch;

        const view = render(<LiveReadiness />);
        expect(await view.findByText('Live Readiness')).toBeTruthy();
        expect((await view.findAllByText('simulation')).length).toBeGreaterThan(0);
        fireEvent.change(view.getByDisplayValue(/export const module/), { target: { value: 'export const module = {};' } });
        fireEvent.click(view.getByText('Validate & Save Replay-Only Module'));

        await waitFor(() => expect(view.getByText('Source code must include an evaluate function')).toBeTruthy());
    });

    it('runs an experiment and shows paper tuning recommendation', async () => {
        globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
            const target = String(url);
            if (target.endsWith('/strategy/modules')) {
                return Response.json({ modules: [{ id: 'simulation', label: 'simulation', version: '1.0.0', description: 'Baseline', defaultConfig: {}, paperEligible: true, liveEligible: false, source: 'built-in', validationStatus: 'valid', validationErrors: [] }] });
            }
            if (target.endsWith('/strategy/presets')) {
                return Response.json({ presets: [{ id: 'simulation', moduleId: 'simulation', label: 'simulation', config: {}, configHash: 'abc123', riskProfile: 'paper', notes: '', promotionStatus: 'paper_candidate' }] });
            }
            if (target.endsWith('/replay-fixtures')) {
                return Response.json({ files: [{ path: 'logs/a.log', label: 'a', replayable: true }, { path: 'logs/b.log', label: 'b', replayable: true }, { path: 'logs/c.log', label: 'c', replayable: true }, { path: 'logs/d.log', label: 'd', replayable: true }] });
            }
            if (target.endsWith('/strategy/evidence')) {
                return Response.json({ evidence: [{ id: 'row-1', presetId: 'simulation', moduleId: 'simulation', label: 'simulation', configHash: 'abc123', startedAtMs: 1, endedAtMs: 2, status: 'completed', pnl: 0.5, fills: 1, blocked: 0, problems: 0, decisionSnapshots: 2, verdict: 'win' }] });
            }
            if (target.endsWith('/strategy-lab/experiments')) {
                return Response.json({ success: true, experimentId: 'exp-1', experiment: { id: 'exp-1', name: 'Replay to paper recommendation', state: 'running', recommendation: null } });
            }
            if (target.endsWith('/strategy-lab/experiments/exp-1')) {
                return Response.json({ success: true, experiment: { id: 'exp-1', name: 'Replay to paper recommendation', state: 'completed', train: { summary: { totalRuns: 3, totalPnl: 1, winRate: 1, problems: 0 } }, recommendation: { id: 'rec-1', presetId: 'simulation', moduleId: 'simulation', score: 20, readyForPaper: true, applied: false, rationale: ['Holdout passed.'] } } });
            }
            return Response.json({});
        }) as typeof fetch;

        const view = render(<LiveReadiness />);
        expect((await view.findAllByText('simulation')).length).toBeGreaterThan(0);
        fireEvent.click(await view.findByText('Run Experiment'));
        await waitFor(() => expect(view.getByText('Recommendation score 20.00')).toBeTruthy(), { timeout: 3000 });
        expect(view.getByText('ready for paper approval')).toBeTruthy();
        expect(view.getByText('Clean paper evidence exists')).toBeTruthy();
        expect(view.getByText('win')).toBeTruthy();
    });
});
