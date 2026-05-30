import { useStore } from '../../store';
import type { TelemetryEvent } from '../../types/telemetry';

export function EventTimelinePanel() {
    const eventTimeline = useStore(state => state.eventTimeline);

    const formatEvent = (e: TelemetryEvent) => {
        const time = new Date(e.ts).toLocaleTimeString();
        switch (e.type) {
            case 'ORDER_LIFECYCLE':
                return { time, msg: `Order ${e.payload.action} ${e.payload.side} - ${e.payload.status}`, color: 'text-blue-400' };
            case 'LIFECYCLE_STATE':
                return { time, msg: `[${e.payload.slug}] ${e.payload.from} -> ${e.payload.to}`, color: 'text-amber-400' };
            case 'RISK_DECISION':
                return { time, msg: `Risk: ${e.payload.approved ? 'ALLOW' : 'BLOCK'} [${e.payload.slug}]`, color: e.payload.approved ? 'text-emerald-400' : 'text-red-400' };
            case 'FEED_STATUS':
                return { time, msg: `Feed ${e.payload.feed} is ${e.payload.status}`, color: 'text-slate-400' };
            default:
                return { time, msg: `${e.type}`, color: 'text-slate-500' };
        }
    };

    return (
        <div className="bg-slate-800 p-4 rounded-lg border border-slate-700 flex flex-col h-64">
            <h2 className="text-lg font-semibold text-slate-200 mb-4 shrink-0">Event Timeline</h2>
            <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar">
                {eventTimeline.slice(0, 50).map((e, idx) => {
                    const { time, msg, color } = formatEvent(e);
                    return (
                        <div key={idx} className="text-xs flex space-x-3 items-start font-mono">
                            <span className="text-slate-500 shrink-0 w-16">{time}</span>
                            <span className={color}>{msg}</span>
                        </div>
                    );
                })}
                {eventTimeline.length === 0 && (
                    <div className="text-slate-500 text-sm italic">Waiting for events...</div>
                )}
            </div>
        </div>
    );
}
