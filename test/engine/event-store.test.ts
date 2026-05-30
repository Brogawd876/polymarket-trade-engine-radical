import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createProfitEvent } from "../../engine/event-store/events.ts";
import {
  NdjsonEventWriter,
  NoopEventWriter,
  safeStringify,
} from "../../engine/event-store/writer.ts";
import {
  DOWN_TOKEN,
  FixtureRunner,
  SLOT_END_MS,
} from "./helpers/fixture-runner.ts";

describe("profit event schema", () => {
  test("normalizes envelope fields with run/session provenance", () => {
    const event = createProfitEvent(
      {
        runId: "run-1",
        sessionId: "session-1",
        commitSha: "abc123",
        nowMs: () => 1000,
        monotonicNs: () => 42n,
      },
      {
        eventType: "run_started",
        source: "test",
        payload: { mode: "sim", status: "started" },
      },
    );

    expect(event.schemaVersion).toBe(1);
    expect(event.runId).toBe("run-1");
    expect(event.sessionId).toBe("session-1");
    expect(event.commitSha).toBe("abc123");
    expect(event.receivedTsMs).toBe(1000);
    expect(event.monotonicNs).toBe("42");
    expect(event.eventType).toBe("run_started");
  });

  test("safeStringify handles bigint, non-finite numbers, errors, and circular references", () => {
    const value: any = {
      id: 1n,
      bad: Infinity,
      error: new Error("boom"),
    };
    value.self = value;

    const parsed = JSON.parse(safeStringify(value));
    expect(parsed.id).toBe("1");
    expect(parsed.bad).toBeNull();
    expect(parsed.error.message).toBe("boom");
    expect(parsed.self).toBe("[Circular]");
  });
});

describe("event writers", () => {
  test("NoopEventWriter captures events without touching disk", async () => {
    const writer = new NoopEventWriter({
      runId: "run-noop",
      sessionId: "session-noop",
      commitSha: "local",
      nowMs: () => 10,
    });

    const event = await writer.append({
      eventType: "order_intent",
      source: "unit-test",
      payload: { orderId: "o1", action: "buy", price: 0.5, shares: 1 },
    });

    expect(event.runId).toBe("run-noop");
    expect(writer.events).toHaveLength(1);
    await writer.close();
  });

  test("NdjsonEventWriter appends one normalized JSON event per line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "event-store-"));
    try {
      const writer = new NdjsonEventWriter({
        rootDir: dir,
        runId: "run-file",
        sessionId: "session-file",
        commitSha: "abc",
        nowMs: () => 123,
      });

      await writer.append({
        eventType: "run_started",
        source: "unit-test",
        payload: { mode: "replay", status: "started" },
      });
      await writer.append({
        eventType: "run_completed",
        source: "unit-test",
        payload: { status: "completed" },
      });
      await writer.close();

      const lines = readFileSync(writer.filePath, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!).eventType).toBe("run_started");
      expect(JSON.parse(lines[1]!).eventType).toBe("run_completed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runtime event-store scaffold", () => {
  test("MarketLifecycle mirrors intent, risk, placement, fill, and strategy decisions", async () => {
    const writer = new NoopEventWriter({
      runId: "run-runtime",
      sessionId: "session-runtime",
      commitSha: "local",
    });
    const runner = new FixtureRunner(Infinity, { eventWriter: writer });
    try {
      await runner.setup(async (ctx) => {
        ctx.postOrders([
          {
            req: { tokenId: DOWN_TOKEN, action: "buy", price: 0.5, shares: 6 },
            expireAtMs: SLOT_END_MS,
          },
        ]);
      });
      await runner.advanceTo(SLOT_END_MS + 80_000);
      await runner.waitForState("DONE", SLOT_END_MS + 120_000);

      const types = writer.events.map((event) => event.eventType);
      expect(types).toContain("resolution_anchor");
      expect(types).toContain("price_to_beat");
      expect(types).toContain("order_intent");
      expect(types).toContain("risk_gate_decision");
      expect(types).toContain("order_submitted");
      expect(types).toContain("order_filled");
      expect(types).toContain("strategy_decision");
      expect(types).toContain("settlement_result");
      expect(writer.events.every((event) => event.runId === "run-runtime")).toBe(true);
    } finally {
      runner.teardown();
    }
  });
});
