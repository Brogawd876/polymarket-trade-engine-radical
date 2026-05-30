import { useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { useStore, type ExecutionRow, type ExecutionRowStatus } from '../../store';

type Filter = 'all' | 'open' | 'filled' | 'blocked' | 'problem';

const FILTERS: Array<{ id: Filter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'open', label: 'Open' },
    { id: 'filled', label: 'Filled' },
    { id: 'blocked', label: 'Blocked' },
    { id: 'problem', label: 'Failed / Canceled' },
];

function formatTime(ts: number) {
    return new Date(ts).toLocaleTimeString();
}

function formatPrice(value: number | undefined) {
    return value == null ? '---' : value.toFixed(value > 1 ? 2 : 3);
}

function formatShares(value: number | undefined) {
    return value == null ? '---' : value.toFixed(4).replace(/\.?0+$/, '');
}

function statusLabel(status: ExecutionRowStatus) {
    return status.replace('_', ' ').toUpperCase();
}

function statusClass(status: ExecutionRowStatus) {
    if (status === 'blocked' || status === 'failed') return 'bg-red-500/15 text-red-300 border-red-500/30';     
    if (status === 'filled' || status === 'partial_filled' || status === 'resolved') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
    if (status === 'placed' || status === 'allowed') return 'bg-blue-500/15 text-blue-300 border-blue-500/30';  
    if (status === 'expired' || status === 'canceled') return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    return 'bg-slate-700/70 text-slate-300 border-slate-600';
}

// eslint-disable-next-line react-refresh/only-export-components
export function matchesExecutionFilter(row: ExecutionRow, filter: Filter) {
    switch (filter) {
        case 'open':
            return row.status === 'attempted' || row.status === 'allowed' || row.status === 'placed';
        case 'filled':
            return row.status === 'filled' || row.status === 'partial_filled' || row.status === 'settled' || row.status === 'resolved';
        case 'blocked':
            return row.status === 'blocked';
        case 'problem':
            return row.status === 'failed' || row.status === 'canceled' || row.status === 'expired';
        default:
            return true;
    }
}

export function ExecutionBlotterPanel() {
    const executionRows = useStore(state => state.executionRows);
    const clearEvents = useStore(state => state.clearEvents);
    const [filter, setFilter] = useState<Filter>('all');
    const [expandedId, setExpandedId] = useState<string | null>(null);

    const visibleRows = useMemo(
        () => executionRows.filter(row => matchesExecutionFilter(row, filter)).slice(0, 80),
        [executionRows, filter],
    );

    return (
        <div className="bg-slate-800 p-4 rounded-lg border border-slate-700 flex flex-col min-h-80">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
                <div className="flex items-center gap-4">
                    <h2 className="text-lg font-semibold text-slate-200">Execution Blotter</h2>
                    <button
                        onClick={clearEvents}
                        title="Clear blotter"
                        className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-400/10 rounded transition-all"
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                </div>
                <div className="flex flex-wrap gap-2">
                    {FILTERS.map(item => (
                        <button
                            key={item.id}
                            type="button"
                            onClick={() => setFilter(item.id)}
                            className={`text-xs px-2 py-1 rounded border ${filter === item.id ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' : 'bg-slate-900/40 text-slate-400 border-slate-700 hover:text-slate-200'}`}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>
            </div>

            {visibleRows.length > 0 ? (                <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                        <thead className="text-slate-500 uppercase">
                            <tr className="border-b border-slate-700">
                                <th className="text-left font-medium py-2 pr-3">Time</th>
                                <th className="text-left font-medium py-2 pr-3">Round</th>
                                <th className="text-left font-medium py-2 pr-3">Stage</th>
                                <th className="text-left font-medium py-2 pr-3">Status</th>
                                <th className="text-right font-medium py-2 pr-3">Side</th>
                                <th className="text-right font-medium py-2 pr-3">Action</th>
                                <th className="text-right font-medium py-2 pr-3">Price</th>
                                <th className="text-right font-medium py-2 pr-3">Shares</th>
                                <th className="text-left font-medium py-2">Reason</th>
                            </tr>
                        </thead>
                        <tbody>
                            {visibleRows.map(row => {
                                const expanded = expandedId === row.id;
                                return (
                                    <tr key={row.id} className="border-b border-slate-700/50 align-top">
                                        <td className="py-2 pr-3 font-mono text-slate-400 whitespace-nowrap">{formatTime(row.ts)}</td>
                                        <td className="py-2 pr-3 font-mono text-slate-300 max-w-48 truncate">{row.slug}</td>
                                        <td className="py-2 pr-3 text-slate-300 capitalize">{row.kind}</td>
                                        <td className="py-2 pr-3">
                                            <span className={`inline-flex px-2 py-0.5 rounded border font-semibold ${statusClass(row.status)}`}>
                                                {statusLabel(row.status)}
                                            </span>
                                        </td>
                                        <td className={`py-2 pr-3 text-right font-semibold ${row.side === 'UP' ? 'text-emerald-400' : row.side === 'DOWN' ? 'text-red-400' : 'text-slate-500'}`}>
                                            {row.side ?? '---'}
                                        </td>
                                        <td className="py-2 pr-3 text-right text-slate-300 uppercase">{row.action ?? '---'}</td>
                                        <td className="py-2 pr-3 text-right font-mono text-slate-300">{formatPrice(row.price)}</td>
                                        <td className="py-2 pr-3 text-right font-mono text-slate-300">{formatShares(row.shares)}</td>
                                        <td className="py-2 text-slate-400">
                                            {row.reason || row.reasons?.length ? (
                                                <button
                                                    type="button"
                                                    className="text-left text-amber-300 hover:text-amber-200 max-w-64 truncate"
                                                    onClick={() => setExpandedId(expanded ? null : row.id)}
                                                >
                                                    {row.reason || row.reasons?.join('; ')}
                                                </button>
                                            ) : (
                                                <span className="text-slate-600">---</span>
                                            )}
                                            {expanded && (
                                                <div className="mt-2 p-3 rounded border border-slate-700 bg-slate-950/60 text-slate-300 space-y-1">
                                                    <div><span className="text-slate-500">Source:</span> {row.sourceEvent}</div>
                                                    {row.intentId && <div><span className="text-slate-500">Intent:</span> <span className="font-mono">{row.intentId}</span></div>}
                                                    {row.orderId && <div><span className="text-slate-500">Order:</span> <span className="font-mono">{row.orderId}</span></div>}
                                                    {row.pnl != null && <div><span className="text-slate-500">PnL:</span> ${row.pnl.toFixed(2)}</div>}
                                                    {row.reasons && row.reasons.length > 0 && (
                                                        <ul className="list-disc pl-4">
                                                            {row.reasons.map((reason, index) => <li key={index}>{reason}</li>)}
                                                        </ul>
                                                    )}
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            ) : (
                <div className="flex-1 min-h-40 flex items-center justify-center text-slate-500 text-sm italic">
                    No execution events yet. Orders will appear here after strategy intent, risk, placement, fill, cancellation, expiry, or settlement telemetry arrives.
                </div>
            )}
        </div>
    );
}
