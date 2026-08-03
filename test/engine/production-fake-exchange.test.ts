import { describe, expect, test } from "bun:test";
import { DeterministicFakeExchange } from "../../engine/production/fake-exchange.ts";
import type { ExecutionCommand } from "../../engine/production/outbox.ts";

function command(
  overrides: Partial<ExecutionCommand["payload"]> = {},
): ExecutionCommand {
  return {
    executionCommandId: "command-1",
    intentId: "intent-1",
    clientCorrelationId: "correlation-1",
    kind: "SUBMIT",
    payload: {
      tokenId: "UP",
      side: "BUY",
      orderType: "GTC",
      postOnly: true,
      price: "0.49",
      quantity: "5",
      ...overrides,
    },
    state: "SUBMITTING",
    attemptCount: 1,
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

function exchange(scenario: "PESSIMISTIC" | "NEUTRAL" | "OPTIMISTIC") {
  let now = 1_000;
  const instance = new DeterministicFakeExchange(
    scenario,
    {
      name: "MEASURED_NORMAL",
      submissionMs: 50,
      acknowledgementMs: 50,
      cancellationMs: 25,
      feedMs: 10,
      disconnectRecoveryMs: 500,
    },
    () => now,
  );
  instance.setBook({
    tokenId: "UP",
    bids: [{ price: "0.49", quantity: "4" }],
    asks: [{ price: "0.51", quantity: "3" }],
  });
  return { instance, setNow: (value: number) => (now = value) };
}

describe("deterministic replay exchange", () => {
  test("rejects post-only crossing and models FOK/FAK depth exactly", async () => {
    const { instance } = exchange("NEUTRAL");
    const rejected = await instance.submit(command({ price: "0.51" }));
    expect(rejected.status).toBe("REJECTED");

    const fok = await instance.submit(
      command({
        orderType: "FOK",
        postOnly: false,
        price: "0.51",
        quantity: "4",
      }),
    );
    expect(fok.status).toBe("REJECTED");

    const fak = await instance.submit(
      command({
        orderType: "FAK",
        postOnly: false,
        price: "0.51",
        quantity: "4",
      }),
    );
    expect(fak.status).toBe("PARTIALLY_FILLED");
    expect(fak.fills[0]?.quantity).toBe("3");
  });

  test("does not fill before activation and applies stateful queue depletion", async () => {
    const { instance } = exchange("NEUTRAL");
    await instance.submit(command());
    expect(
      instance.applyTrade({
        tradeId: "trade-early",
        tokenId: "UP",
        aggressorSide: "SELL",
        price: "0.49",
        quantity: "10",
        sourceTimestampMs: 1_020,
        ingestTimestampMs: 1_030,
      }),
    ).toHaveLength(0);

    const first = instance.applyTrade({
      tradeId: "trade-1",
      tokenId: "UP",
      aggressorSide: "SELL",
      price: "0.49",
      quantity: "6",
      sourceTimestampMs: 1_100,
      ingestTimestampMs: 1_110,
    });
    expect(first[0]?.status).toBe("PARTIALLY_FILLED");
    expect(first[0]?.fills[0]?.quantity).toBe("2");
    expect(instance.snapshot()[0]?.remainingQuantity).toBe("3");

    const second = instance.applyTrade({
      tradeId: "trade-2",
      tokenId: "UP",
      aggressorSide: "SELL",
      price: "0.48",
      quantity: "3",
      sourceTimestampMs: 1_120,
      ingestTimestampMs: 1_130,
    });
    expect(second[0]?.status).toBe("FILLED");
  });

  test("pessimistic and optimistic scenarios produce explicitly different queues", async () => {
    const pessimistic = exchange("PESSIMISTIC").instance;
    const optimistic = exchange("OPTIMISTIC").instance;
    await pessimistic.submit(command());
    await optimistic.submit(command());
    expect(pessimistic.snapshot()[0]?.queueAhead).toBe("6");
    expect(optimistic.snapshot()[0]?.queueAhead).toBe("0");
  });
});
