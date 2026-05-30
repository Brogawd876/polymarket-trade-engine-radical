import { useMemo, useState } from 'react';
import { BarChart3, Filter, FileText, Search } from 'lucide-react';
import { useLogs } from '../hooks/useLogs';
import { useAnalyticsStore } from '../store/analytics';
import { uniqueStrategies } from '../utils/analytics/aggregate';
import { parseSlugInfo } from '../utils/analytics/parse';

export default function Analytics() {
    const allRuns = useLogs();
    const { asset, duration, strategy, setAsset, setDuration, setStrategy } = useAnalyticsStore();
    
    const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

    const runs = useMemo(
        () => allRuns.filter((r) => {
            const info = parseSlugInfo(r.slug);
            return info.asset === asset && info.duration === duration;
        }),
        [allRuns, asset, duration]
    );

    const strategies = useMemo(() => uniqueStrategies(runs), [runs]);

    const filteredRuns = useMemo(
        () => strategy === "All"
            ? runs
            : runs.filter((r) => r.strategy === strategy),
        [runs, strategy]
    );

    const decisionStats = useMemo(() => {
        const features = filteredRuns.flatMap(run => run.raw.filter(entry => entry.type === 'decision_feature').map(entry => entry.snapshot));
        const blocked = features.filter(snapshot => snapshot?.event === 'blocked').length;
        const placed = features.filter(snapshot => snapshot?.event === 'placed').length;
        const feedDisagreements = features.filter(snapshot => snapshot?.feeds?.predictiveDisagreement === true).length;
        const scored = features.filter(snapshot => typeof snapshot?.quant?.probabilityUp === 'number');
        const tradable = features.filter(snapshot => snapshot?.event === 'placed' || snapshot?.event === 'blocked');
        const avgProbability = scored.length > 0
            ? scored.reduce((sum, snapshot) => sum + (snapshot.quant.probabilityUp ?? 0), 0) / scored.length
            : null;
        const avgSpread = tradable.length > 0
            ? tradable.reduce((sum, snapshot) => sum + (snapshot?.orderbook?.spread ?? 0), 0) / tradable.length
            : null;
        const reasons = new Map<string, number>();
        for (const snapshot of features) {
            for (const reason of snapshot?.risk?.reasons ?? []) {
                if (reason === 'approved') continue;
                reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
            }
        }
        return {
            total: features.length,
            blocked,
            placed,
            feedDisagreements,
            avgProbability,
            avgSpread,
            topReasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
        };
    }, [filteredRuns]);

    return (
        <div className="p-6 h-full flex flex-col overflow-y-auto">
            <header className="mb-6 flex justify-between items-end">
                <div>
                    <h1 className="text-2xl font-bold text-slate-100 tracking-tight flex items-center gap-2">
                        <BarChart3 className="w-6 h-6 text-indigo-400" />
                        Run Analysis
                    </h1>
                    <p className="text-sm text-slate-400 mt-1">Historical performance and strategy backtest results</p>
                </div>

                <div className="flex gap-3">
                    <div className="flex bg-slate-800/50 rounded-lg p-1 border border-slate-700">
                        {['BTC', 'ETH', 'XRP', 'SOL', 'DOGE'].map((a) => (
                            <button
                                key={a}
                                onClick={() => setAsset(a as any /* eslint-disable-line @typescript-eslint/no-explicit-any */)}
                                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                                    asset === a 
                                    ? 'bg-indigo-500 text-white shadow-sm' 
                                    : 'text-slate-400 hover:text-slate-200'
                                }`}
                            >
                                {a}
                            </button>
                        ))}
                    </div>

                    <div className="flex bg-slate-800/50 rounded-lg p-1 border border-slate-700">
                        {['5m', '15m'].map((d) => (
                            <button
                                key={d}
                                onClick={() => setDuration(d as any /* eslint-disable-line @typescript-eslint/no-explicit-any */)}
                                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                                    duration === d 
                                    ? 'bg-indigo-500 text-white shadow-sm' 
                                    : 'text-slate-400 hover:text-slate-200'
                                }`}
                            >
                                {d}
                            </button>
                        ))}
                    </div>
                </div>
            </header>

            <div className="grid grid-cols-12 gap-6">
                {/* Filters & Stats Bar */}
                <div className="col-span-12 flex flex-wrap items-center gap-4 bg-slate-800/30 p-4 rounded-xl border border-slate-700/50">
                    <div className="flex items-center gap-2 text-slate-400 text-sm border-r border-slate-700 pr-4">
                        <Filter className="w-4 h-4" />
                        <span>Filters:</span>
                    </div>

                    <select 
                        value={strategy}
                        onChange={(e) => setStrategy(e.target.value)}
                        className="bg-slate-900 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-1.5 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                    >
                        <option value="All">All Strategies</option>
                        {strategies.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>

                    <div className="ml-auto flex items-center gap-6">
                        <div className="text-center">
                            <div className="text-xs text-slate-500 uppercase tracking-wider font-semibold">Total Runs</div>
                            <div className="text-xl font-bold text-slate-200">{filteredRuns.length}</div>
                        </div>
                        <div className="text-center">
                            <div className="text-xs text-slate-500 uppercase tracking-wider font-semibold">Win Rate</div>
                            <div className="text-xl font-bold text-emerald-400">
                                {filteredRuns.length > 0
                                    ? (() => {
                                        const completed = filteredRuns.filter(r => 
                                            r.outcome === 'win' || 
                                            r.outcome === 'loss' || 
                                            r.outcome === 'rebate' || 
                                            r.outcome === 'flat'
                                        );
                                        if (completed.length === 0) return '0.0%';
                                        const wins = filteredRuns.filter(r => r.outcome === 'win').length;
                                        return ((wins / completed.length) * 100).toFixed(1) + '%';
                                    })()
                                    : '---'}
                            </div>
                        </div>

                        <div className="text-center">
                            <div className="text-xs text-slate-500 uppercase tracking-wider font-semibold">Net PnL</div>
                            <div className={`text-xl font-bold ${
                                (filteredRuns.reduce((acc, r) => acc + (r.resolution?.pnl || 0), 0)) >= 0 
                                ? 'text-emerald-400' 
                                : 'text-red-400'
                            }`}>
                                ${filteredRuns.reduce((acc, r) => acc + (r.resolution?.pnl || 0), 0).toFixed(2)}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Main Charts Area */}
                <div className="col-span-12 lg:col-span-8 space-y-6">
                    <div className="bg-slate-800/40 rounded-xl border border-slate-700/50 p-6 min-h-[400px] flex items-center justify-center">
                         <div className="text-center">
                            <BarChart3 className="w-12 h-12 text-slate-700 mx-auto mb-4" />
                            <h3 className="text-slate-300 font-medium">Performance Charts</h3>
                            <p className="text-slate-500 text-sm max-w-xs mt-2">Charts from legacy analysis are being integrated with Tailwind & Lightweight Charts.</p>
                         </div>
                    </div>
                    <div className="bg-slate-800/40 rounded-xl border border-slate-700/50 p-5">
                        <div className="flex justify-between items-start mb-4">
                            <div>
                                <h2 className="text-sm font-semibold text-slate-300">Decision Features</h2>
                                <p className="text-xs text-slate-500 mt-1">Canonical strategy/risk snapshots captured during replay and paper sessions</p>
                            </div>
                            <span className="text-[10px] bg-slate-700 text-slate-300 px-2 py-0.5 rounded-full uppercase">
                                {decisionStats.total} snapshots
                            </span>
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                            <div className="bg-slate-900/50 border border-slate-700 rounded-lg p-3">
                                <div className="text-[10px] text-slate-500 uppercase font-bold">Placed</div>
                                <div className="text-xl font-black text-emerald-300">{decisionStats.placed}</div>
                            </div>
                            <div className="bg-slate-900/50 border border-slate-700 rounded-lg p-3">
                                <div className="text-[10px] text-slate-500 uppercase font-bold">Blocked</div>
                                <div className="text-xl font-black text-red-300">{decisionStats.blocked}</div>
                            </div>
                            <div className="bg-slate-900/50 border border-slate-700 rounded-lg p-3">
                                <div className="text-[10px] text-slate-500 uppercase font-bold">Feed Disagree</div>
                                <div className="text-xl font-black text-amber-300">{decisionStats.feedDisagreements}</div>
                            </div>
                            <div className="bg-slate-900/50 border border-slate-700 rounded-lg p-3">
                                <div className="text-[10px] text-slate-500 uppercase font-bold">Tradability</div>
                                <div className="text-xl font-black text-blue-300">{decisionStats.total ? Math.round((decisionStats.placed / decisionStats.total) * 100) : 0}%</div>
                            </div>
                            <div className="bg-slate-900/50 border border-slate-700 rounded-lg p-3">
                                <div className="text-[10px] text-slate-500 uppercase font-bold">Avg P(UP)</div>
                                <div className="text-xl font-black text-sky-300">{decisionStats.avgProbability == null ? '---' : `${Math.round(decisionStats.avgProbability * 100)}%`}</div>
                            </div>
                            <div className="bg-slate-900/50 border border-slate-700 rounded-lg p-3">
                                <div className="text-[10px] text-slate-500 uppercase font-bold">Avg Spread</div>
                                <div className="text-xl font-black text-indigo-300">{decisionStats.avgSpread == null ? '---' : `$${decisionStats.avgSpread.toFixed(3)}`}</div>
                            </div>
                        </div>
                        <div className="space-y-2">
                            {decisionStats.topReasons.length === 0 ? (
                                <div className="text-xs text-slate-500 italic">No blocked decision reasons captured yet.</div>
                            ) : decisionStats.topReasons.map(([reason, count]) => (
                                <div key={reason} className="flex justify-between gap-4 text-xs border-b border-slate-700/50 pb-2">
                                    <span className="text-slate-300">{reason}</span>
                                    <span className="text-slate-500 font-mono">{count}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Sidebar - Run List */}
                <div className="col-span-12 lg:col-span-4 space-y-6">
                    <div className="bg-slate-800/40 rounded-xl border border-slate-700/50 flex flex-col h-[600px]">
                        <div className="p-4 border-b border-slate-700 flex justify-between items-center">
                            <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
                                <FileText className="w-4 h-4 text-indigo-400" />
                                Historical Runs
                            </h2>
                            <span className="text-[10px] bg-slate-700 text-slate-300 px-2 py-0.5 rounded-full uppercase tracking-tighter">
                                {filteredRuns.length} items
                            </span>
                        </div>
                        <div className="overflow-y-auto flex-1 p-2 space-y-1">
                            {filteredRuns.length === 0 ? (
                                <div className="h-full flex flex-col items-center justify-center p-8 text-center">
                                    <Search className="w-8 h-8 text-slate-700 mb-2" />
                                    <p className="text-slate-500 text-xs italic">No logs found matching filters</p>
                                </div>
                            ) : (
                                filteredRuns.map((run) => (
                                    <button
                                        key={run.filename}
                                        onClick={() => setSelectedSlug(run.slug)}
                                        className={`w-full text-left p-3 rounded-lg transition-all group ${
                                            selectedSlug === run.slug 
                                            ? 'bg-indigo-500/10 border border-indigo-500/30' 
                                            : 'hover:bg-slate-700/30 border border-transparent'
                                        }`}
                                    >
                                        <div className="flex justify-between items-start mb-1">
                                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                                                run.outcome === 'win' ? 'bg-emerald-500/20 text-emerald-400' :
                                                run.outcome === 'loss' ? 'bg-red-500/20 text-red-400' :
                                                run.outcome === 'rebate' ? 'bg-blue-500/20 text-blue-400' :
                                                'bg-slate-700 text-slate-400'
                                            }`}>
                                                {run.outcome.toUpperCase()}
                                            </span>
                                            <span className="text-[10px] text-slate-500 font-mono">
                                                {new Date(run.startTime).toLocaleDateString()} {new Date(run.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </span>
                                        </div>
                                        <div className="text-xs font-medium text-slate-200 truncate">{run.slug}</div>
                                        <div className="flex justify-between items-center mt-2">
                                            <span className="text-[10px] text-slate-500 font-mono uppercase">{run.strategy}</span>
                                            <span className={`text-xs font-bold ${
                                                (run.resolution?.pnl || 0) >= 0 ? 'text-emerald-500' : 'text-red-500'
                                            }`}>
                                                {run.resolution ? `${(run.resolution.pnl >= 0 ? '+' : '')}${run.resolution.pnl.toFixed(2)}` : '---'}
                                            </span>
                                        </div>
                                    </button>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
