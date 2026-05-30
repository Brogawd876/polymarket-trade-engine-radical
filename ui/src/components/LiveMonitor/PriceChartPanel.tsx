import { useEffect, useRef, useMemo } from 'react';
import { createChart, ColorType, LineStyle } from 'lightweight-charts';
import type { IChartApi, IPriceLine, ISeriesApi, LineData, Time } from 'lightweight-charts';
import { useStore } from '../../store';

export function PriceChartPanel() {
    const chartContainerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
    const targetLineRef = useRef<IPriceLine | null>(null);

    const priceHistory = useStore(state => state.priceHistory);
    const markets = useStore(state => state.markets);
    // Find the market with the most history to display by default
    const primarySlug = useMemo(() => {
        const slugs = Object.keys(priceHistory);
        if (slugs.length === 0) return null;
        return slugs.reduce((a, b) => priceHistory[a].length > priceHistory[b].length ? a : b);
    }, [priceHistory]);
    const targetPrice = primarySlug ? markets[primarySlug]?.priceToBeat ?? null : null;

    useEffect(() => {
        if (!chartContainerRef.current) return;

        const chart = createChart(chartContainerRef.current, {
            layout: {
                background: { type: ColorType.Solid, color: 'transparent' },
                textColor: '#94a3b8',
            },
            grid: {
                vertLines: { color: '#334155' },
                horzLines: { color: '#334155' },
            },
            width: chartContainerRef.current.clientWidth,
            height: chartContainerRef.current.clientHeight,
            timeScale: {
                timeVisible: true,
                secondsVisible: false,
            }
        });

        const lineSeries = chart.addLineSeries({
            color: '#10b981',
            lineWidth: 2,
            crosshairMarkerVisible: true,
            crosshairMarkerRadius: 4,
            crosshairMarkerBorderColor: '#10b981',
            crosshairMarkerBackgroundColor: '#0f172a',
        });        
        chartRef.current = chart;
        seriesRef.current = lineSeries;

        const handleResize = () => {
            if (chartContainerRef.current) {
                chart.applyOptions({ width: chartContainerRef.current.clientWidth, height: chartContainerRef.current.clientHeight });
            }
        };

        window.addEventListener('resize', handleResize);

        return () => {
            window.removeEventListener('resize', handleResize);
            if (targetLineRef.current) {
                lineSeries.removePriceLine(targetLineRef.current);
                targetLineRef.current = null;
            }
            chart.remove();
        };
    }, []);

    useEffect(() => {
        if (!seriesRef.current || !primarySlug || !priceHistory[primarySlug]) return;
        
        const data: LineData[] = priceHistory[primarySlug].map(p => ({
            time: p.time as Time,
            value: p.value
        })).sort((a, b) => (a.time as number) - (b.time as number));
        
        if (data.length > 0) {
            // Check if timestamps are unique
            const uniqueData = data.filter((v, i, a) => i === 0 || v.time !== a[i-1].time);
            seriesRef.current.setData(uniqueData);
        }
    }, [priceHistory, primarySlug]);

    useEffect(() => {
        if (!seriesRef.current) return;

        if (targetLineRef.current) {
            seriesRef.current.removePriceLine(targetLineRef.current);
            targetLineRef.current = null;
        }

        if (targetPrice != null) {
            targetLineRef.current = seriesRef.current.createPriceLine({
                price: targetPrice,
                color: '#f59e0b',
                lineWidth: 2,
                lineStyle: LineStyle.Dashed,
                axisLabelVisible: true,
                title: 'Target',
            });
        }
    }, [targetPrice]);

    return (
        <div className="bg-slate-800 p-4 rounded-lg border border-slate-700 flex flex-col h-80 relative">
            <div className="flex justify-between items-center mb-4 shrink-0">
                <h2 className="text-lg font-semibold text-slate-200">
                    Live Price Chart
                </h2>
                <div className="flex items-center gap-2">
                    {targetPrice != null && (
                        <span data-testid="chart-target-label" className="text-xs bg-amber-500/10 text-amber-300 border border-amber-500/30 px-2 py-1 rounded font-mono">
                            Target ${targetPrice.toFixed(2)}
                        </span>
                    )}
                    {primarySlug && (
                        <span className="text-xs bg-slate-700 text-slate-300 px-2 py-1 rounded font-mono">
                            {primarySlug}
                        </span>
                    )}
                </div>
            </div>
            
            <div className="flex-1 w-full relative" ref={chartContainerRef}>
                {!primarySlug && (
                    <div className="absolute inset-0 flex items-center justify-center text-slate-500 italic z-10 pointer-events-none">
                        Waiting for market ticks...
                    </div>
                )}
            </div>
        </div>
    );
}
