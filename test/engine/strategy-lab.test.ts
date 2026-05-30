import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StrategyLabBatchManager } from "../../engine/strategy-lab.ts";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures", "replay");

async function waitForBatch(manager: StrategyLabBatchManager, batchId: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const batch = manager.getBatch(batchId);
    if (batch && ["completed", "failed", "canceled"].includes(batch.state)) {
      return batch;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for Strategy Lab batch");
}

function withTempLog<T>(filename: string, contents: string, fn: (path: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "strategy-lab-"));
  const file = join(dir, filename);
  writeFileSync(file, contents, "utf8");
  return Promise.resolve(fn(file)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("StrategyLabBatchManager", () => {
  test("rejects unknown strategy names", async () => {
    const manager = new StrategyLabBatchManager();
    await expect(manager.createBatch({
      strategies: ["not-real"],
      files: [join(FIXTURES_DIR, "filled-order.log")],
    })).rejects.toThrow(/Unknown strategy/);
  });

  test("exposes backend-owned strategy variants", () => {
    const manager = new StrategyLabBatchManager();
    const variants = manager.listVariants();
    expect(variants.some(variant => variant.id === "simulation")).toBe(true);
    expect(variants.some(variant => variant.id === "late-entry-loose")).toBe(true);
    expect(variants.every(variant => typeof variant.description === "string")).toBe(true);
  });

  test("rejects non-replayable fixture files", async () => {
    await withTempLog("early-bird-2026-05-16-00-00-00.log", "plain console text", async (file) => {
      const manager = new StrategyLabBatchManager();
      await expect(manager.createBatch({
        strategies: ["simulation"],
        files: [file],
      })).rejects.toThrow(/not replayable/);
    });
  });

  test("runs one strategy on one fixture and returns PnL/result counts", async () => {
    const manager = new StrategyLabBatchManager();
    const batch = await manager.createBatch({
      strategies: ["simulation"],
      files: [join(FIXTURES_DIR, "filled-order.log")],
    });

    const completed = await waitForBatch(manager, batch.id);
    expect(completed.state).toBe("completed");
    expect(completed.runs).toHaveLength(1);
    expect(completed.runs[0]!.status).toBe("completed");
    expect(typeof completed.runs[0]!.pnl).toBe("number");
    expect(completed.runs[0]!.counts.intents).toBeGreaterThan(0);
    expect(completed.runs[0]!.counts.fills).toBeGreaterThan(0);
    expect(completed.runs[0]!.execution.markouts.samples).toBeGreaterThan(0);
    expect(completed.runs[0]!.execution.markouts.oneSecond).not.toBeNull();
    expect(completed.runs[0]!.execution.markouts.unavailableCount).toBeGreaterThan(0);
    expect(
      Object.keys(completed.runs[0]!.execution.markouts.unavailableReasons).length,
    ).toBeGreaterThan(0);
    expect(completed.summary.byStrategy[0]!.markoutSampleCount).toBeGreaterThan(0);
    expect(completed.summary.byStrategy[0]!.avgMarkout1s).not.toBeNull();
  });

  test("runs two strategies across multiple fixtures and produces aggregate summary", async () => {
    const manager = new StrategyLabBatchManager();
    const batch = await manager.createBatch({
      strategies: ["simulation", "late-entry"],
      files: [
        join(FIXTURES_DIR, "filled-order.log"),
        join(FIXTURES_DIR, "expired-order.log"),
      ],
    });

    const completed = await waitForBatch(manager, batch.id);
    expect(completed.summary.totalRuns).toBe(4);
    expect(completed.progress.completedRuns).toBe(4);
    expect(completed.summary.completed + completed.summary.failed + completed.summary.canceled).toBe(4);
    expect(completed.summary.avgPnl === null || Number.isFinite(completed.summary.avgPnl)).toBe(true);
  }, 15000);

  test("runs multiple variants and produces ranked recommendation", async () => {
    const manager = new StrategyLabBatchManager();
    const batch = await manager.createBatch({
      variants: ["simulation", "late-entry-loose"],
      files: [
        join(FIXTURES_DIR, "filled-order.log"),
        join(FIXTURES_DIR, "expired-order.log"),
      ],
    });

    const completed = await waitForBatch(manager, batch.id);
    expect(completed.summary.totalRuns).toBe(4);
    expect(completed.summary.byStrategy).toHaveLength(2);
    expect(completed.summary.byStrategy[0]!.score).toBeGreaterThanOrEqual(completed.summary.byStrategy[1]!.score);
    expect(completed.summary.recommendation?.strategy).toBe(completed.summary.byStrategy[0]!.strategy);
    expect(completed.runs.every(run => run.variantLabel.length > 0)).toBe(true);
  }, 15000);

  test("preserves unavailable markout reasons and does not fake no-trade markouts", async () => {
    const manager = new StrategyLabBatchManager();
    const batch = await manager.createBatch({
      strategies: ["late-entry"],
      files: [join(FIXTURES_DIR, "filled-order.log")],
    });

    const completed = await waitForBatch(manager, batch.id);
    expect(completed.state).toBe("completed");
    expect(completed.runs[0]!.counts.fills).toBe(0);
    expect(completed.runs[0]!.execution.markouts.samples).toBe(0);
    expect(completed.runs[0]!.execution.markouts.oneSecond).toBeNull();
    expect(completed.runs[0]!.execution.markouts.settlement).toBeNull();
  });

  test("failed fixture produces a failed row without killing the batch", async () => {
    const validButMalformed = [
      JSON.stringify({
        ts: 1000,
        type: "slot",
        action: "start",
        slug: "btc-updown-5m-bad",
        startTime: 1000,
        endTime: 301000,
        strategy: "simulation",
      }),
      "{ bad json",
    ].join("\n");

    await withTempLog("btc-updown-5m-bad.log", validButMalformed, async (file) => {
      const manager = new StrategyLabBatchManager();
      const batch = await manager.createBatch({
        strategies: ["simulation"],
        files: [file],
      });

      const completed = await waitForBatch(manager, batch.id);
      expect(completed.state).toBe("failed");
      expect(completed.runs[0]!.status).toBe("failed");
      expect(completed.runs[0]!.error).toMatch(/Replay log parse failed/);
    });
  });

  test("cancel marks unfinished rows as canceled", async () => {
    const manager = new StrategyLabBatchManager();
    const batch = await manager.createBatch({
      strategies: ["simulation", "late-entry"],
      files: [
        join(FIXTURES_DIR, "filled-order.log"),
        join(FIXTURES_DIR, "expired-order.log"),
      ],
    });

    const canceled = manager.cancelBatch(batch.id);
    expect(canceled?.state).toBe("canceled");
    expect(canceled?.runs.every(run => run.status === "canceled")).toBe(true);
  });
});
