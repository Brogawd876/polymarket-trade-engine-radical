import { useStore } from '../../store';

export function SystemStatusPanel() {
    const operatorStatus = useStore(state => state.operatorStatus);
    const systemStatus = operatorStatus?.engineStatus;
    const bootInfo = useStore(state => state.bootInfo);

    const mode = bootInfo?.mode || systemStatus?.mode || (operatorStatus?.engineMode === 'idle' ? 'IDLE' : 'UNKNOWN');
    const statusLabel = systemStatus?.isShuttingDown ? 'SHUTTING DOWN' : (systemStatus ? 'RUNNING' : (operatorStatus?.engineMode === 'idle' ? 'READY' : 'UNKNOWN'));

    return (
        <div className="bg-slate-800 p-4 rounded-lg border border-slate-700">
            <h2 className="text-lg font-semibold text-slate-200 mb-4">System Status</h2>
            <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                    <span className="text-slate-400 block">Mode</span>
                    <span className="text-slate-200 font-medium uppercase">{mode}</span>
                </div>
                <div>
                    <span className="text-slate-400 block">Status</span>
                    <span className="text-slate-200 font-medium uppercase">{statusLabel}</span>
                </div>
                <div>
                    <span className="text-slate-400 block">Strategy</span>
                    <span className="text-slate-200 font-medium">{bootInfo?.strategy || systemStatus?.strategy || 'None'}</span>
                </div>
                <div>
                    <span className="text-slate-400 block">Preset</span>
                    <span className="text-slate-200 font-medium">{operatorStatus?.activePreset ? `${operatorStatus.activePreset.label} (${operatorStatus.activePreset.configHash})` : 'None'}</span>
                </div>
                <div>
                    <span className="text-slate-400 block">Active Lifecycles</span>
                    <span className="text-slate-200 font-medium">{systemStatus?.activeLifecycles || 0}</span>   
                </div>
            </div>
        </div>
    );
}
