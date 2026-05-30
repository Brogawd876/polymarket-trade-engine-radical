import { useStore } from '../../store';

export function RiskPanel() {
    const latestRiskDecisions = useStore(state => state.latestRiskDecisions);
    const latest = latestRiskDecisions[0];

    return (
        <div className="bg-slate-800 p-4 rounded-lg border border-slate-700">
            <h2 className="text-lg font-semibold text-slate-200 mb-4">Risk & Execution</h2>
            
            {latest ? (
                <div className={`p-4 rounded border ${latest.approved ? 'bg-emerald-900/20 border-emerald-700/50' : 'bg-red-900/20 border-red-700/50'}`}>
                    <div className="flex items-center justify-between mb-2">
                        <span className="font-medium text-slate-200">{latest.slug}</span>
                        <span className={`text-sm font-bold uppercase ${latest.approved ? 'text-emerald-400' : 'text-red-400'}`}>
                            {latest.approved ? 'ALLOWED' : 'BLOCKED'}
                        </span>
                    </div>
                    {latest.reasons.length > 0 && (
                        <ul className="text-sm space-y-1 mt-2">
                            {latest.reasons.map((reason, i) => (
                                <li key={i} className="flex items-start text-slate-300">
                                    <span className="text-slate-500 mr-2">-</span>
                                    {reason}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            ) : (
                <div className="text-slate-500 text-sm italic">No recent risk decisions...</div>
            )}
        </div>
    );
}
