import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, BarChart3, Play, RefreshCw, Square } from 'lucide-react';
import { useStore } from '../store';

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

type BatchState = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
type Verdict = 'win' | 'loss' | 'flat' | 'no_trade' | 'blocked' | 'failed';

type BatchRun = {
    id: string;
    strategy: string;
    baseStrategy?: string;
    variantLabel?: string;
    paperEligible?: boolean;
    file: string;
    slug: string | null;
    status: RunStatus;
    pnl: number | null;
    direction: 'UP' | 'DOWN' | null;
    openPrice: number | null;
    closePrice: number | null;
    counts: {
        intents: number;
        allowed: number;
        blocked: number;
        fills: number;
        problems: number;
        settlements: number;
    };
    verdict: Verdict | null;
    brierScore: number | null;
    logLoss: number | null;
    execution?: ExecutionQualitySummary;
    error?: string;
};

type ExecutionQualitySummary = {
    fillRate: number | null;
    cancelRate: number | null;
    takerFeeSpend: number;
    makerRebateEstimate: number;
    grossEdgeCapture: number | null;
    turnover: number;
    maxDrawdown: number;
    markouts: {
        oneSecond: number | null;
        fiveSecond: number | null;
        thirtySecond: number | null;
        settlement: number | null;
    };
    conservativeFill: {
        conservativeFillEvidenceAvailable: boolean;
        conservativeFillEvidenceSource: "raw_l2_event_store" | "unavailable";
        conservativeFillVerdictCounts: Record<string, number>;
        conservativeFillUnavailableReasons: Record<string, number>;
        conservativeMarkout1sAvg: number | null;
        conservativeMarkout5sAvg: number | null;
        conservativeMarkout30sAvg: number | null;
        conservativeAdverseSelectionRate: number | null;
        usableEvidenceCount: number;
        evaluatedFillCount: number;
        eligibleFillCount: number;
        conservativeFillWarning?: string;
    };
};

type StrategyVariant = {
    id: string;
    label: string;
    strategy: string;
    description: string;
    config: Record<string, unknown>;
    paperEligible: boolean;
};

type StrategyRank = {
    strategy: string;
    baseStrategy: string;
    label: string;
    paperEligible?: boolean;
    runs: number;
    completed: number;
    failed: number;
    canceled: number;
    wins: number;
    losses: number;
    noTrades: number;
    tradeCount: number;
    winRate: number | null;
    tradeRate: number | null;
    totalPnl: number;
    avgPnl: number | null;
    bestPnl: number | null;
    worstPnl: number | null;
    blocked: number;
    problems: number;
    brierScore: number | null;
    logLoss: number | null;
    avgFillRate?: number | null;
    avgCancelRate?: number | null;
    avgSettlementMarkout?: number | null;
    avgTurnover?: number | null;
    conservativeFill?: {
        noFillCount: number;
        touchOnlyCount: number;
        probableFillCount: number;
        tradeThroughFillCount: number;
        unknownInsufficientDataCount: number;
        usableEvidenceRate: number | null;
        usableEvidenceCount: number;
        evaluatedFillCount: number;
        eligibleFillCount: number;
        avgMarkout1s: number | null;
        avgMarkout5s: number | null;
        avgMarkout30s: number | null;
        adverseSelectionRate: number | null;
    };
    score: number;
    };
type StrategyRecommendation = {
    strategy: string;
    label: string;
    score: number;
    readyForPaper: boolean;
    rationale: string[];
} | null;

type BatchSummary = {
    totalRuns: number;
    completed: number;
    failed: number;
    canceled: number;
    winRate: number | null;
    totalPnl: number;
    avgPnl: number | null;
    bestPnl: number | null;
    worstPnl: number | null;
    blocked: number;
    problems: number;
    byStrategy?: StrategyRank[];
    recommendation?: StrategyRecommendation;
};

type StrategyBatch = {
    id: string;
    state: BatchState;
    progress: {
        totalRuns: number;
        completedRuns: number;
    };
    runs: BatchRun[];
    summary: BatchSummary;
    error?: string;
};

