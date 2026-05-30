import { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Shield, Wallet, Network, Cpu, AlertCircle, CheckCircle2, Lock } from 'lucide-react';

interface EngineConfig {
    TICKER: string[];
    MARKET_WINDOW: string;
    MARKET_ASSET: string;
    PROD: boolean;
    FORCE_PROD: boolean;
    BINANCE_US: boolean;
    PRIVATE_KEY: string;
    POLY_FUNDER_ADDRESS: string;
    POLY_SIGNATURE_TYPE: number;
    BUILDER_KEY: string;
    BUILDER_SECRET: string;
    BUILDER_PASSPHRASE: string;
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

    const signatureTypeLabel = (type: number) => {
        switch (type) {
            case 0: return 'EOA (Standard Wallet)';
            case 1: return 'POLY_PROXY (Magic/Email)';
            case 2: return 'POLY_GNOSIS_SAFE (Safe)';
            case 3: return 'POLY_1271 (Smart Contract)';
            default: return 'NOT CONFIGURED';
        }
    };

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
                    <div className={`p-4 rounded-xl border flex items-center justify-between ${
                        config?.FORCE_PROD 
                        ? 'bg-red-500/10 border-red-500/30' 
                        : 'bg-emerald-500/10 border-emerald-500/30'
                    }`}>
                        <div className="flex items-center gap-4">
                            <div className={`p-2 rounded-lg ${config?.FORCE_PROD ? 'bg-red-500/20' : 'bg-emerald-500/20'}`}>
                                <Shield className={`w-6 h-6 ${config?.FORCE_PROD ? 'text-red-400' : 'text-emerald-400'}`} />
                            </div>
                            <div>
                                <h3 className={`font-bold ${config?.FORCE_PROD ? 'text-red-400' : 'text-emerald-400'}`}>
                                    {config?.FORCE_PROD ? 'PRODUCTION MODE ACTIVE' : 'SIMULATION MODE (SAFE)'}
                                </h3>
                                <p className="text-xs text-slate-400 mt-0.5">
                                    {config?.FORCE_PROD 
                                        ? 'Real funds are at risk. All safety gates are live.' 
                                        : 'Engine is restricted to paper trading and historical replay.'}
                                </p>
                            </div>
                        </div>
                        <div className="text-right">
                             <div className="text-[10px] uppercase tracking-widest text-slate-500 font-bold mb-1">Status</div>
                             <div className={`flex items-center gap-1.5 font-mono text-sm ${config?.FORCE_PROD ? 'text-red-400' : 'text-emerald-400'}`}>
                                {config?.FORCE_PROD ? <AlertCircle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
                                {config?.FORCE_PROD ? 'UNLOCKED' : 'LOCKED'}
                             </div>
                        </div>
                    </div>
                </div>

                {/* Wallet & Credentials */}
                <div className="col-span-12 lg:col-span-6 space-y-6">
                    <div className="bg-slate-800/40 rounded-xl border border-slate-700/50 overflow-hidden">
                        <div className="p-4 border-b border-slate-700 bg-slate-800/20 flex items-center gap-2">
                            <Wallet className="w-4 h-4 text-indigo-400" />
                            <h2 className="text-sm font-semibold text-slate-200">Wallet & Credentials</h2>
                        </div>
                        <div className="p-6 space-y-6">
                            <div className="flex justify-between items-start pb-4 border-b border-slate-700/50">
                                <div>
                                    <div className="text-xs text-slate-500 font-bold mb-1">PRIVATE_KEY</div>
                                    <div className="text-sm font-mono text-slate-300 flex items-center gap-2">
                                        <Lock className="w-3 h-3 text-slate-600" />
                                        {config?.PRIVATE_KEY}
                                    </div>
                                </div>
                                <div className="text-right">
                                    <div className="text-[10px] font-bold text-slate-500 mb-1 uppercase">Type</div>
                                    <div className="text-xs text-indigo-400 font-medium px-2 py-0.5 bg-indigo-500/10 rounded border border-indigo-500/20">
                                        {signatureTypeLabel(config?.POLY_SIGNATURE_TYPE ?? -1)}
                                    </div>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <div className="text-xs text-slate-500 font-bold mb-1 uppercase">Funder Address</div>
                                    <div className="text-xs font-mono text-slate-400 break-all">{config?.POLY_FUNDER_ADDRESS || '---'}</div>
                                </div>
                                <div>
                                    <div className="text-xs text-slate-500 font-bold mb-1 uppercase">Polymarket PROD</div>
                                    <div className={`text-xs font-bold ${config?.PROD ? 'text-red-400' : 'text-slate-500'}`}>
                                        {config?.PROD ? 'ENABLED' : 'DISABLED'}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="bg-slate-800/40 rounded-xl border border-slate-700/50 overflow-hidden">
                        <div className="p-4 border-b border-slate-700 bg-slate-800/20 flex items-center gap-2">
                            <Cpu className="w-4 h-4 text-indigo-400" />
                            <h2 className="text-sm font-semibold text-slate-200">Relayer Builder Credentials</h2>
                        </div>
                        <div className="p-6 grid grid-cols-1 gap-4">
                            {[
                                { label: 'Builder Key', value: config?.BUILDER_KEY },
                                { label: 'Builder Secret', value: config?.BUILDER_SECRET },
                                { label: 'Builder Passphrase', value: config?.BUILDER_PASSPHRASE }
                            ].map(item => (
                                <div key={item.label} className="flex justify-between items-center py-2 border-b border-slate-700/30 last:border-0">
                                    <span className="text-xs text-slate-500 font-medium">{item.label}</span>
                                    <span className="text-xs font-mono text-slate-300">{item.value}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Market & Feed Config */}
                <div className="col-span-12 lg:col-span-6 space-y-6">
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
                            <code className="mx-2 px-1 py-0.5 bg-slate-800 rounded text-amber-500 font-mono">repos/polymarket-trade-engine/.env</code> 
                            file and restart the engine.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
