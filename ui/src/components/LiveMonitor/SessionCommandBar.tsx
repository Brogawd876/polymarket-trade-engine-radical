 
import { useStore } from '../../store';
import { useNavigate } from 'react-router-dom';
import { 
    PlayCircle, 
    Square, 
    Settings, 
    Activity
} from 'lucide-react';

const API_BASE = "http://127.0.0.1:3000/api/operator";

export function SessionCommandBar() {
    const operatorStatus = useStore(state => state.operatorStatus);
    const isConnected = useStore(state => state.isConnected);
    const navigate = useNavigate();

    const isRunning = operatorStatus?.sessionState === "running" || operatorStatus?.sessionState === "starting";
    const isStopping = operatorStatus?.sessionState === "stopping";

    const handleStop = async () => {
        try {
            await fetch(`${API_BASE}/session/stop`, { method: 'POST' });
        } catch (e: unknown) {
            console.error("Stop failed", e);
        }
    };

    if (!isConnected) return null;

    return (
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-3 flex items-center justify-between shadow-lg mb-6">
            <div className="flex items-center space-x-6">
                <div className="flex items-center">
                    <div className={`w-3 h-3 rounded-full mr-3 ${
                        isRunning ? 'bg-emerald-500 animate-pulse' : 
                        isStopping ? 'bg-amber-500 animate-pulse' : 
                        'bg-slate-600'
                    }`} />
                    <div className="flex flex-col">
                        <span className="text-[10px] text-slate-500 font-black uppercase tracking-widest leading-none mb-1">Session Mode</span>
                        <span className="text-sm font-bold text-slate-200 leading-none">
                            {isRunning ? (operatorStatus?.engineMode?.toUpperCase() || 'RUNNING') : (isStopping ? 'STOPPING' : 'IDLE')}
                        </span>
                    </div>
                </div>

                {isRunning && (
                    <>
                        <div className="h-8 w-px bg-slate-700" />
                        <div className="flex flex-col">
                            <span className="text-[10px] text-slate-500 font-black uppercase tracking-widest leading-none mb-1">Strategy / Source</span>
                            <span className="text-sm font-medium text-slate-400 leading-none">
                                {operatorStatus?.engineMode === 'replay' 
                                    ? operatorStatus.activeReplayFile?.split('/').pop() 
                                    : operatorStatus?.activePreset
                                        ? `${operatorStatus.activePreset.label} (${operatorStatus.activePreset.configHash})`
                                        : operatorStatus?.engineStatus?.strategy}
                            </span>
                        </div>
                        <div className="h-8 w-px bg-slate-700" />
                        <div className="flex flex-col">
                            <span className="text-[10px] text-slate-500 font-black uppercase tracking-widest leading-none mb-1">Active Rounds</span>
                            <span className="text-sm font-medium text-slate-400 leading-none">
                                {operatorStatus?.engineStatus?.activeLifecycles || 0}
                            </span>
                        </div>
                    </>
                )}
            </div>

            <div className="flex items-center space-x-3">
                {isRunning ? (
                    <button
                        onClick={handleStop}
                        className="flex items-center px-4 py-2 bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white border border-red-500/30 rounded-lg text-xs font-bold transition-all"
                    >
                        <Square className="w-3.5 h-3.5 mr-2" />
                        Stop Session
                    </button>
                ) : !isStopping ? (
                    <div className="flex items-center space-x-2">
                        <button
                            onClick={() => navigate('/controls')}
                            className="flex items-center px-4 py-2 bg-emerald-600/20 hover:bg-emerald-600 text-emerald-400 hover:text-white border border-emerald-500/30 rounded-lg text-xs font-bold transition-all"
                        >
                            <PlayCircle className="w-3.5 h-3.5 mr-2" />
                            Start Session
                        </button>
                    </div>
                ) : (
                    <div className="flex items-center px-4 py-2 bg-slate-700/50 text-slate-400 rounded-lg text-xs font-bold">
                        <Activity className="w-3.5 h-3.5 mr-2 animate-spin" />
                        Shutting Down...
                    </div>
                )}

                <button
                    onClick={() => navigate('/controls')}
                    className="p-2 bg-slate-700/50 hover:bg-slate-700 text-slate-400 hover:text-slate-200 rounded-lg transition-all border border-transparent hover:border-slate-600"
                    title="Session Configuration"
                >
                    <Settings className="w-4 h-4" />
                </button>
            </div>
        </div>
    );
}
