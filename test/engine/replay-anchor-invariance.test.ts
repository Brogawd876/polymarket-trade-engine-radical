import { describe, expect, test } from "bun:test";
import { ReplayResolutionAdapter } from "../../engine/bot-core/replay-resolution-adapter.ts";
import { VirtualClock } from "../../engine/bot-core/replay-runner.ts";

describe("Replay Anchor Invariance", () => {
  test("anchor stays fixed even after spot updates", async () => {
    const reader: any = { 
        subscribe: (h: any) => { reader._h = h; return () => {}; },
        round: { slug: "round-1" }
    };
    const adapter = new ReplayResolutionAdapter(reader);

    // 1. Initial market open price
    reader._h({
        ts: 1000,
        type: "market_price",
        openPrice: 60000,
        priceToBeat: 60000
    });

    const round = { slug: "round-1" } as any;
    const anchor = await adapter.priceToBeat(round);
    expect(anchor?.price).toBe(60000);
    expect(adapter.latestAnchor()?.price).toBe(60000);

    // 2. Spot updates (ticker)
    reader._h({
        ts: 2000,
        type: "ticker",
        assetPrice: 70000
    });

    expect(adapter.latest()?.price).toBe(70000);
    
    // THE INVARIANT: Anchor must still be 60000
    const anchor2 = await adapter.priceToBeat(round);
    expect(anchor2?.price).toBe(60000);
    expect(adapter.latestAnchor()?.price).toBe(60000);

    // 3. Late Chainlink update
    reader._h({
        ts: 3000,
        type: "chainlink_resolution",
        price: 75000,
        roundId: "123"
    });

    expect(adapter.latest()?.price).toBe(75000);
    expect(await adapter.priceToBeat(round)).toHaveProperty("price", 60000);
  });
});
