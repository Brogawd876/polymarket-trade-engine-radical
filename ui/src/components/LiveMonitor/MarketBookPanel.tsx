import { useMemo } from 'react';
import { useStore } from '../../store';

function price(value: number | null | undefined) {
    return value == null ? '---' : value.toFixed(3);
}

export function MarketBookPanel() {
    const markets = useStore(state => state.markets);
    const current = useMemo(() => {
        const entries = Object.entries(markets);
        if (entries.length === 0) return null;
        return entries.reduce((latest, entry) =>
            entry[1].lastUpdated > latest[1].lastUpdated ? entry : latest
        );
    }, [markets]);
    const market = current?.[1] ?? null;

    return (
        <div className="bg-slate-800 p-4 rounded-lg border border-slate-700">
            <h2 className="text-lg font-semibold text-slate-200 mb-4">Top Of Book</h2>
            {market ? (
                <div className="grid grid-cols-3 gap-2 text-sm">
                    <div className="text-slate-500 text-xs uppercase">Side</div>
                    <div className="text-slate-500 text-xs uppercase text-right">Bid</div>
                    <div className="text-slate-500 text-xs uppercase text-right">Ask</div>

                    <div className="text-emerald-400 font-semibold">UP</div>
                    <div className="text-slate-200 font-mono text-right">{price(market.upBid ?? market.bid)}</div>
                    <div className="text-slate-200 font-mono text-right">{price(market.upAsk ?? market.ask)}</div>

                    <div className="text-red-400 font-semibold">DOWN</div>
                    <div className="text-slate-200 font-mono text-right">{price(market.downBid)}</div>
                    <div className="text-slate-200 font-mono text-right">{price(market.downAsk)}</div>
                </div>
            ) : (
                <div className="text-slate-500 text-sm italic">Waiting for book data...</div>
            )}
        </div>
    );
}
