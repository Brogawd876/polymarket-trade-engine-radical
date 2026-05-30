import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StrategyLabBatchManager, type StrategyLabBatch } from "../../engine/strategy-lab.ts";

function writeNdjson(path: string, events: unknown[]) {
  writeFileSync(path, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
}

async function waitForBatch(manager: StrategyLabBatchManager, batchId: string): Promise<StrategyLabBatch> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const batch = manager.getBatch(batchId);
    if (batch && (batch.state === "completed" || batch.state === "failed" || batch.state === "canceled")) {
      return batch;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Strategy Lab batch did not finish in time");
}

describe("Strategy Lab replay immutability", () => {
  test("paired Strategy Lab run does not append to source replay fixture and can score synthetic fill evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strategy-lab-replay-immutability-"));
    try {
      const replayPath = join(dir, "early-bird-btc-updown-5m-1000.log");
      const rawL2Path = join(dir, "raw-l2.ndjson");
      const fixturePath = join(import.meta.dir, "..", "fixtures", "replay", "filled-order.log");
      const slug = "btc-updown-5m-1778898900";
      const placementTs = 1_778_898_605_239;
      copyFileSync(fixturePath, replayPath);

      writeNdjson(rawL2Path, [
        {
          eventType: "market_resolved_for_recording",
          processedTsMs: placementTs - 500,
          receivedTsMs: placementTs - 500,
          slug,
          payload: { clobTokenIds: ["TOKEN_UP_123", "TOKEN_DOWN_456"] },
        },
        {
          eventType: "market_book_snapshot",
          processedTsMs: placementTs + 100,
          receivedTsMs: placementTs + 100,
          slug,
          payload: { tokenId: "TOKEN_UP_123", side: "UP", bestBid: 0.49, bestAsk: 0.50 },
        },
        {
          eventType: "market_trade",
          processedTsMs: placementTs + 200,
          receivedTsMs: placementTs + 200,
          slug,
          payload: { tokenId: "TOKEN_UP_123", side: "UP", price: 0.48, shares: 5 },
        },
      ]);

      const before = readFileSync(replayPath, "utf8");
      const beforeSize = statSync(replayPath).size;
      const manager = new StrategyLabBatchManager();
      const batch = await manager.createBatch({
        variants: ["simulation"],
        files: [replayPath],
        l2Files: { [replayPath]: rawL2Path },
      });
      const completed = await waitForBatch(manager, batch.id);
      const run = completed.runs[0]!;

      expect(run.status).toBe("completed");
      expect(run.execution.conservativeFill.eligibleFillCount).toBeGreaterThan(0);
      expect(run.execution.conservativeFill.usableEvidenceCount).toBeGreaterThan(0);
      expect(run.execution.conservativeFill.conservativeFillVerdictCounts.trade_through_fill).toBeGreaterThan(0);
      expect(readFileSync(replayPath, "utf8")).toBe(before);
      expect(statSync(replayPath).size).toBe(beforeSize);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});
