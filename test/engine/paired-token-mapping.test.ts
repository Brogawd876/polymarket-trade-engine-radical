import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { extractClobTokenIdsFromRawL2 } from "../../engine/replay/paired-token-mapping.ts";

async function withTempRawL2(lines: unknown[], testFn: (path: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "paired-token-mapping-"));
  const path = join(dir, "raw-l2.ndjson");
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  try {
    await testFn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("paired raw L2 token mapping", () => {
  test("extracts ordered CLOB token IDs from recorder metadata", async () => {
    await withTempRawL2([
      {
        eventType: "market_resolved_for_recording",
        payload: { clobTokenIds: ["TOKEN_UP_123", "TOKEN_DOWN_456"] },
      },
    ], async (path) => {
      expect(await extractClobTokenIdsFromRawL2(path)).toEqual({
        status: "ok",
        tokenIds: ["TOKEN_UP_123", "TOKEN_DOWN_456"],
        source: "market_resolved_for_recording",
      });
    });
  });

  test("extracts ordered token IDs from side-labeled raw L2 events", async () => {
    await withTempRawL2([
      { eventType: "market_book_snapshot", payload: { tokenId: "TOKEN_DOWN_456", side: "DOWN" } },
      { eventType: "market_book_delta", payload: { asset_id: "TOKEN_UP_123", side: "UP" } },
    ], async (path) => {
      expect(await extractClobTokenIdsFromRawL2(path)).toEqual({
        status: "ok",
        tokenIds: ["TOKEN_UP_123", "TOKEN_DOWN_456"],
        source: "side_labeled_raw_l2",
      });
    });
  });

  test("returns missing when raw L2 has no token IDs", async () => {
    await withTempRawL2([
      { eventType: "raw_market_message", payload: { event_type: "book" } },
    ], async (path) => {
      expect(await extractClobTokenIdsFromRawL2(path)).toEqual({
        status: "unavailable",
        tokenIds: null,
        reason: "token_mapping_missing",
        source: "none",
        observedTokenCount: 0,
      });
    });
  });

  test("returns ambiguous for unlabeled token IDs", async () => {
    await withTempRawL2([
      { eventType: "market_trade", payload: { tokenId: "TOKEN_A" } },
      { eventType: "market_trade", payload: { tokenId: "TOKEN_B" } },
    ], async (path) => {
      expect(await extractClobTokenIdsFromRawL2(path)).toEqual({
        status: "unavailable",
        tokenIds: null,
        reason: "token_mapping_ambiguous",
        source: "unlabeled_raw_l2",
        observedTokenCount: 2,
      });
    });
  });

  test("returns ambiguous for more than two token IDs", async () => {
    await withTempRawL2([
      { eventType: "market_book_snapshot", payload: { tokenId: "TOKEN_A", side: "UP" } },
      { eventType: "market_book_snapshot", payload: { tokenId: "TOKEN_B", side: "DOWN" } },
      { eventType: "market_book_snapshot", payload: { tokenId: "TOKEN_C", side: "UP" } },
    ], async (path) => {
      const result = await extractClobTokenIdsFromRawL2(path);
      expect(result.status).toBe("unavailable");
      expect(result.reason).toBe("token_mapping_ambiguous");
      expect(result.observedTokenCount).toBe(3);
    });
  });
});


