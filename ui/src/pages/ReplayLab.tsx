import { useEffect, useMemo, useState } from 'react';
import {
    AlertTriangle,
    BarChart3,
    CheckCircle2,
    Database,
    FileWarning,
    Play,
    RefreshCw,
    ShieldCheck,
    Square,
} from 'lucide-react';
import { useStore, type ExecutionRow } from '../store';
import { ExecutionBlotterPanel } from '../components/LiveMonitor/ExecutionBlotterPanel';
import { PriceChartPanel } from '../components/LiveMonitor/PriceChartPanel';
import { SessionSummaryPanel } from '../components/LiveMonitor/SessionSummaryPanel';

const API_BASE = 'http://127.0.0.1:3000/api/operator';

type ReplayFixture = {
    path: string;
    label: string;
    replayable: boolean;
    validationStatus: 'valid' | 'invalid' | 'unsupported';
    reason?: string;
    slug?: string;
    strategy?: string;
};

type ReplayActionState = 'idle' | 'loading' | 'starting' | 'stopping';

function basename(path: string | null | undefined) {
    if (!path) return 'None';
    return path.split(/[\\/]/).pop() || path;
}

function formatPct(value: number) {
    return `${Math.round(value)}%`;
}

function summarizeRows(rows: ExecutionRow[]) {
    return rows.reduce(
        (acc, row) => {
            if (row.kind === 'intent') acc.intents += 1;
            if (row.kind === 'risk' && row.status === 'allowed') acc.allowed += 1;
            if (row.kind === 'risk' && row.status === 'blocked') acc.blocked += 1;
            if (row.status === 'filled' || row.status === 'partial_filled') acc.filled += 1;
            if (row.status === 'failed' || row.status === 'canceled' || row.status === 'expired') acc.problems += 1;
            if (row.kind === 'settlement') acc.settlements += 1;
            return acc;
        },
        { intents: 0, allowed: 0, blocked: 0, filled: 0, problems: 0, settlements: 0 },
    );
}

function StatCard({ label, value, tone = 'slate' }: { label: string; value: string | number; tone?: 'slate' | 'emerald' | 'amber' | 'red' | 'blue' }) {
    const toneClass = {
        slate: 'text-slate-100',
        emerald: 'text-emerald-300',
        amber: 'text-amber-300',
        red: 'text-red-300',
        blue: 'text-blue-300',
    }[tone];

    return (
        <div className="bg-slate-900/50 border border-slate-700 rounded-lg px-4 py-3 min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">{label}</div>
            <div className={`text-2xl font-black truncate ${toneClass}`}>{value}</div>
        </div>
    );
}

