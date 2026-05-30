import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';

function formatCurrency(value: number | null | undefined, digits = 2) {
    return value == null ? '---' : `$${value.toFixed(digits)}`;
}

function formatCountdown(ms: number) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

const MetricsRow = React.memo(({ market, latestSnapshot }: { market: any, latestSnapshot: any }) => { /* eslint-disable-line @typescript-eslint/no-explicit-any */
    return (
        <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div>
                    <span className="text-slate-500 block text-xs">BTC Now</span>
                    <span className="text-slate-200 font-semibold">{formatCurrency(market.price)}</span>
                </div>
                <div>
                    <span className="text-slate-500 block text-xs">Price To Beat</span>
                    <span className="text-slate-200 font-semibold">
                        {market.priceToBeat == null ? 'Waiting for open' : formatCurrency(market.priceToBeat)}
                    </span>
                </div>
                <div>
                    <span className="text-slate-500 block text-xs">P(UP) Fair Value</span>
                    <span className="text-sky-400 font-semibold">
                        {market.probabilityUp != null ? `${(market.probabilityUp * 100).toFixed(1)}%` : '---'}
                    </span>
                </div>
                <div>
                    <span className="text-slate-500 block text-xs">Realized Vol (σ)</span>
                    <span className="text-slate-200 font-semibold">
                        {market.sigma != null ? `${(market.sigma * 100).toFixed(1)}%` : '---'}
                    </span>
                </div>
            </div>

            <div className="pt-2 border-t border-slate-700/50 grid grid-cols-3 gap-3 text-xs">
                <div>
                    <span className="text-slate-500 block">Gap</span>
                    <span className={market.gap != null && market.gap >= 0 ? 'text-emerald-400 font-semibold' : 'text-red-400 font-semibold'}>
                        {market.gap == null ? '---' : `${market.gap >= 0 ? '+' : ''}${formatCurrency(market.gap)}`}
                    </span>
                </div>
                <div>
                    <span className="text-slate-500 block">OBI (Imbalance)</span>
                    <span className="text-slate-200">
                        {latestSnapshot?.flow.imbalance != null ? `${(latestSnapshot.flow.imbalance * 100).toFixed(1)}%` : '---'}
                    </span>
                </div>
                <div>
                    <span className="text-slate-500 block">CVD (10s)</span>
                    <span className={latestSnapshot?.flow.cvd10s != null && latestSnapshot.flow.cvd10s >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                        {latestSnapshot?.flow.cvd10s != null ? formatCurrency(latestSnapshot.flow.cvd10s) : '---'}
                    </span>
                </div>
            </div>
        </div>
    );
});

export function RoundDecisionPanel() {
    const markets = useStore(state => state.markets);
    const lifecycleStates = useStore(state => state.lifecycleStates);
    const roundResolutions = useStore(state => state.roundResolutions);
    const decisionSnapshots = useStore(state => state.decisionSnapshots);
    const [nowMs, setNowMs] = useState(() => Date.now());

    useEffect(() => {
        const handle = setInterval(() => setNowMs(Date.now()), 250);
        return () => clearInterval(handle);
    }, []);

    const current = useMemo(() => {
        const entries = Object.entries(markets);
        if (entries.length === 0) return null;
        return entries.reduce((latest, entry) =>
            entry[1].lastUpdated > latest[1].lastUpdated ? entry : latest
        );
    }, [markets]);

    const slug = current?.[0] ?? null;
    const market = current?.[1] ?? null;
    
    const latestSnapshot = useMemo(() => {
        if (!slug) return null;
        return decisionSnapshots.find(s => s.slug === slug);
    }, [decisionSnapshots, slug]);

    const lifecycleState = slug ? lifecycleStates[slug] : null;
    const resolution = slug ? roundResolutions[slug] : null;
    const remainingMs = market?.slotEndMs ? market.slotEndMs - nowMs : 0;
    const marketOpenMs = market?.slotEndMs ? market.slotEndMs - 300_000 : null;
    const msUntilOpen = marketOpenMs ? marketOpenMs - nowMs : 0;
    const isPreOpen = msUntilOpen > 0;
    const isEnded = !!market?.slotEndMs && remainingMs <= 0;
    const direction = market?.direction ?? null;
    const displayedResult = resolution?.direction ?? (market?.priceToBeat == null ? null : direction);
    const directionClass =
        displayedResult === 'UP' ? 'text-emerald-400' :
        displayedResult === 'DOWN' ? 'text-red-400' :
        'text-slate-400';
    const roundState =
        resolution ? `RESOLVED ${resolution.direction}` :
        lifecycleState === 'STOPPING' ? 'CLOSING' :
        isEnded ? 'ENDED / AWAITING RESOLUTION' :
        market?.priceToBeat == null ? 'WAITING FOR OPEN' :
        'LIVE';
    const countdownLabel =
        resolution ? 'Resolved' :
        isEnded ? 'Ended' :
        isPreOpen ? 'Market Opens In' :
        'Closes In';
    const countdownValue =
        resolution ? 'FINAL' :
        market?.slotEndMs ? formatCountdown(isPreOpen ? msUntilOpen : remainingMs) : '---';
    const resultLabel = resolution ? 'Final Result' : 'Current Result';
    const resultText = displayedResult ?? (market?.priceToBeat == null ? 'WAITING' : '---');

    const sentiment = latestSnapshot?.flow.sentiment ?? 'neutral';
    const sentimentClass = 
        sentiment === 'bullish' ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50' :
        sentiment === 'bearish' ? 'bg-red-500/20 text-red-400 border-red-500/50' :
        'bg-slate-500/20 text-slate-400 border-slate-500/50';

    return (
        <div className="bg-slate-800 p-4 rounded-lg border border-slate-700">
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                    <h2 className="text-lg font-semibold text-slate-200">Round Decision</h2>
                    {latestSnapshot && (
                        <div className={`px-2 py-0.5 rounded border text-[10px] uppercase font-bold tracking-wider ${sentimentClass}`}>
                            {sentiment} flow
                        </div>
                    )}
                </div>
                {slug && <span className="text-xs text-slate-400 font-mono">{slug}</span>}
            </div>

            {market ? (
                <div className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div className="p-3 bg-slate-900/50 rounded border border-slate-700/50">
                            <div className="text-xs text-slate-400 mb-1">Round State</div>
                            <div className={`text-lg font-bold ${resolution ? directionClass : 'text-slate-100'}`}>
                                {roundState}
                            </div>
                        </div>
                        <div className="p-3 bg-slate-900/50 rounded border border-slate-700/50">
                            <div className="text-xs text-slate-400 mb-1">{countdownLabel}</div>
                            <div className="text-2xl font-bold text-slate-100 font-mono">
                                {countdownValue}
                            </div>
                        </div>
                        <div className="p-3 bg-slate-900/50 rounded border border-slate-700/50">
                            <div className="text-xs text-slate-400 mb-1">{resultLabel}</div>
                            <div className={`text-2xl font-bold ${directionClass}`}>
                                {resultText}
                            </div>
                        </div>
                    </div>

                    <MetricsRow market={market} latestSnapshot={latestSnapshot} />
                </div>
            ) : (
                <div className="text-slate-500 text-sm italic">Waiting for market ticks...</div>
            )}
        </div>
    );
}
