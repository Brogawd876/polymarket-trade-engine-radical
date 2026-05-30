import { useStore } from '../../store';

export function SessionSummaryPanel() {
    const sessionPnl = useStore(state => state.sessionPnl);
    const replayProgress = useStore(state => state.replayProgress);

    return (
        <div className="bg-slate-800 p-4 rounded-lg border border-slate-700">
            <h2 className="text-lg font-semibold text-slate-200 mb-4">Session Summary</h2>
            
            <div className="space-y-4">
                <div className="p-3 bg-slate-900/50 rounded border border-slate-700/50">
                    <div className="text-xs text-slate-400 mb-1">Total PnL</div>
                    <div className={`text-2xl font-bold ${!sessionPnl ? 'text-slate-500' : sessionPnl.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {sessionPnl ? `$${sessionPnl.pnl.toFixed(2)}` : '---'}
                    </div>
                </div>

                {replayProgress && (
                    <div className="p-3 bg-slate-900/50 rounded border border-slate-700/50">
                        <div className="flex justify-between items-end mb-2">
                            <div className="text-xs text-slate-400">Replay Progress</div>
                            <div className="text-xs text-slate-300 font-mono">
                                {new Date(replayProgress.virtualTimeMs).toLocaleTimeString()}
                            </div>
                        </div>
                        <div className="w-full bg-slate-700 rounded-full h-1.5">
                            <div 
                                className="bg-emerald-500 h-1.5 rounded-full" 
                                style={{ width: `${Math.min(100, Math.max(0, (replayProgress.processedEvents / Math.max(1, replayProgress.totalEvents)) * 100))}%` }}
                            ></div>
                        </div>
                        <div className="text-xs text-slate-500 mt-2 text-right">
                            {replayProgress.processedEvents} / {replayProgress.totalEvents}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
