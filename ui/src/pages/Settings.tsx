import { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Shield, Network, AlertCircle, CheckCircle2 } from 'lucide-react';

interface EngineConfig {
    TICKER: string[];
    MARKET_WINDOW: string;
    MARKET_ASSET: string;
    BINANCE_US: boolean;
    EXCHANGE_SUBMISSION: 'disabled';
    LIVE_AUTHORIZATION: 'not-implemented';
}

export default function Settings() {
    const [config, setConfig] = useState<EngineConfig | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const fetchConfig = async () => {
            try {
                const res = await fetch('http://127.0.0.1:3000/api/operator/config');
                if (!res.ok) throw new Error('Failed to fetch engine configuration');
                const data = await res.json();
                setConfig(data);
            } catch (e: any /* eslint-disable-line @typescript-eslint/no-explicit-any */) {
                setError(e.message);
            } finally {
                setLoading(false);
            }
        };

        fetchConfig();
    }, []);

    if (loading) return (
        <div className="p-8 flex items-center justify-center h-full">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
        </div>
    );

    if (error) return (
        <div className="p-8 flex items-center justify-center h-full text-red-400 gap-2">
            <AlertCircle className="w-6 h-6" />
            <span>{error}</span>
        </div>
    );

    return (
        <div className="p-6 h-full flex flex-col overflow-y-auto">
            <header className="mb-8">
                <h1 className="text-2xl font-bold text-slate-100 tracking-tight flex items-center gap-2">
                    <SettingsIcon className="w-6 h-6 text-slate-400" />
                    Engine Settings
                </h1>
                <p className="text-sm text-slate-400 mt-1">Runtime configuration and environment status</p>
            </header>

            <div className="grid grid-cols-12 gap-6 pb-12">
                {/* Production Guard Status */}
                <div className="col-span-12">
                    <div className="p-4 rounded-xl border flex items-center justify-between bg-emerald-500/10 border-emerald-500/30">
                        <div className="flex items-center gap-4">
                            <div className="p-2 rounded-lg bg-emerald-500/20">
                                <Shield className="w-6 h-6 text-emerald-400" />
                            </div>
                            <div>
                                <h3 className="font-bold text-emerald-400">
                                    EXCHANGE SUBMISSION DISABLED
                                </h3>
                                <p className="text-xs text-slate-400 mt-0.5">
                                    Engine is restricted to paper trading and historical replay. Live authorization is not implemented.
                                </p>
                            </div>
                        </div>
                        <div className="text-right">
                             <div className="text-[10px] uppercase tracking-widest text-slate-500 font-bold mb-1">Status</div>
                             <div className="flex items-center gap-1.5 font-mono text-sm text-emerald-400">
                                <CheckCircle2 className="w-4 h-4" />
                                LOCKED
                             </div>
                        </div>
                    </div>
                </div>

                {/* Market & Feed Config */}
                <div className="col-span-12 space-y-6">
                    <div className="bg-slate-800/40 rounded-xl border border-slate-700/50 overflow-hidden">
                        <div className="p-4 border-b border-slate-700 bg-slate-800/20 flex items-center gap-2">
                            <Network className="w-4 h-4 text-indigo-400" />
                            <h2 className="text-sm font-semibold text-slate-200">Feeds & Market Assets</h2>
                        </div>
                        <div className="p-6 space-y-6">
                            <div className="flex justify-between items-center py-3 border-b border-slate-700/50">
                                <span className="text-sm text-slate-400">Primary Asset</span>
                                <span className="text-sm font-bold text-slate-200 px-3 py-1 bg-slate-700 rounded-lg">{config?.MARKET_ASSET.toUpperCase()}</span>
                            </div>
                            <div className="flex justify-between items-center py-3 border-b border-slate-700/50">
                                <span className="text-sm text-slate-400">Market Window</span>
                                <span className="text-sm font-bold text-slate-200 px-3 py-1 bg-slate-700 rounded-lg">{config?.MARKET_WINDOW}</span>
                            </div>
                            <div className="space-y-3">
                                <div className="text-xs text-slate-500 font-bold uppercase tracking-wider">Active Tickers</div>
                                <div className="flex flex-wrap gap-2">
                                    {config?.TICKER.map(t => (
                                        <span key={t} className="text-xs font-medium text-indigo-300 px-2 py-1 bg-indigo-500/10 rounded border border-indigo-500/20 uppercase tracking-wide">
                                            {t}
                                        </span>
                                    ))}
                                </div>
                            </div>
                            <div className="flex justify-between items-center pt-3">
                                <span className="text-sm text-slate-400">Binance US Mode</span>
                                <span className={`text-xs font-bold ${config?.BINANCE_US ? 'text-indigo-400' : 'text-slate-500'}`}>
                                    {config?.BINANCE_US ? 'ACTIVE' : 'INACTIVE'}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="col-span-12">
                    <div className="p-6 bg-amber-500/5 border border-amber-500/20 rounded-xl text-center">
                        <p className="text-amber-500/70 text-sm italic">
                            Settings are read-only from the .env file. To modify configuration, please edit the 
                            <code className="mx-2 px-1 py-0.5 bg-slate-800 rounded text-amber-500 font-mono">.env</code>
                            file and restart the engine.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