type VerdictFilter = 'all' | Verdict;

function money(value: number | null | undefined) {
    if (value == null) return '---';
    return `${value >= 0 ? '$' : '-$'}${Math.abs(value).toFixed(2)}`;
}

function percent(value: number | null | undefined) {
    if (value == null) return '---';
    return `${Math.round(value * 100)}%`;
}

function basename(path: string) {
    return path.split(/[\\/]/).pop() || path;
}

function statusClass(status: RunStatus | BatchState) {
    if (status === 'completed') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
    if (status === 'failed') return 'bg-red-500/15 text-red-300 border-red-500/30';
    if (status === 'canceled') return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    if (status === 'running') return 'bg-blue-500/15 text-blue-300 border-blue-500/30';
    return 'bg-slate-700/70 text-slate-300 border-slate-600';
}

function verdictClass(verdict: Verdict | null) {
    if (verdict === 'win') return 'text-emerald-300';
    if (verdict === 'loss' || verdict === 'failed' || verdict === 'blocked') return 'text-red-300';
    if (verdict === 'no_trade') return 'text-amber-300';
    return 'text-slate-300';
}

function SummaryCard({ label, value, tone = 'slate' }: { label: string; value: string | number; tone?: 'slate' | 'emerald' | 'red' | 'amber' | 'blue' }) {
    const toneClass = {
        slate: 'text-slate-100',
        emerald: 'text-emerald-300',
        red: 'text-red-300',
        amber: 'text-amber-300',
        blue: 'text-blue-300',
    }[tone];

    return (
        <div className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1">{label}</div>
            <div className={`text-2xl font-black truncate ${toneClass}`}>{value}</div>
        </div>
    );
}

function getEvidenceLabel(run: BatchRun): string {
    const cFill = run.execution?.conservativeFill;
    if (!cFill || !cFill.conservativeFillEvidenceAvailable) return 'Unavailable';
    if (cFill.conservativeFillWarning) return 'Unavailable';
    if (cFill.evaluatedFillCount === 0) return 'Raw L2 present, not evaluable';
    if (cFill.usableEvidenceCount === 0) return 'No usable evidence';
    if ((cFill.conservativeFillVerdictCounts?.trade_through_fill ?? 0) > 0) return 'Trade-through';
    if ((cFill.conservativeFillVerdictCounts?.probable_fill ?? 0) > 0) return 'Probable';
    if ((cFill.conservativeFillVerdictCounts?.touch_only ?? 0) > 0) return 'Touch-only';
    return 'Unknown';
}

function getEvidenceTitle(run: BatchRun): string {
    const cFill = run.execution?.conservativeFill;
    if (!cFill) return '';
    const parts = [`Source: ${cFill.conservativeFillEvidenceSource}`];
    parts.push(`Eligible: ${cFill.eligibleFillCount}`);
    parts.push(`Evaluated: ${cFill.evaluatedFillCount}`);
    parts.push(`Usable: ${cFill.usableEvidenceCount}`);
    parts.push(`Unknown/Insufficient: ${cFill.conservativeFillVerdictCounts?.unknown_insufficient_data ?? 0}`);
    if (cFill.conservativeFillWarning) parts.push(`Warning: ${cFill.conservativeFillWarning}`);
    if (cFill.conservativeFillUnavailableReasons && Object.keys(cFill.conservativeFillUnavailableReasons).length > 0) {
        const reasons = Object.entries(cFill.conservativeFillUnavailableReasons).map(([k, v]) => `${k}:${v}`).join(', ');
        parts.push(`Unavailable Reasons: ${reasons}`);
    }
    return parts.join(' | ');
}

