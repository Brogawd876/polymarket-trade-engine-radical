import { describe, expect, test } from "bun:test";
import { ReplayResolutionAdapter } from "../../engine/bot-core/replay-resolution-adapter.ts";

describe("Replay Anchor Invariance Invariants", () => {
  test("anchor is immutable once set for a round", async () => {
    const reader: any = { 
        subscribe: (h: any) => { reader._h = h; return () => {}; },
        round: { slug: "btc-updown-5m-100" }
    };
    const adapter = new ReplayResolutionAdapter(reader);
    const round = { slug: "btc-updown-5m-100" } as any;

    // 1. Initial market open price event
    reader._h({
        ts: 1000,
        type: "market_price",
        openPrice: 60000,
        priceToBeat: 60000
    });

    const anchor1 = await adapter.priceToBeat(round);
    expect(anchor1?.price).toBe(60000);

    // 2. Later spot updates should NOT change the anchor
    reader._h({
        ts: 2000,
        type: "ticker",
        assetPrice: 65000
    });
    
    // Check spot is updated
    expect(adapter.latest()?.price).toBe(65000);
    
    // Check anchor is STILL 60000
    const anchor2 = await adapter.priceToBeat(round);
    expect(anchor2?.price).toBe(60000);
    expect(adapter.latestAnchor()?.price).toBe(60000);

    // 3. Even a late Chainlink resolution event should NOT overwrite the opening anchor
    reader._h({
        ts: 3000,
        type: "chainlink_resolution",
        price: 70000,
        roundId: "999"
    });
    
    expect(adapter.latest()?.price).toBe(70000);
    const anchor3 = await adapter.priceToBeat(round);
    expect(anchor3?.price).toBe(60000);
  });
});
