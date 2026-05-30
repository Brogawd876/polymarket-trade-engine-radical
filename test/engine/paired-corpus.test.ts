import { describe, test, expect } from "bun:test";
import { summarizePairManifests, formatPairedCorpusReport, shouldTimeout } from "../../scripts/paired-corpus-utils.ts";
import { type PairManifest } from "../../engine/replay/pair-manifest.ts";

describe("paired-corpus-utils", () => {
  test("summarizer excludes old-schema pair from evidence aggregates", () => {
    const oldSchemaManifest = {
      slug: "test-slug-1",
      strategy: "late-entry",
      coverageVerdict: "complete",
      strategyLabEvidenceVerdict: "usable",
      replayEventCount: 100,
      rawL2EventCount: 100,
      rawL2BookEventCount: 100,
      rawL2TradeEventCount: 0,
      parseErrors: [],
      validationErrors: [],
      validationWarnings: [],
    } as unknown as PairManifest; // pairValidity is missing

    const summary = summarizePairManifests([oldSchemaManifest]);
    expect(summary.totalCaptures).toBe(1);
    expect(summary.skippedPairs).toBe(1);
    expect(summary.validPairs).toBe(0);
    expect(summary.usableEvidence).toBe(0);
  });

  test("summarizer counts only valid pairs for evidence verdicts", () => {
    const validManifest: PairManifest = {
      slug: "test-slug-2",
      strategy: "late-entry",
      pairValidity: "valid",
      coverageVerdict: "complete",
      strategyLabEvidenceVerdict: "unavailable_no_fills",
      replayEventCount: 100,
      rawL2EventCount: 100,
      rawL2BookEventCount: 100,
      rawL2TradeEventCount: 0,
      parseErrors: [],
      validationErrors: [],
      validationWarnings: [],
    };

    const summary = summarizePairManifests([validManifest]);
    expect(summary.totalCaptures).toBe(1);
    expect(summary.validPairs).toBe(1);
    expect(summary.noFills).toBe(1);
  });

  test("summarizer counts invalid pairs separately", () => {
    const invalidManifest: PairManifest = {
      slug: "test-slug-3",
      strategy: "late-entry",
      pairValidity: "invalid",
      coverageVerdict: "incomplete_missing_l2",
      strategyLabEvidenceVerdict: "unavailable_missing_l2",
      replayEventCount: 100,
      rawL2EventCount: 0,
      rawL2BookEventCount: 0,
      rawL2TradeEventCount: 0,
      parseErrors: [],
      validationErrors: ["some error"],
      validationWarnings: [],
    };

    const summary = summarizePairManifests([invalidManifest]);
    expect(summary.totalCaptures).toBe(1);
    expect(summary.invalidPairs).toBe(1);
    expect(summary.validPairs).toBe(0);
    expect(summary.missingMapping).toBe(0); // Not counted since invalid
  });

  test("shouldTimeout behavior", () => {
    const startMs = Date.now() - 5000;
    expect(shouldTimeout(startMs, 3000)).toBe(true);
    expect(shouldTimeout(startMs, 10000)).toBe(false);
  });
});
