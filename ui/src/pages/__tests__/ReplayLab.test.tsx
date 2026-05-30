import '../../test/dom';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../store';

vi.mock('lightweight-charts', () => ({
    ColorType: { Solid: 'Solid' },
    LineSeries: 'LineSeries',
    LineStyle: { Dashed: 2 },
    createChart: () => ({
        addSeries: () => ({
            setData: vi.fn(),
            createPriceLine: vi.fn(),
            removePriceLine: vi.fn(),
        }),
        addLineSeries: () => ({
            setData: vi.fn(),
            createPriceLine: vi.fn(),
            removePriceLine: vi.fn(),
        }),
        applyOptions: vi.fn(),
        remove: vi.fn(),
    }),
}));

import ReplayLab from '../ReplayLab';

const fixture = {
    path: 'logs/early-bird-btc-updown-5m-1779294600.log',
    label: 'btc-updown-5m-1779294600 (late-entry)',
    replayable: true,
    validationStatus: 'valid',
    slug: 'btc-updown-5m-1779294600',
    strategy: 'late-entry',
};

describe('ReplayLab', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        useStore.setState({
            isConnected: true,
            operatorStatus: {
                backend: 'reachable',
                telemetry: 'connected',
                sessionState: 'idle',
                engineMode: 'idle',
                engineStatus: null,
                blockReason: null,
                activeReplayFile: null,
                activePreset: null,
            },
        });
    });

    afterEach(() => {
        cleanup();
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
        useStore.getState().clearAllTelemetry();
    });

    it('posts fixture strategy when starting an operator replay', async () => {
        const replayBodies: unknown[] = [];
        globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            const target = String(url);
            if (target.endsWith('/replay-fixtures')) {
                return Response.json({ files: [fixture] });
            }
            if (target.endsWith('/replay/start')) {
                replayBodies.push(JSON.parse(String(init?.body)));
                return Response.json({ success: true });
            }
            return Response.json({});
        }) as typeof fetch;

        const view = render(<ReplayLab />);

        expect((await view.findAllByText(fixture.label)).length).toBeGreaterThanOrEqual(1);
        expect(await view.findByText('strategy: late-entry')).toBeTruthy();

        fireEvent.click(view.getByText('Run Replay'));

        await waitFor(() => expect(replayBodies).toEqual([{ file: fixture.path, strategy: 'late-entry' }]));
    });
});
