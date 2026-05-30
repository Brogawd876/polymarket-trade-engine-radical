import { useStore } from '../../store';

export function FeedHealthPanel() {
    const feeds = useStore(state => state.feeds);
    
    return (
        <div className="bg-slate-800 p-4 rounded-lg border border-slate-700">
            <h2 className="text-lg font-semibold text-slate-200 mb-4">Feed Health</h2>
            <div className="space-y-3">
                {Object.entries(feeds).map(([name, feed]) => (
                    <div key={name} className="flex items-center justify-between p-2 bg-slate-900/50 rounded border border-slate-700/50">
                        <div>
                            <span className="text-slate-300 font-medium">{name}</span>
                            {feed.message && <div className="text-xs text-red-400 mt-0.5">{feed.message}</div>}
                        </div>
                        <div className="flex items-center space-x-3 text-sm">
                            <span className="text-slate-500 capitalize">{feed.quality}</span>
                            <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
                                feed.status === 'connected' ? 'bg-emerald-500/20 text-emerald-400' :
                                feed.status === 'stale' ? 'bg-amber-500/20 text-amber-400' :
                                'bg-red-500/20 text-red-400'
                            }`}>
                                {feed.status.toUpperCase()}
                            </span>
                        </div>
                    </div>
                ))}
                {Object.keys(feeds).length === 0 && (
                    <div className="text-slate-500 text-sm italic">No feeds reporting yet...</div>
                )}
            </div>
        </div>
    );
}