export default function StrategyLab() {
    const isConnected = useStore(state => state.isConnected);
    const [variants, setVariants] = useState<StrategyVariant[]>([]);
    const [fixtures, setFixtures] = useState<ReplayFixture[]>([]);
    const [selectedStrategies, setSelectedStrategies] = useState<string[]>([]);
    const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
    const [batch, setBatch] = useState<StrategyBatch | null>(null);
    const [strategyFilter, setStrategyFilter] = useState('all');
    const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>('all');
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const replayableFixtures = useMemo(() => fixtures.filter(fixture => fixture.replayable), [fixtures]);
    const isBatchActive = batch?.state === 'queued' || batch?.state === 'running';
    const progressPct = batch ? Math.round((batch.progress.completedRuns / Math.max(1, batch.progress.totalRuns)) * 100) : 0;

    const filteredRuns = useMemo(() => {
        return [...(batch?.runs ?? [])]
            .filter(run => strategyFilter === 'all' || run.strategy === strategyFilter)
            .filter(run => verdictFilter === 'all' || run.verdict === verdictFilter)
            .sort((a, b) => (b.pnl ?? Number.NEGATIVE_INFINITY) - (a.pnl ?? Number.NEGATIVE_INFINITY));
    }, [batch?.runs, strategyFilter, verdictFilter]);

    useEffect(() => {
        void loadInputs();
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, []);

    async function loadInputs() {
        setIsLoading(true);
        setError(null);
        try {
            const [strategyResponse, fixtureResponse] = await Promise.all([
                fetch(`${API_BASE}/strategy-lab/strategies`),
                fetch(`${API_BASE}/replay-fixtures`),
            ]);
            const strategyData = await strategyResponse.json();
            const fixtureData = await fixtureResponse.json();
            if (!strategyResponse.ok) throw new Error(strategyData.error || 'Unable to load strategies');
            if (!fixtureResponse.ok) throw new Error(fixtureData.error || 'Unable to load replay fixtures');

            const loadedStrategies = Array.isArray(strategyData.strategies) ? strategyData.strategies as string[] : [];
            const loadedVariants = Array.isArray(strategyData.variants)
                ? strategyData.variants as StrategyVariant[]
                : loadedStrategies.map(strategy => ({
                    id: strategy,
                    label: strategy,
                    strategy,
                    description: '',
                    config: {},
                    paperEligible: strategy === 'simulation',
                }));
            const loadedFixtures = Array.isArray(fixtureData.files) ? fixtureData.files as ReplayFixture[] : [];
            const validFiles = loadedFixtures.filter(fixture => fixture.replayable).slice(0, 3).map(fixture => fixture.path);

            setVariants(loadedVariants);
            setFixtures(loadedFixtures);
            setSelectedStrategies(current => current.length > 0 ? current : loadedVariants.map(variant => variant.id));
            setSelectedFiles(current => current.length > 0 ? current : validFiles);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unable to load Strategy Lab inputs');
        } finally {
            setIsLoading(false);
        }
    }

    function toggleValue(value: string, current: string[], setter: (next: string[]) => void) {
        setter(current.includes(value) ? current.filter(item => item !== value) : [...current, value]);
    }

    async function runBatch() {
        setIsLoading(true);
        setError(null);
        setBatch(null);
        try {
            const response = await fetch(`${API_BASE}/strategy-lab/batches`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ variants: selectedStrategies, files: selectedFiles }),
            });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.error || 'Strategy Lab batch failed to start');
            setBatch(data.batch);
            startPolling(data.batchId);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Strategy Lab batch failed to start');
        } finally {
            setIsLoading(false);
        }
    }

    function startPolling(batchId: string) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = setInterval(async () => {
            try {
                const response = await fetch(`${API_BASE}/strategy-lab/batches/${batchId}`);
                const data = await response.json();
                if (!response.ok || !data.success) throw new Error(data.error || 'Unable to poll batch');
                setBatch(data.batch);
                if (!['queued', 'running'].includes(data.batch.state)) {
                    if (pollRef.current) clearInterval(pollRef.current);
                    pollRef.current = null;
                }
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Unable to poll Strategy Lab batch');
                if (pollRef.current) clearInterval(pollRef.current);
                pollRef.current = null;
            }
        }, 750);
    }

    async function cancelBatch() {
        if (!batch) return;
        setError(null);
        try {
            const response = await fetch(`${API_BASE}/strategy-lab/batches/${batch.id}/cancel`, { method: 'POST' });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.error || 'Unable to cancel batch');
            setBatch(data.batch);
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unable to cancel batch');
        }
    }

    if (!isConnected) {
        return (
            <div className="p-8 max-w-4xl mx-auto">
                <div className="bg-red-900/20 border border-red-500/50 p-6 rounded-lg flex items-start gap-4">
                    <AlertTriangle className="w-8 h-8 text-red-500 flex-shrink-0" />
                    <div>
                        <h1 className="text-xl font-bold text-red-200 mb-2">Backend Unreachable</h1>
                        <p className="text-red-300/80">Start the trade engine in idle mode on port 3000 before using Strategy Lab.</p>
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
                        <BarChart3 className="w-8 h-8 mr-3 text-emerald-400" />
                        Strategy Lab
                    </h1>
                    <p className="text-slate-400 mt-2 text-lg">Batch compare strategies across replayable BTC 5-minute fixtures</p>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 min-w-full xl:min-w-[640px]">
                    <SummaryCard label="Runs" value={batch?.summary.totalRuns ?? selectedStrategies.length * selectedFiles.length} tone="blue" />
                    <SummaryCard label="Win Rate" value={percent(batch?.summary.winRate)} tone="emerald" />
                    <SummaryCard label="Total PnL" value={money(batch?.summary.totalPnl)} tone={(batch?.summary.totalPnl ?? 0) >= 0 ? 'emerald' : 'red'} />
                    <SummaryCard label="Progress" value={batch ? `${progressPct}%` : '---'} tone="blue" />
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
                            <h2 className="text-lg font-semibold text-slate-100">Batch Setup</h2>
                            <div className="text-xs text-slate-500 mt-1">{replayableFixtures.length} replayable fixtures available</div>
                        </div>
                        <button
                            type="button"
                            onClick={loadInputs}
                            disabled={isLoading || isBatchActive}
                            className="h-9 w-9 inline-flex items-center justify-center rounded border border-slate-700 bg-slate-900/70 text-slate-300 hover:text-slate-100 disabled:opacity-40"
                            title="Refresh inputs"
                        >
                            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
                        </button>
                    </div>

                    <fieldset className="space-y-2">
                        <legend className="text-xs font-bold text-slate-500 uppercase tracking-wider">Strategy Variants</legend>
                        <div className="grid grid-cols-1 gap-2">
                            {variants.map(variant => (
                                <label key={variant.id} className="flex items-start gap-2 bg-slate-900/50 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200">
                                    <input
                                        type="checkbox"
                                        className="mt-1"
                                        checked={selectedStrategies.includes(variant.id)}
                                        onChange={() => toggleValue(variant.id, selectedStrategies, setSelectedStrategies)}
                                        disabled={isBatchActive}
                                    />
                                    <span className="min-w-0">
                                        <span className="block font-semibold">{variant.label}</span>
                                        <span className="block text-xs text-slate-500">{variant.description}</span>
                                    </span>
                                </label>
                            ))}
                        </div>
                    </fieldset>

                    <fieldset className="space-y-2">
                        <legend className="text-xs font-bold text-slate-500 uppercase tracking-wider">Replay Fixtures</legend>
                        <div className="max-h-72 overflow-auto border border-slate-700 rounded-lg divide-y divide-slate-700">
                            {replayableFixtures.map(fixture => (
                                <label key={fixture.path} className="flex items-start gap-2 bg-slate-900/40 px-3 py-2 text-sm text-slate-200">
                                    <input
                                        type="checkbox"
                                        className="mt-1"
                                        checked={selectedFiles.includes(fixture.path)}
                                        onChange={() => toggleValue(fixture.path, selectedFiles, setSelectedFiles)}
                                        disabled={isBatchActive}
                                    />
                                    <span className="min-w-0">
                                        <span className="block truncate font-medium">{fixture.label}</span>
                                        <span className="block truncate text-xs text-slate-500 font-mono">{fixture.slug ?? basename(fixture.path)}</span>
                                    </span>
                                </label>
                            ))}
                        </div>
                    </fieldset>

                    <div className="grid grid-cols-2 gap-3">
                        <button
                            type="button"
                            onClick={runBatch}
                            disabled={isLoading || isBatchActive || selectedStrategies.length === 0 || selectedFiles.length === 0}
                            className="py-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-lg font-bold flex items-center justify-center"
                        >
                            <Play className="w-5 h-5 mr-2" />
                            Run Batch
                        </button>
                        <button
                            type="button"
                            onClick={cancelBatch}
                            disabled={!isBatchActive}
                            className="py-3 bg-red-600 hover:bg-red-500 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-lg font-bold flex items-center justify-center"
                        >
                            <Square className="w-5 h-5 mr-2" />
                            Cancel
                        </button>
                    </div>

                    <div className="bg-slate-900/50 border border-slate-700 rounded-lg p-4 space-y-3">
                        <div className="flex items-center justify-between text-xs">
                            <span className="text-slate-400">Batch State</span>
                            <span className={`px-2 py-0.5 rounded border font-bold uppercase ${statusClass(batch?.state ?? 'queued')}`}>
                                {batch?.state ?? 'not started'}
                            </span>
                        </div>
                        <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                            <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${progressPct}%` }} />
                        </div>
                        <div className="flex justify-between text-xs text-slate-500">
                            <span>{batch ? `${batch.progress.completedRuns} / ${batch.progress.totalRuns}` : 'No batch run yet'}</span>
                            <span>{selectedStrategies.length * selectedFiles.length} selected run(s)</span>
                        </div>
                    </div>
                </div>

                <div className="space-y-4">
                    {batch?.summary.recommendation && (
                        <div className="bg-slate-800 border border-slate-700 rounded-lg p-4">
                            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                                <div>
                                    <div className="text-xs font-bold text-slate-500 uppercase tracking-wider">Recommendation</div>
                                    <h2 className="text-xl font-bold text-slate-100 mt-1">{batch.summary.recommendation.label}</h2>
                                    <div className={`mt-2 inline-flex rounded border px-2 py-1 text-xs font-bold uppercase ${batch.summary.recommendation.readyForPaper ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300' : 'border-amber-500/40 bg-amber-500/15 text-amber-300'}`}>
                                        {batch.summary.recommendation.readyForPaper ? 'paper candidate' : 'keep tuning'}
                                    </div>
                                </div>
                                <div className="text-right">
                                    <div className="text-xs text-slate-500 uppercase font-bold tracking-wider">Score</div>
                                    <div className="text-2xl font-black text-blue-300">{batch.summary.recommendation.score.toFixed(2)}</div>
                                </div>
                            </div>
                            <div className="mt-4 grid gap-2 text-sm text-slate-300">
                                {batch.summary.recommendation.rationale.map(item => (
                                    <div key={item} className="border-l-2 border-slate-600 pl-3">{item}</div>
                                ))}
                            </div>
                        </div>
                    )}

                    {(batch?.summary.byStrategy?.length ?? 0) > 0 && (
                        <div className="bg-slate-800 border border-slate-700 rounded-lg p-4">
                            <h2 className="text-lg font-semibold text-slate-100 mb-3">Variant Ranking</h2>
                            <div className="overflow-x-auto">
                                <table className="w-full text-xs">
                                    <thead className="text-slate-500 uppercase">
                                        <tr className="border-b border-slate-700">
                                            <th className="text-left py-2 pr-3">Variant</th>
                                            <th className="text-right py-2 pr-3">Score</th>
                                            <th className="text-right py-2 pr-3">PnL</th>
                                            <th className="text-right py-2 pr-3">Win</th>
                                            <th className="text-right py-2 pr-3">Brier</th>
                                            <th className="text-right py-2 pr-3">LogLoss</th>
                                            <th className="text-right py-2 pr-3">Fill</th>
                                            <th className="text-right py-2 pr-3">Fill Evidence</th>
                                            <th className="text-right py-2 pr-3">Markout</th>
                                            <th className="text-right py-2 pr-3">Trade</th>
                                            <th className="text-right py-2 pr-3">Problems</th>
                                        </tr>
                                        </thead>
                                        <tbody>
                                        {batch!.summary.byStrategy!.map(rank => (
                                            <tr key={rank.strategy} className="border-b border-slate-700/50">
                                                <td className="py-2 pr-3 text-slate-200 font-semibold">{rank.label}</td>
                                                <td className="py-2 pr-3 text-right font-mono text-blue-300">{rank.score.toFixed(2)}</td>
                                                <td className={`py-2 pr-3 text-right font-mono ${rank.totalPnl >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{money(rank.totalPnl)}</td>
                                                <td className="py-2 pr-3 text-right font-mono text-slate-300">{percent(rank.winRate)}</td>
                                                <td className="py-2 pr-3 text-right font-mono text-sky-300">{rank.brierScore?.toFixed(4) ?? '---'}</td>
                                                <td className="py-2 pr-3 text-right font-mono text-sky-400">{rank.logLoss?.toFixed(4) ?? '---'}</td>
                                                <td className="py-2 pr-3 text-right font-mono text-slate-300">{percent(rank.avgFillRate)}</td>
                                                <td className="py-2 pr-3 text-right font-mono text-amber-300" title={`Evidence Available: ${percent(rank.conservativeFill?.usableEvidenceRate)}. Trade-thru: ${rank.conservativeFill?.tradeThroughFillCount}, Probable: ${rank.conservativeFill?.probableFillCount}, Touch: ${rank.conservativeFill?.touchOnlyCount}, No-fill: ${rank.conservativeFill?.noFillCount}`}>
                                                    {rank.conservativeFill?.usableEvidenceCount != null && rank.conservativeFill?.evaluatedFillCount != null ? `Usable ${rank.conservativeFill.usableEvidenceCount}/${rank.conservativeFill.evaluatedFillCount}` : '---'}
                                                </td>
                                                <td className={`py-2 pr-3 text-right font-mono ${(rank.avgSettlementMarkout ?? 0) >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{money(rank.avgSettlementMarkout)}</td>
                                                <td className="py-2 pr-3 text-right font-mono text-slate-300">{percent(rank.tradeRate)}</td>
                                                <td className="py-2 pr-3 text-right font-mono text-slate-300">{rank.problems}</td>
                                            </tr>
                                        ))}

                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <SummaryCard label="Completed" value={batch?.summary.completed ?? 0} tone="emerald" />
                        <SummaryCard label="Avg PnL" value={money(batch?.summary.avgPnl)} tone={(batch?.summary.avgPnl ?? 0) >= 0 ? 'emerald' : 'red'} />
                        <SummaryCard label="Best" value={money(batch?.summary.bestPnl)} tone="emerald" />
                        <SummaryCard label="Worst" value={money(batch?.summary.worstPnl)} tone={(batch?.summary.worstPnl ?? 0) < 0 ? 'red' : 'slate'} />
                        <SummaryCard label="Blocked" value={batch?.summary.blocked ?? 0} tone={(batch?.summary.blocked ?? 0) > 0 ? 'red' : 'slate'} />
                        <SummaryCard label="Problems" value={batch?.summary.problems ?? 0} tone={(batch?.summary.problems ?? 0) > 0 ? 'amber' : 'slate'} />
                        <SummaryCard label="Failed" value={batch?.summary.failed ?? 0} tone={(batch?.summary.failed ?? 0) > 0 ? 'red' : 'slate'} />
                        <SummaryCard label="Canceled" value={batch?.summary.canceled ?? 0} tone={(batch?.summary.canceled ?? 0) > 0 ? 'amber' : 'slate'} />
                    </div>

                    <div className="bg-slate-800 border border-slate-700 rounded-lg p-4">
                        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-4">
                            <h2 className="text-lg font-semibold text-slate-100">Batch Results</h2>
                            <div className="flex flex-wrap gap-2">
                                <select className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-200" value={strategyFilter} onChange={event => setStrategyFilter(event.target.value)}>
                                    <option value="all">All strategies</option>
                                    {variants.map(variant => <option key={variant.id} value={variant.id}>{variant.label}</option>)}
                                </select>
                                <select className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-sm text-slate-200" value={verdictFilter} onChange={event => setVerdictFilter(event.target.value as VerdictFilter)}>
                                    <option value="all">All verdicts</option>
                                    <option value="win">Win</option>
                                    <option value="loss">Loss</option>
                                    <option value="flat">Flat</option>
                                    <option value="no_trade">No trade</option>
                                    <option value="blocked">Blocked</option>
                                    <option value="failed">Failed</option>
                                </select>
                            </div>
                        </div>

                        {filteredRuns.length > 0 ? (
                            <div className="overflow-x-auto">
                                <table className="w-full text-xs">
                                    <thead className="text-slate-500 uppercase">
                                        <tr className="border-b border-slate-700">
                                            <th className="text-left py-2 pr-3">Strategy</th>
                                            <th className="text-left py-2 pr-3">Fixture</th>
                                            <th className="text-left py-2 pr-3">Status</th>
                                            <th className="text-left py-2 pr-3">Verdict</th>
                                            <th className="text-right py-2 pr-3">PnL</th>
                                            <th className="text-right py-2 pr-3">Brier</th>
                                            <th className="text-right py-2 pr-3">Fill Evidence</th>
                                            <th className="text-right py-2 pr-3">Markout</th>
                                            <th className="text-right py-2 pr-3">Fills</th>
                                            <th className="text-right py-2 pr-3">Blocked</th>
                                            <th className="text-right py-2 pr-3">Problems</th>
                                            <th className="text-left py-2">Resolution</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filteredRuns.map(run => (
                                            <tr key={run.id} className="border-b border-slate-700/50 align-top">
                                                <td className="py-2 pr-3 font-semibold text-slate-200">{run.variantLabel ?? run.strategy}</td>
                                                <td className="py-2 pr-3 text-slate-300 max-w-64">
                                                    <div className="truncate">{run.slug ?? basename(run.file)}</div>
                                                    {run.error && <div className="text-red-300 mt-1">{run.error}</div>}
                                                </td>
                                                <td className="py-2 pr-3">
                                                    <span className={`inline-flex px-2 py-0.5 rounded border font-semibold uppercase ${statusClass(run.status)}`}>{run.status}</span>
                                                </td>
                                                <td className={`py-2 pr-3 font-bold uppercase ${verdictClass(run.verdict)}`}>{run.verdict ?? '---'}</td>
                                                <td className={`py-2 pr-3 text-right font-mono ${(run.pnl ?? 0) >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{money(run.pnl)}</td>
                                                <td className="py-2 pr-3 text-right font-mono text-sky-300">{run.brierScore?.toFixed(4) ?? '---'}</td>
                                                <td className="py-2 pr-3 text-right font-mono text-amber-300" title={getEvidenceTitle(run)}>
                                                    {getEvidenceLabel(run)}
                                                </td>
                                                <td className={`py-2 pr-3 text-right font-mono ${(run.execution?.markouts.settlement ?? 0) >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{money(run.execution?.markouts.settlement)}</td>
                                                <td className="py-2 pr-3 text-right font-mono text-slate-300">{run.counts.fills}</td>
                                                <td className="py-2 pr-3 text-right font-mono text-slate-300">{run.counts.blocked}</td>
                                                <td className="py-2 pr-3 text-right font-mono text-slate-300">{run.counts.problems}</td>
                                                <td className="py-2 text-slate-400">
                                                    {run.direction && run.openPrice != null && run.closePrice != null
                                                        ? `${run.direction}: $${run.openPrice.toFixed(2)} -> $${run.closePrice.toFixed(2)}`
                                                        : '---'}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        ) : (
                            <div className="min-h-64 flex items-center justify-center text-slate-500 italic">
                                Run a batch to compare strategy outcomes.
                            </div>
                        )}
                    </div>
                </div>
            </section>
        </div>
    );
}