export default function ReplayLab() {
    const isConnected = useStore(state => state.isConnected);
    const operatorStatus = useStore(state => state.operatorStatus);
    const replayProgress = useStore(state => state.replayProgress);
    const executionRows = useStore(state => state.executionRows);
    const sessionPnl = useStore(state => state.sessionPnl);
    const clearAllTelemetry = useStore(state => state.clearAllTelemetry);

    const [fixtures, setFixtures] = useState<ReplayFixture[]>([]);
    const [selectedReplay, setSelectedReplay] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [actionState, setActionState] = useState<ReplayActionState>('idle');

    const isRunning = operatorStatus?.sessionState === 'running' || operatorStatus?.sessionState === 'starting';
    const isStopping = operatorStatus?.sessionState === 'stopping';
    const isReplayRunning = isRunning && operatorStatus?.engineMode === 'replay';
    const selectedFixture = fixtures.find(fixture => fixture.path === selectedReplay);
    const validFixtures = fixtures.filter(fixture => fixture.replayable);
    const invalidFixtures = fixtures.length - validFixtures.length;

    const progressPct = replayProgress
        ? Math.min(100, Math.max(0, (replayProgress.processedEvents / Math.max(1, replayProgress.totalEvents)) * 100))
        : 0;

    const replaySummary = useMemo(() => summarizeRows(executionRows), [executionRows]);

    useEffect(() => {
        let cancelled = false;

        async function loadFixtures() {
            setActionState('loading');
            setError(null);
            try {
                const response = await fetch(`${API_BASE}/replay-fixtures`);
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Unable to load replay fixtures');
                if (!Array.isArray(data.files)) throw new Error('Replay fixture response was malformed');
                if (cancelled) return;

                const files = data.files as ReplayFixture[];
                setFixtures(files);
                const firstValid = files.find(fixture => fixture.replayable);
                setSelectedReplay(current => current || firstValid?.path || files[0]?.path || '');
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load replay fixtures');
            } finally {
                if (!cancelled) setActionState('idle');
            }
        }

        loadFixtures();
        return () => {
            cancelled = true;
        };
    }, []);

    async function refreshFixtures() {
        setActionState('loading');
        setError(null);
        try {
            const response = await fetch(`${API_BASE}/replay-fixtures`);
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Unable to refresh replay fixtures');
            const files = Array.isArray(data.files) ? data.files as ReplayFixture[] : [];
            setFixtures(files);
            if (!files.some(fixture => fixture.path === selectedReplay)) {
                const firstValid = files.find(fixture => fixture.replayable);
                setSelectedReplay(firstValid?.path || files[0]?.path || '');
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unable to refresh replay fixtures');
        } finally {
            setActionState('idle');
        }
    }

    async function startReplay() {
        if (!selectedFixture?.replayable) return;
        setActionState('starting');
        setError(null);
        clearAllTelemetry();

        try {
            const payload = {
                file: selectedFixture.path,
                ...(selectedFixture.strategy ? { strategy: selectedFixture.strategy } : {}),
            };
            const response = await fetch(`${API_BASE}/replay/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.error || 'Replay start failed');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Replay start failed');
        } finally {
            setActionState('idle');
        }
    }

    async function stopReplay() {
        setActionState('stopping');
        setError(null);
        try {
            const response = await fetch(`${API_BASE}/session/stop`, { method: 'POST' });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.error || 'Replay stop failed');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Replay stop failed');
        } finally {
            setActionState('idle');
        }
    }

    if (!isConnected) {
        return (
            <div className="p-8 max-w-4xl mx-auto">
                <div className="bg-red-900/20 border border-red-500/50 p-6 rounded-lg flex items-start gap-4">
                    <AlertTriangle className="w-8 h-8 text-red-500 flex-shrink-0" />
                    <div>
                        <h1 className="text-xl font-bold text-red-200 mb-2">Backend Unreachable</h1>
                        <p className="text-red-300/80">Start the trade engine in idle mode on port 3000 before using Replay Lab.</p>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="p-8 max-w-7xl mx-auto space-y-6">
            <header className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div>
                    <h1 className="text-3xl font-bold text-slate-100 flex items-center">
                        <BarChart3 className="w-8 h-8 mr-3 text-blue-400" />
                        Replay Lab
                    </h1>
                    <p className="text-slate-400 mt-2 text-lg">Validate strategy behavior against structured historical market logs</p>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 min-w-full xl:min-w-[560px]">
                    <StatCard label="Replayable" value={validFixtures.length} tone="emerald" />
                    <StatCard label="Rejected" value={invalidFixtures} tone={invalidFixtures > 0 ? 'amber' : 'slate'} />
                    <StatCard label="Progress" value={replayProgress ? formatPct(progressPct) : '---'} tone="blue" />
                    <StatCard label="Session PnL" value={sessionPnl ? `$${sessionPnl.pnl.toFixed(2)}` : '---'} tone={!sessionPnl ? 'slate' : sessionPnl.pnl >= 0 ? 'emerald' : 'red'} />
                </div>
            </header>

            {error && (
                <div className="bg-red-900/20 border border-red-500/40 rounded-lg p-4 flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                    <div className="text-sm text-red-200">{error}</div>
                </div>
            )}

            <section className="grid grid-cols-1 xl:grid-cols-[420px_minmax(0,1fr)] gap-6">
                <div className="bg-slate-800 border border-slate-700 rounded-lg p-5 space-y-5">
                    <div className="flex items-center justify-between gap-3">
                        <div>
                            <h2 className="text-lg font-semibold text-slate-100 flex items-center">
                                <Database className="w-5 h-5 mr-2 text-blue-400" />
                                Fixture Launcher
                            </h2>
                            <div className="text-xs text-slate-500 mt-1">{fixtures.length} logs scanned</div>
                        </div>
                        <button
                            type="button"
                            onClick={refreshFixtures}
                            disabled={actionState === 'loading' || isRunning || isStopping}
                            className="h-9 w-9 inline-flex items-center justify-center rounded border border-slate-700 bg-slate-900/70 text-slate-300 hover:text-slate-100 disabled:opacity-40"
                            title="Refresh fixtures"
                        >
                            <RefreshCw className={`w-4 h-4 ${actionState === 'loading' ? 'animate-spin' : ''}`} />
                        </button>
                    </div>

                    <label className="block space-y-2">
                        <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">Replay Fixture</span>
                        <select
                            className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-3 text-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                            value={selectedReplay}
                            onChange={event => setSelectedReplay(event.target.value)}
                            disabled={isRunning || isStopping || fixtures.length === 0}
                        >
                            {fixtures.map(fixture => (
                                <option key={fixture.path} value={fixture.path}>
                                    {fixture.replayable ? '' : '! '} {fixture.label}
                                </option>
                            ))}
                            {fixtures.length === 0 && <option value="">No fixtures found</option>}
                        </select>
                    </label>

                    {selectedFixture && (
                        <div className={`rounded-lg border p-4 ${selectedFixture.replayable ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-amber-500/10 border-amber-500/30'}`}>
                            <div className="flex items-start gap-3">
                                {selectedFixture.replayable ? (
                                    <CheckCircle2 className="w-5 h-5 text-emerald-300 flex-shrink-0 mt-0.5" />
                                ) : (
                                    <FileWarning className="w-5 h-5 text-amber-300 flex-shrink-0 mt-0.5" />
                                )}
                                <div className="min-w-0">
                                    <div className="text-sm font-bold text-slate-100 truncate">{selectedFixture.label}</div>
                                    <div className="text-xs text-slate-400 mt-1">
                                        {selectedFixture.replayable ? 'Structured market log ready for replay' : selectedFixture.reason || 'This log cannot be replayed'}
                                    </div>
                                    {selectedFixture.slug && <div className="text-xs text-slate-500 mt-2 font-mono truncate">{selectedFixture.slug}</div>}
                                    {selectedFixture.strategy && <div className="text-xs text-slate-500 mt-1 font-mono truncate">strategy: {selectedFixture.strategy}</div>}
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="grid grid-cols-2 gap-3">
                        <button
                            type="button"
                            onClick={startReplay}
                            disabled={isRunning || isStopping || actionState === 'starting' || !selectedFixture?.replayable || operatorStatus?.blockReason != null}
                            className="py-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-lg font-bold flex items-center justify-center"
                        >
                            <Play className="w-5 h-5 mr-2" />
                            Run Replay
                        </button>
                        <button
                            type="button"
                            onClick={stopReplay}
                            disabled={!isRunning || isStopping || actionState === 'stopping'}
                            className="py-3 bg-red-600 hover:bg-red-500 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-lg font-bold flex items-center justify-center"
                        >
                            <Square className="w-5 h-5 mr-2" />
                            Stop
                        </button>
                    </div>

                    <div className="bg-slate-900/50 border border-slate-700 rounded-lg p-4 space-y-3">
                        <div className="flex items-center justify-between text-xs">
                            <span className="text-slate-400">Active replay</span>
                            <span className={`font-bold uppercase ${isReplayRunning ? 'text-blue-300' : 'text-slate-500'}`}>
                                {isReplayRunning ? 'running' : operatorStatus?.sessionState || 'idle'}
                            </span>
                        </div>
                        <div className="text-sm text-slate-200 truncate">{basename(operatorStatus?.activeReplayFile || selectedReplay)}</div>
                        <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                            <div className="h-full bg-blue-500 rounded-full" style={{ width: `${progressPct}%` }} />
                        </div>
                        <div className="flex justify-between text-xs text-slate-500">
                            <span>{replayProgress ? `${replayProgress.processedEvents} / ${replayProgress.totalEvents}` : 'No progress yet'}</span>
                            <span>{replayProgress ? new Date(replayProgress.virtualTimeMs).toLocaleTimeString() : '--:--'}</span>
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 content-start">
                    <StatCard label="Intents" value={replaySummary.intents} tone="blue" />
                    <StatCard label="Allowed" value={replaySummary.allowed} tone="emerald" />
                    <StatCard label="Blocked" value={replaySummary.blocked} tone={replaySummary.blocked > 0 ? 'red' : 'slate'} />
                    <StatCard label="Fills" value={replaySummary.filled} tone="emerald" />
                    <StatCard label="Problems" value={replaySummary.problems} tone={replaySummary.problems > 0 ? 'amber' : 'slate'} />
                    <StatCard label="Settled" value={replaySummary.settlements} tone="blue" />

                    <div className="col-span-2 lg:col-span-6 bg-slate-800 border border-slate-700 rounded-lg p-5">
                        <h2 className="text-lg font-semibold text-slate-100 flex items-center mb-3">
                            <ShieldCheck className="w-5 h-5 mr-2 text-emerald-400" />
                            Validation Readout
                        </h2>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                            <div className="bg-slate-900/50 border border-slate-700 rounded-lg p-3">
                                <div className="text-slate-500 text-xs uppercase font-bold mb-1">Replay Gate</div>
                                <div className={selectedFixture?.replayable ? 'text-emerald-300' : 'text-amber-300'}>
                                    {selectedFixture?.replayable ? 'Fixture is structurally valid' : 'Select a replayable structured log'}
                                </div>
                            </div>
                            <div className="bg-slate-900/50 border border-slate-700 rounded-lg p-3">
                                <div className="text-slate-500 text-xs uppercase font-bold mb-1">Risk Signal</div>
                                <div className={replaySummary.blocked > 0 ? 'text-red-300' : replaySummary.allowed > 0 ? 'text-emerald-300' : 'text-slate-400'}>
                                    {replaySummary.blocked > 0 ? `${replaySummary.blocked} blocked decision(s)` : replaySummary.allowed > 0 ? 'Orders passed risk checks' : 'No risk decisions yet'}
                                </div>
                            </div>
                            <div className="bg-slate-900/50 border border-slate-700 rounded-lg p-3">
                                <div className="text-slate-500 text-xs uppercase font-bold mb-1">Outcome</div>
                                <div className={sessionPnl ? sessionPnl.pnl >= 0 ? 'text-emerald-300' : 'text-red-300' : 'text-slate-400'}>
                                    {sessionPnl ? `Replay closed at $${sessionPnl.pnl.toFixed(2)}` : 'Awaiting settlement telemetry'}
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="col-span-2 lg:col-span-6">
                        <PriceChartPanel />
                    </div>
                </div>
            </section>

            <section className="grid grid-cols-1 xl:grid-cols-[360px_minmax(0,1fr)] gap-6">
                <SessionSummaryPanel />
                <ExecutionBlotterPanel />
            </section>
        </div>
    );
}
