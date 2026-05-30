import { describe, expect, test } from "bun:test";
import { ChainlinkResolutionAdapter } from "../../engine/bot-core/chainlink-resolution-adapter.ts";
import { DefaultQuantMonitor } from "../../engine/bot-core/quant-monitor.ts";
import { VirtualClock } from "../../engine/bot-core/replay-runner.ts";
import { createEventClock, type PredictiveAggregateSnapshot } from "../../engine/bot-core/data-sources.ts";

describe("Chainlink Anchor Hardening", () => {
  test("QuantMonitor anchors to kind:open price even if spot moves", async () => {
    const clock = new VirtualClock();
    const telemetry: any = { push: () => {} };
    
    // 1. Mock Chainlink Adapter
    const adapter = new ChainlinkResolutionAdapter({
        asset: "btc",
        contractAddress: "0xc907E116054Ad103354f2D350FD2514433D57F6f",
        rpcUrl: "http://localhost",
        clock,
        telemetry
    });

    // Manually inject some data since we don't have a real RPC
    const initialPrice = 60000;
    (adapter as any).latestEvent = {
        id: "ev1",
        role: "resolution",
        source: "chainlink",
        asset: "btc",
        kind: "live",
        price: initialPrice,
        clock: createEventClock({ 
            sourceTimestampMs: clock.nowMs(),
            receivedAtMs: clock.nowMs() 
        }),
        quality: "live",
        stalenessStatus: "fresh"
    };

    // 2. Latch Anchor for round
    const round = {
        slug: "round-1",
        asset: "btc" as const,
        window: "5m" as const,
        startTimeMs: clock.nowMs(),
        endTimeMs: clock.nowMs() + 300_000
    };
    await adapter.priceToBeat(round);
    expect(adapter.latestAnchor()?.price).toBe(initialPrice);

    // 3. Setup QuantMonitor
    const aggregator: any = {
        latest: () => ({
            asset: "btc",
            timestampMs: clock.nowMs(),
            price: 60100, // Predictive S is $100 above anchor
        }),
        subscribe: (h: any) => {
            aggregator._h = h;
            return () => {};
        }
    };
    
    const monitor = new DefaultQuantMonitor({
        asset: "btc",
        aggregator,
        resolution: adapter,
        clock
    });

    // Prime volatility with 2 samples
    aggregator.latest = () => ({ price: 60000 });
    aggregator._h();
    clock.setNowMs(clock.nowMs() + 1000);
    aggregator.latest = () => ({ price: 60100 });
    aggregator._h();

    let snap = monitor.latest();
    console.log(`Initial snap: probUp=${snap.probabilityUp} sigma=${snap.sigma} anchor=${snap.settlementAnchorPrice}`);
    expect(snap.settlementAnchorPrice).toBe(initialPrice);
    expect(snap.probabilityUp).toBeDefined();
    if (snap.probabilityUp !== null) {
        expect(snap.probabilityUp).toBeGreaterThan(0.5);
    } else {
        throw new Error("probabilityUp is null - check sigma priming and round window");
    }

    // 4. Spot Chainlink moves significantly!
    (adapter as any).latestEvent = {
        ... (adapter as any).latestEvent,
        price: 70000, // Spot jumps to 70k (e.g. outlier or next round starting)
        chainUpdatedAtMs: clock.nowMs(),
        clock: createEventClock({
            sourceTimestampMs: clock.nowMs(),
            receivedAtMs: clock.nowMs()
        })
    };

    // Trigger update
    aggregator._h();
    
    snap = monitor.latest();
    // THE CRITICAL CHECK: Does it still use the latched anchor (60k) or the new spot (70k)?
    expect(snap.settlementAnchorPrice).toBe(initialPrice);
    expect(snap.probabilityUp).toBeGreaterThan(0.5); // Still bullish vs 60k
    // If it used 70k as anchor, probUp would be ~0.
  });
});
