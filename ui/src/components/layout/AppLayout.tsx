import { NavLink, Outlet } from 'react-router-dom';
import { Activity, BarChart2, Settings, FileText, PlayCircle, ShieldCheck } from 'lucide-react';
import { useTelemetry } from '../../hooks/useTelemetry';
import { useStore } from '../../store';

export function AppLayout() {
    useTelemetry(); // Start telemetry connection on layout mount
    const isConnected = useStore((state) => state.isConnected);
    const bootInfo = useStore((state) => state.bootInfo);
    const operatorStatus = useStore((state) => state.operatorStatus);

    const navItems = [
        { path: '/', label: 'Live Monitor', icon: Activity },
        { path: '/controls', label: 'Control Center', icon: Settings },
        { path: '/replay', label: 'Replay Lab', icon: PlayCircle },
        { path: '/strategy', label: 'Strategy Lab', icon: BarChart2 },
        { path: '/readiness', label: 'Live Readiness', icon: ShieldCheck },
        { path: '/analytics', label: 'Analytics', icon: BarChart2 },
        { path: '/logs', label: 'Diagnostics', icon: FileText },
        { path: '/settings', label: 'Settings', icon: Settings },
    ];

    const displayMode = operatorStatus?.engineMode === 'idle'
        ? 'IDLE'
        : bootInfo?.mode || operatorStatus?.engineStatus?.mode || 'UNKNOWN';

    return (
        <div className="flex h-screen w-full bg-slate-900 text-slate-100 overflow-hidden">
            {/* Sidebar */}
            <aside className="w-64 bg-slate-800 border-r border-slate-700 flex flex-col">
                <div className="p-4 border-b border-slate-700">
                    <h1 className="text-xl font-bold text-emerald-500 tracking-tight">Operator Deck</h1>        
                    <div className="flex items-center mt-2 space-x-2 text-xs">
                        <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-red-500 animate-pulse'}`} />
                        <span className="text-slate-400">{isConnected ? 'Connected' : 'Disconnected'}</span>    
                    </div>
                </div>
                <nav className="flex-1 p-4 space-y-1">
                    {navItems.map((item) => (
                        <NavLink
                            key={item.path}
                            to={item.path}
                            className={({ isActive }) =>
                                `flex items-center space-x-3 px-3 py-2 rounded-md transition-colors ${
                                    isActive
                                        ? 'bg-emerald-500/10 text-emerald-400'
                                        : 'text-slate-400 hover:bg-slate-700/50 hover:text-slate-200'
                                }`
                            }
                        >
                            <item.icon className="w-4 h-4" />
                            <span className="text-sm font-medium">{item.label}</span>
                        </NavLink>
                    ))}
                </nav>
                <div className="p-4 border-t border-slate-700 text-xs text-slate-500">
                    {operatorStatus ? (
                        <>
                            <div>Mode: <span className="text-slate-300 uppercase">{displayMode}</span></div>  
                            <div>Engine: <span className="text-slate-300">{bootInfo?.version || '0.0.1'}</span></div>
                        </>
                    ) : (
                        <div>Engine not identified</div>
                    )}
                </div>
            </aside>
            {/* Main Content */}
            <main className="flex-1 overflow-auto bg-slate-900">
                <Outlet />
            </main>
        </div>
    );
}
