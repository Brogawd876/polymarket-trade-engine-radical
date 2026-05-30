import { SessionCommandBar } from './SessionCommandBar';
import { SystemStatusPanel } from './SystemStatusPanel';
import { FeedHealthPanel } from './FeedHealthPanel';
import { PredictiveSignalPanel } from './PredictiveSignalPanel';
import { RiskPanel } from './RiskPanel';
import { EventTimelinePanel } from './EventTimelinePanel';
import { SessionSummaryPanel } from './SessionSummaryPanel';
import { PriceChartPanel } from './PriceChartPanel';
import { RoundDecisionPanel } from './RoundDecisionPanel';
import { MarketBookPanel } from './MarketBookPanel';
import { ExecutionBlotterPanel } from './ExecutionBlotterPanel';

export function LiveMonitor() {
    return (
        <div className="p-6 h-full flex flex-col overflow-y-auto">
            <header className="mb-6 flex justify-between items-end">
                <div>
                    <h1 className="text-2xl font-bold text-slate-100 tracking-tight">Operator Deck</h1>
                    <p className="text-sm text-slate-400 mt-1">Real-time telemetry and control plane</p>
                </div>
            </header>

            {/* Compact Session Command Strip */}
            <SessionCommandBar />

            <div className="grid grid-cols-12 gap-6 pb-6">
                {/* Top Row - Status & Key metrics */}
                <div className="col-span-12 lg:col-span-4 space-y-6">
                    <SystemStatusPanel />
                    <RoundDecisionPanel />
                    <MarketBookPanel />
                    <FeedHealthPanel />
                    <SessionSummaryPanel />
                </div>
                {/* Center / Main - Charts & Core Signals */}
                <div className="col-span-12 lg:col-span-8 space-y-6">
                    <PriceChartPanel />
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <PredictiveSignalPanel />
                        <RiskPanel />
                    </div>
                </div>

                {/* Bottom Row - Logs */}
                <div className="col-span-12">
                    <ExecutionBlotterPanel />
                </div>
                <div className="col-span-12">
                    <EventTimelinePanel />
                </div>
            </div>
        </div>
    );
}
