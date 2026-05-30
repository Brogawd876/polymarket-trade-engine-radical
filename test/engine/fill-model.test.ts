import { describe, expect, test } from "bun:test";
import {
  classifyMakerTaker,
  ConservativeMakerFillModel,
} from "../../engine/replay/fill-model.ts";

describe("ConservativeMakerFillModel", () => {
  test("does not count touch as a maker fill by default", () => {
    const model = new ConservativeMakerFillModel();
    const result = model.evaluate(
      {
        action: "buy",
        side: "UP",
        price: 0.49,
        shares: 10,
        orderType: "GTC",
      },
      {
        bids: [[0.49, 100]],
        asks: [[0.5, 5]],
        lastTradePrice: 0.49,
        lastTradeSize: 5,
      },
    );

    expect(result.filled).toBe(false);
    expect(result.reason).toContain("touch is not enough");
  });

  test("trade-through counts as a conservative maker fill", () => {
    const model = new ConservativeMakerFillModel();
    const result = model.evaluate(
      {
        action: "buy",
        side: "UP",
        price: 0.49,
        shares: 10,
        orderType: "GTC",
      },
      {
        bids: [[0.49, 100]],
        asks: [[0.5, 5]],
        lastTradePrice: 0.48,
        lastTradeSize: 10,
      },
    );

    expect(result.filled).toBe(true);
    expect(result.makerTaker).toBe("maker");
    expect(result.fillProbability).toBe(1);
  });

  test("unknown queue position defaults pessimistic", () => {
    const model = new ConservativeMakerFillModel();
    const result = model.evaluate(
      {
        action: "sell",
        side: "DOWN",
        price: 0.51,
        shares: 3,
        orderType: "GTC",
      },
      {
        bids: [[0.5, 10]],
        asks: [[0.52, 10]],
      },
    );

    expect(result.filled).toBe(false);
    expect(result.fillProbability).toBe(0);
  });

  test("FOK/FAK marketable orders are classified and depth-checked as taker", () => {
    const book = {
      bids: [[0.5, 2] as [number, number]],
      asks: [[0.52, 2] as [number, number]],
    };
    expect(
      classifyMakerTaker(
        { action: "buy", side: "UP", price: 0.52, shares: 1, orderType: "FOK" },
        book,
      ),
    ).toBe("taker");

    const model = new ConservativeMakerFillModel();
    const result = model.evaluate(
      { action: "buy", side: "UP", price: 0.52, shares: 3, orderType: "FAK" },
      book,
    );
    expect(result.makerTaker).toBe("taker");
    expect(result.filledShares).toBe(2);
    expect(result.reason).toContain("partially fills");
  });
});
