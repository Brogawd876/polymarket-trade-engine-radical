import { useState, useEffect } from 'react';
import { useStore } from '../store';
import { 
    PlayCircle, 
    Square, 
    RotateCcw, 
    AlertTriangle, 
    Play, 
    Settings, 
    Database,
    Zap,
    Clock,
    RefreshCw,
    Trash2,
    Shield,
    Lock as LockIcon
} from 'lucide-react';
const API_BASE = "http://127.0.0.1:3000/api/operator";

type ReplayFixture = {
    path: string;
    label: string;
    replayable: boolean;
    validationStatus: "valid" | "invalid" | "unsupported";
    reason?: string;
};

type StrategyVariant = {
    id: string;
    label: string;
    strategy: string;
    description: string;
    paperEligible: boolean;
};

type StrategyPreset = {
    id: string;
    moduleId: string;
    label: string;
    configHash: string;
    riskProfile: string;
    promotionStatus: string;
};

export default function ControlCenter() {
    const operatorStatus = useStore(state => state.operatorStatus);
    const isConnected = useStore(state => state.isConnected);
    const [fixtures, setFixtures] = useState<ReplayFixture[]>([]);
    const [strategyVariants, setStrategyVariants] = useState<StrategyVariant[]>([]);
    const [strategyPresets, setStrategyPresets] = useState<StrategyPreset[]>([]);
    const [selectedReplay, setSelectedReplay] = useState<string>('');
    const [simRounds, setSimRounds] = useState<number>(0);
    const [strategy, setStrategy] = useState<string>('simulation');
    const [isResetting, setIsResetting] = useState(false);
    const [engineConfig, setEngineConfig] = useState<any /* eslint-disable-line @typescript-eslint/no-explicit-any */>(null);
    const [tinyLiveArmed, setTinyLiveArmed] = useState(false);

    useEffect(() => {
        fetch(`${API_BASE}/config`)
            .then(res => res.json())
            .then(data => setEngineConfig(data))
            .catch(err => console.error("Failed to fetch engine config", err));

        fetch(`${API_BASE}/replay-fixtures`)
            .then(res => res.json())
            .then(data => {
                if (data && Array.isArray(data.files)) {
                    const files = data.files as ReplayFixture[];
                    setFixtures(files);
                    
                    // Default to the first valid replayable fixture
                    const defaultFile = files.find(f => f.replayable);
                    if (defaultFile && !selectedReplay) setSelectedReplay(defaultFile.path);
                }
            })
            .catch(err => console.error("Failed to fetch replay fixtures", err));

        fetch(`${API_BASE}/strategy-lab/strategies`)
            .then(res => res.json())
            .then(data => {
                const loaded = Array.isArray(data.variants)
                    ? data.variants as StrategyVariant[]
                    : [
                        { id: 'simulation', label: 'simulation', strategy: 'simulation', description: '', paperEligible: true },
                        { id: 'late-entry', label: 'late-entry', strategy: 'late-entry', description: '', paperEligible: false },
                    ];
                setStrategyVariants(loaded);
                if (!loaded.some(item => item.id === strategy)) {
                    setStrategy(loaded.find(item => item.paperEligible)?.id ?? loaded[0]?.id ?? 'simulation');
                }
            })
            .catch(err => console.error("Failed to fetch strategy variants", err));

        fetch(`${API_BASE}/strategy/presets`)
            .then(res => res.json())
            .then(data => {
                if (Array.isArray(data.presets)) {
                    setStrategyPresets(data.presets);
                    if (data.presets.some((preset: StrategyPreset) => preset.id === strategy)) return;
                    const paper = data.presets.find((preset: StrategyPreset) => preset.riskProfile === 'paper');
                    if (paper) setStrategy(paper.id);
                }
            })
            .catch(err => console.error("Failed to fetch strategy presets", err));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleStartSim = async () => {
        try {
            const res = await fetch(`${API_BASE}/simulation/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    strategy,
                    presetId: strategyPresets.some(preset => preset.id === strategy) ? strategy : undefined,
                    rounds: simRounds > 0 ? simRounds : undefined
                })
            });
            const data = await res.json();
            if (!data.success) alert(`Start failed: ${data.error}`);
        } catch (e: any /* eslint-disable-line @typescript-eslint/no-explicit-any */) {
            alert(`Start failed: ${e.message}`);
        }
    };

    const handleStartReplay = async () => {
        const fixture = fixtures.find(f => f.path === selectedReplay);
        if (fixture && !fixture.replayable) {
            alert(`Cannot launch: ${fixture.reason || 'File not replayable'}`);
            return;
        }

        try {
            const res = await fetch(`${API_BASE}/replay/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file: selectedReplay })
            });
            const data = await res.json();
            if (!data.success) alert(`Replay start failed: ${data.error}`);
        } catch (e: any /* eslint-disable-line @typescript-eslint/no-explicit-any */) {
            alert(`Replay start failed: ${e.message}`);
        }
    };

    const handleStop = async () => {
        try {
            await fetch(`${API_BASE}/session/stop`, { method: 'POST' });
        } catch (e: any /* eslint-disable-line @typescript-eslint/no-explicit-any */) {
            alert(`Stop failed: ${e.message}`);
        }
    };

    const handleReset = async () => {
        if (!confirm("Are you sure you want to clear the paper simulation state? This will reset your paper balance to $50.")) return;
        setIsResetting(true);
        try {
            const res = await fetch(`${API_BASE}/simulation/reset-state`, { method: 'POST' });
            const data = await res.json();
            if (!data.success) {
                alert(`Reset failed: ${data.error}`);
            } else {
                // Refresh status
                const statusRes = await fetch("http://127.0.0.1:3000/api/operator/status");
                const statusData = await statusRes.json();
                useStore.getState().setOperatorStatus(statusData);
            }
        } catch (e: any /* eslint-disable-line @typescript-eslint/no-explicit-any */) {
            alert(`Reset failed: ${e.message}`);
        } finally {
            setIsResetting(false);
        }
    };

    if (!isConnected) {
        return (
            <div className="p-8 max-w-4xl mx-auto">
                <div className="bg-red-900/20 border border-red-500/50 p-6 rounded-xl flex items-start space-x-4">
                    <AlertTriangle className="w-8 h-8 text-red-500 flex-shrink-0" />
                    <div>
                        <h2 className="text-xl font-bold text-red-200 mb-2">Backend Unreachable</h2>
                        <p className="text-red-300/80">
                            The Operator Control Plane requires a connection to the trade engine. 
                            Please ensure the engine is running in <code>--idle</code> mode on port 3000.
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    const isRunning = operatorStatus?.sessionState === "running" || operatorStatus?.sessionState === "starting";
    const isStopping = operatorStatus?.sessionState === "stopping";
    const isBlocked = operatorStatus?.blockReason != null;
    const selectedPreset = strategyPresets.find(preset => preset.id === strategy);

    return (
        <div className="p-8 max-w-6xl mx-auto space-y-8">
            <header className="flex justify-between items-start">
                <div>
                    <h1 className="text-3xl font-bold text-slate-100 flex items-center">
                        <Settings className="w-8 h-8 mr-3 text-emerald-500" />
                        Control Center
                    </h1>
                    <p className="text-slate-400 mt-2 text-lg">Configure and launch bot trading sessions</p>
                </div>
                
                <div className="flex flex-col items-end space-y-2">
                    <div className="flex items-center space-x-3">
                        <span className="text-xs text-slate-500 font-mono uppercase tracking-widest">Engine Status</span>
                        <div className={`flex items-center px-3 py-1 rounded-full text-xs font-bold uppercase ${
                            operatorStatus?.sessionState === 'running' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' :
                            operatorStatus?.sessionState === 'starting' ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30' :
                            operatorStatus?.sessionState === 'stopping' ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' :
                            operatorStatus?.sessionState === 'failed' ? 'bg-red-500/20 text-red-400 border border-red-500/30' :
                            'bg-slate-700/50 text-slate-400 border border-slate-600/50'
                        }`}>
                            <div className={`w-1.5 h-1.5 rounded-full mr-2 ${
                                operatorStatus?.sessionState === 'running' ? 'bg-emerald-500 animate-pulse' :
                                operatorStatus?.sessionState === 'starting' ? 'bg-blue-500 animate-pulse' :
                                'bg-current'
                            }`} />
                            {operatorStatus?.sessionState || 'IDLE'}
                        </div>
                    </div>
                </div>
            </header>

            {/* Safety Awareness & Risk Limits */}
            {engineConfig && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className={`p-4 rounded-xl border flex flex-col justify-between ${engineConfig.FORCE_PROD ? 'bg-red-500/5 border-red-500/20' : 'bg-emerald-500/5 border-emerald-500/20'}`}>
                        <div className="flex items-center justify-between mb-2">
                             <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Trading Mode</div>
                             <Shield className={`w-4 h-4 ${engineConfig.FORCE_PROD ? 'text-red-400' : 'text-emerald-400'}`} />
                        </div>
                        <div className={`text-lg font-black ${engineConfig.FORCE_PROD ? 'text-red-400' : 'text-emerald-400'}`}>
                            {engineConfig.FORCE_PROD ? 'PRODUCTION' : 'SIMULATION'}
                        </div>
                        <div className="text-[10px] text-slate-500 mt-1 italic">
                            {engineConfig.FORCE_PROD ? 'Real funds active' : 'Safe/Virtual balance'}
                        </div>
                    </div>
                    
                    <div className="p-4 rounded-xl border bg-slate-800/30 border-slate-700/50 flex flex-col justify-between">
                        <div className="flex items-center justify-between mb-2">
                             <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Risk Guard (Session)</div>
                             <Zap className="w-4 h-4 text-indigo-400" />
                        </div>
                        <div className="text-lg font-black text-slate-200">
                            $3.00 <span className="text-xs text-slate-500 font-medium">MAX LOSS</span>
                        </div>
                        <div className="text-[10px] text-slate-500 mt-1 uppercase tracking-tighter">Automatic Kill-Switch active</div>
                    </div>

                    <div className="p-4 rounded-xl border bg-slate-800/30 border-slate-700/50 flex flex-col justify-between">
                        <div className="flex items-center justify-between mb-2">
                             <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Order Limits</div>
                             <LockIcon className="w-4 h-4 text-slate-400" />
                        </div>
                        <div className="text-lg font-black text-slate-200">
                            $10.00 <span className="text-xs text-slate-500 font-medium">NOTIONAL</span>
                        </div>
                        <div className="text-[10px] text-slate-500 mt-1 uppercase tracking-tighter">Per-order execution cap</div>
                    </div>
                </div>
            )}

            {isBlocked && (
                <div className="p-4 bg-red-900/30 border border-red-500/50 rounded-xl flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                        <AlertTriangle className="w-5 h-5 text-red-500" />
                        <div>
                            <span className="text-red-400 font-bold mr-2 uppercase text-xs">Blocked</span>
                            <span className="text-red-200 text-sm truncate max-w-2xl">{operatorStatus.blockReason}</span>
                        </div>
                    </div>
                    {(operatorStatus.blockReason?.includes("SESSION_LOSS_EXCEEDED") || operatorStatus.sessionState === 'failed') && (
                        <button
                            onClick={handleReset}
                            disabled={isResetting}
                            className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg font-bold text-sm transition-all flex items-center shadow-lg shadow-red-900/20 flex-shrink-0"
                        >
                            <RotateCcw className={`w-4 h-4 mr-2 ${isResetting ? 'animate-spin' : ''}`} />
                            Reset Engine State
                        </button>
                    )}
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* Paper Simulation Section */}
                <section className={`bg-slate-800/50 border border-slate-700 rounded-2xl overflow-hidden transition-all ${isRunning ? 'opacity-50 grayscale-[0.5]' : 'hover:border-slate-600 shadow-xl'}`}>
                    <div className="p-6 border-b border-slate-700 bg-slate-800/80 flex items-center">
                        <div className="p-3 bg-emerald-500/10 rounded-xl mr-4">
                            <Zap className="w-6 h-6 text-emerald-500" />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-slate-100">Paper Simulation</h2>
                            <p className="text-xs text-slate-500">Live-feed trading with virtual balance</p>
                        </div>
                    </div>
                    
                    <div className="p-8 space-y-6">
                        <div className="space-y-4">
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wider px-1">Strategy Preset</label>
                                    <select
                                        className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-slate-200 focus:ring-2 focus:ring-emerald-500 outline-none transition-all"
                                        value={strategy}
                                        onChange={e => setStrategy(e.target.value)}
                                        disabled={isRunning || isStopping}
                                    >
                                        {strategyPresets.map(preset => (
                                            <option key={preset.id} value={preset.id}>
                                                {preset.label} ({preset.riskProfile}, {preset.configHash})
                                            </option>
                                        ))}
                                        {strategyPresets.length === 0 && strategyVariants.map(variant => (
                                            <option key={variant.id} value={variant.id}>
                                                {variant.label}{variant.paperEligible ? '' : ' (replay tuning)'}
                                            </option>
                                        ))}
                                        {strategyPresets.length === 0 && strategyVariants.length === 0 && <option value="simulation">simulation</option>}
                                    </select>
                                    {selectedPreset && (
                                        <div className="rounded-lg border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs text-slate-400">
                                            <div className="flex justify-between gap-2">
                                                <span>{selectedPreset.moduleId} | {selectedPreset.riskProfile} | {selectedPreset.promotionStatus}</span>
                                                <span className="font-mono text-slate-300">{selectedPreset.configHash}</span>
                                            </div>
                                        </div>
                                    )}
                                </div>
                                <div className="space-y-2">
                                    <label className="text-xs font-bold text-slate-500 uppercase tracking-wider px-1">Rounds Limit</label>
                                    <div className="relative">
                                        <input
                                            type="number"
                                            className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-slate-200 focus:ring-2 focus:ring-emerald-500 outline-none transition-all pr-12"
                                            placeholder="0 = unlimited"
                                            value={simRounds}
                                            onChange={e => setSimRounds(parseInt(e.target.value) || 0)}
                                            disabled={isRunning || isStopping}
                                            min="0"
                                        />
                                        <span className="absolute right-4 top-3.5 text-slate-600 text-xs font-bold">Qty</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <button
                            onClick={handleStartSim}
                            disabled={isRunning || isStopping || isBlocked}
                            className="w-full py-4 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-xl font-bold text-lg transition-all flex items-center justify-center shadow-lg shadow-emerald-900/20"
                        >
                            <PlayCircle className="w-6 h-6 mr-3" />
                            Launch Simulation
                        </button>
                    </div>
                </section>

                {/* Historical Replay Section */}
                <section className={`bg-slate-800/50 border border-slate-700 rounded-2xl overflow-hidden transition-all ${isRunning ? 'opacity-50 grayscale-[0.5]' : 'hover:border-slate-600 shadow-xl'}`}>
                    <div className="p-6 border-b border-slate-700 bg-slate-800/80 flex items-center">
                        <div className="p-3 bg-blue-500/10 rounded-xl mr-4">
                            <Database className="w-6 h-6 text-blue-500" />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-slate-100">Historical Replay</h2>
                            <p className="text-xs text-slate-500">Backtest strategy on logged data</p>
                        </div>
                    </div>
                    
                    <div className="p-8 space-y-6">
                        <div className="space-y-2">
                            <label className="text-xs font-bold text-slate-500 uppercase tracking-wider px-1">Replay Fixture</label>
                            <select
                                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-slate-200 focus:ring-2 focus:ring-blue-500 outline-none transition-all truncate"
                                value={selectedReplay}
                                onChange={e => setSelectedReplay(e.target.value)}
                                disabled={isRunning || isStopping || fixtures.length === 0}
                            >
                                {fixtures.map(f => (
                                    <option key={f.path} value={f.path} className={f.replayable ? '' : 'text-slate-500'}>
                                        {f.replayable ? '' : '⚠ '} {f.label}
                                    </option>
                                ))}
                                {fixtures.length === 0 && <option value="">No fixtures found</option>}
                            </select>
                            {selectedReplay && !fixtures.find(f => f.path === selectedReplay)?.replayable && (
                                <p className="text-[10px] text-amber-500 mt-1 px-1 font-medium italic">
                                    {fixtures.find(f => f.path === selectedReplay)?.reason}
                                </p>
                            )}
                        </div>

                        <button
                            onClick={handleStartReplay}
                            disabled={isRunning || isStopping || !selectedReplay || !fixtures.find(f => f.path === selectedReplay)?.replayable || isBlocked}
                            className="w-full py-4 bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-xl font-bold text-lg transition-all flex items-center justify-center shadow-lg shadow-blue-900/20"
                        >
                            <Play className="w-6 h-6 mr-3" />
                            Launch Replay
                        </button>
                    </div>
                </section>
            </div>

            <section className="bg-slate-800/50 border border-amber-500/30 rounded-2xl overflow-hidden shadow-xl">
                <div className="p-6 border-b border-amber-500/20 bg-amber-500/5 flex items-center justify-between gap-4">
                    <div className="flex items-center">
                        <div className="p-3 bg-amber-500/10 rounded-xl mr-4">
                            <Shield className="w-6 h-6 text-amber-400" />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-slate-100">Ultra-Tiny Live Evidence Lane</h2>
                            <p className="text-xs text-amber-200/70">Real-money collection mode remains locked until technical and paper gates pass.</p>
                        </div>
                    </div>
                    <div className="text-right">
                        <div className="text-[10px] text-slate-500 uppercase font-bold tracking-wider">Hard Caps</div>
                        <div className="text-sm font-black text-amber-300">$1/order | $5 exposure | $5 loss</div>
                    </div>
                </div>
                <div className="p-6 grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
                            <div className="text-[10px] text-slate-500 uppercase font-bold">Execution Policy</div>
                            <div className="mt-1 text-sm text-slate-200 font-semibold">Maker-first only</div>
                            <div className="mt-1 text-xs text-slate-500">No aggressive lead-lag taker mode.</div>
                        </div>
                        <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
                            <div className="text-[10px] text-slate-500 uppercase font-bold">Auto Stop</div>
                            <div className="mt-1 text-sm text-slate-200 font-semibold">Any anomaly</div>
                            <div className="mt-1 text-xs text-slate-500">Stale feed, failed cancel, unexpected fill, or disconnect.</div>
                        </div>
                        <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
                            <div className="text-[10px] text-slate-500 uppercase font-bold">Evidence Status</div>
                            <div className="mt-1 text-sm text-slate-200 font-semibold">Not proof of profit</div>
                            <div className="mt-1 text-xs text-slate-500">Tiny-live results are evidence only.</div>
                        </div>
                    </div>
                    <div className="space-y-3">
                        <label className="flex items-start gap-3 rounded-xl border border-slate-700 bg-slate-900/60 p-4 text-sm text-slate-300">
                            <input
                                type="checkbox"
                                className="mt-1"
                                checked={tinyLiveArmed}
                                onChange={event => setTinyLiveArmed(event.target.checked)}
                                disabled={isRunning || isStopping}
                            />
                            <span>
                                <span className="block font-bold text-slate-100">Manual arm required</span>
                                <span className="block text-xs text-slate-500 mt-1">Confirms the operator sees the live caps before any later live endpoint can be enabled.</span>
                            </span>
                        </label>
                        <button
                            type="button"
                            disabled={!tinyLiveArmed || isRunning || isStopping}
                            onClick={() => alert('Tiny-live execution is intentionally blocked in this phase. Complete paper gates before wiring a live endpoint.')}
                            className="w-full py-3 bg-amber-600 hover:bg-amber-500 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-xl font-bold transition-all flex items-center justify-center"
                        >
                            <LockIcon className="w-5 h-5 mr-2" />
                            Tiny-Live Locked
                        </button>
                    </div>
                </div>
            </section>

            {/* Stop Action Bar */}
            {isRunning && (
                <div className="p-6 bg-amber-900/20 border border-amber-700/50 rounded-2xl flex items-center justify-between shadow-xl">
                    <div className="flex items-center space-x-4">
                        <div className="p-3 bg-amber-500/10 rounded-xl">
                            <Clock className="w-6 h-6 text-amber-500" />
                        </div>
                        <div>
                            <div className="text-amber-500 font-black uppercase text-sm tracking-wider">Session in Progress</div>
                            <div className="text-slate-300">
                                {operatorStatus?.engineMode === 'replay' 
                                    ? `Backtesting fixture: ${operatorStatus.activeReplayFile?.split('/').pop()}`
                                    : operatorStatus?.activePreset
                                        ? `Active Preset: ${operatorStatus.activePreset.label} (${operatorStatus.activePreset.configHash})`
                                        : `Active Strategy: ${operatorStatus?.engineStatus?.strategy}`}
                            </div>
                        </div>
                    </div>
                    <button
                        onClick={handleStop}
                        className="px-8 py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl font-bold transition-all flex items-center shadow-lg shadow-red-900/30"
                    >
                        <Square className="w-5 h-5 mr-3" />
                        Kill Session
                    </button>
                </div>
            )}

            {isStopping && (
                <div className="p-6 bg-slate-800 border border-slate-700 rounded-2xl flex items-center justify-center space-x-4 animate-pulse">
                    <RefreshCw className="w-6 h-6 text-amber-500 animate-spin" />
                    <span className="text-xl font-bold text-slate-200">Session Shutting Down...</span>
                </div>
            )}

            {!isRunning && !isStopping && (
                <div className="pt-8 border-t border-slate-800 flex justify-between items-center">
                    <div className="text-sm text-slate-500">
                        <span className="font-bold">Pro-tip:</span> Use Historical Replay to validate risk gates before running paper simulation.
                    </div>
                    <button
                        onClick={handleReset}
                        disabled={isResetting}
                        className="px-6 py-3 bg-slate-800 hover:bg-red-900/20 text-slate-400 hover:text-red-400 border border-slate-700 rounded-xl text-sm font-bold transition-all flex items-center"
                    >
                        <Trash2 className={`w-4 h-4 mr-2 ${isResetting ? 'animate-spin' : ''}`} />
                        Reset Simulation State
                    </button>
                </div>
            )}
        </div>
    );
}
