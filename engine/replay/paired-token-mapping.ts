import { readFileSync } from "fs";

export type ClobTokenIdExtraction =
  | {
      status: "ok";
      tokenIds: [string, string];
      source: "market_resolved_for_recording" | "side_labeled_raw_l2";
    }
  | {
      status: "unavailable";
      tokenIds: null;
      reason: "token_mapping_missing" | "token_mapping_ambiguous";
      source: "none" | "unlabeled_raw_l2" | "side_labeled_raw_l2";
      observedTokenCount: number;
    };

const TOKEN_ID_FIELDS = ["tokenId", "asset_id", "assetId"] as const;

function normalizeTokenId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readPayloadTokenId(obj: Record<string, unknown>): string | null {
  for (const field of TOKEN_ID_FIELDS) {
    const tokenId = normalizeTokenId(obj[field]);
    if (tokenId) return tokenId;
  }
  return null;
}

function readClobTokenIds(value: unknown): [string, string] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const up = normalizeTokenId(value[0]);
  const down = normalizeTokenId(value[1]);
  return up && down ? [up, down] : null;
}

import { createReadStream } from "fs";
import * as readline from "readline";

export async function extractClobTokenIdsFromRawL2(rawL2Path: string): Promise<ClobTokenIdExtraction> {
  const uniqueTokenIds = new Set<string>();
  const sideTokenIds = new Map<"UP" | "DOWN", Set<string>>([
    ["UP", new Set()],
    ["DOWN", new Set()],
  ]);

  const rl = readline.createInterface({
    input: createReadStream(rawL2Path),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const payload = typeof event.payload === "object" && event.payload !== null
      ? event.payload as Record<string, unknown>
      : {};

    const resolvedIds = readClobTokenIds(payload.clobTokenIds ?? event.clobTokenIds);
    if (resolvedIds) {
      rl.close();
      return {
        status: "ok",
        tokenIds: resolvedIds,
        source: "market_resolved_for_recording",
      };
    }

    for (const tokenId of [readPayloadTokenId(event), readPayloadTokenId(payload)]) {
      if (!tokenId) continue;
      uniqueTokenIds.add(tokenId);
      const side = payload.side ?? event.side;
      if (side === "UP" || side === "DOWN") {
        sideTokenIds.get(side)?.add(tokenId);
      }
    }
  }

  const upIds = sideTokenIds.get("UP") ?? new Set<string>();
  const downIds = sideTokenIds.get("DOWN") ?? new Set<string>();
  if (upIds.size === 1 && downIds.size === 1) {
    const up = [...upIds][0]!;
    const down = [...downIds][0]!;
    if (up !== down) {
      return {
        status: "ok",
        tokenIds: [up, down],
        source: "side_labeled_raw_l2",
      };
    }
  }

  if (uniqueTokenIds.size === 0) {
    return {
      status: "unavailable",
      tokenIds: null,
      reason: "token_mapping_missing",
      source: "none",
      observedTokenCount: 0,
    };
  }

  return {
    status: "unavailable",
    tokenIds: null,
    reason: "token_mapping_ambiguous",
    source: upIds.size > 0 || downIds.size > 0 ? "side_labeled_raw_l2" : "unlabeled_raw_l2",
    observedTokenCount: uniqueTokenIds.size,
  };
}
