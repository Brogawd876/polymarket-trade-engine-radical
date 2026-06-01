import { describe, expect, test } from "bun:test";
import type { PairManifest } from "../../engine/replay/pair-manifest.ts";
import { resolveStrategySelection } from "../../engine/strategy/index.ts";
import { buildProfitSurface } from "../../scripts/fvm-profit-surface.ts";
import type { FillAttributionRecord } from "../../scripts/fvm-fill-attribution.ts";
import {
  compareChampionCandidate,
  createMutationLabManifest,
  generateMutationProposals,
  proposalSchemaExample,
  selectDeterministicPairs,
  type PairManifestSelection,
} from "../../scripts/fvm-mutation-lab-core.ts";

function manifest(slug: string, pairValidity: PairManifest["pairValidity"] = "valid"): PairManifest {
  return {
    slug,
    marketAsset: "BTC",
    clobTokenIds: { UP: `${slug}-up`, DOWN: `${slug}-down` },
    pairStartedAtMs: 1,
    pairEndedAtMs: 2,
    pairValidity,
    replayLogPath: `${slug}.log`,
    rawL2LogPath: `${slug}.l2.log`,
  } as PairManifest;
}

function fill(overrides: Partial<FillAttributionRecord> = {}): FillAttributionRecord {
  return {
    slug: "btc-updown",
    orderId: "order-1",
    side: "UP",
    action: "buy",
    fillTsMs: 1,
    fillPrice: 0.5,
    fillShares: 5,
    notional: 2.5,
    settlementPnl: -1,
    settlementWin: false,
    roundDirection: "DOWN",
    markout1s: -0.01,
    markout5s: -0.02,
    markout30s: -0.03,
    adverseSelection: true,
    edge: 0.01,
    sigma: 1.2,
    probabilityUp: 0.51,
    timeRemainingMs: 45_000,
    spreadAtDecision: 0.06,
    cvdSideAdjusted: -250,
    imbalanceSideAdjusted: -0.4,
    divergenceAbs: 100,
    settlementAnchorPrice: 100_000,
    basisPct: 0.001,
    inventoryBeforeFill: 5,
    isAddingToInventory: true,
    sequenceId: "btc-updown:UP",
    fillIndexInSequence: 1,
    roundPnl: -1,
    sequenceEndedProfitable: false,
    edgeBucket: "ok_0.01-0.03",
    cvdBucket: "neg_heavy",
    basisBucket: "tight_<0.5pct",
    timeBucket: "final_0-60s",
    spreadBucket: "wide_>0.05",
    sigmaBucket: "high_1.0-1.5",
    inventoryRegime: "adding_to_inventory",
    ...overrides,
  };
}

describe("FVM mutation lab POC helpers", () => {
  test("selects valid pairs deterministically by slug and respects limit", () => {
    const pairs: PairManifestSelection[] = [
      { path: "z.pair.json", manifest: manifest("z") },
      { path: "bad.pair.json", manifest: manifest("bad", "invalid") },
      { path: "a.pair.json", manifest: manifest("a") },
      { path: "m.pair.json", manifest: manifest("m") },
    ];

    const selected = selectDeterministicPairs(pairs, 2);
    expect(selected.map((entry) => entry.manifest.slug)).toEqual(["a", "m"]);
  });

  test("creates an artifact manifest without auto-applying a candidate by default", () => {
    const created = createMutationLabManifest({
      runId: "run-1",
      generatedAt: "2026-06-01T00:00:00.000Z",
      championVariant: "fvm-v1.1.0-raw-ungated",
      autoApply: "none",
      pairLimit: 12,
      selectedPairCount: 3,
      artifacts: { manifest: "manifest.json" },
    });

    expect(created.schemaVersion).toBe(1);
    expect(created.candidateVariant).toBeNull();
    expect(created.status).toBe("created");
  });

  test("builds profit surface JSON and mutation proposals from attribution records", () => {
    const surface = buildProfitSurface([
      fill(),
      fill({ orderId: "order-2", settlementPnl: -0.5 }),
      fill({ orderId: "order-3", settlementPnl: 0.25, settlementWin: true, adverseSelection: false }),
    ], {
      generatedAt: "2026-06-01T00:00:00.000Z",
      variant: "fvm-v1.1.0-raw-ungated",
      inputJsonl: "fill-attribution.jsonl",
    });

    expect(surface.summary.recordCount).toBe(3);
    expect(surface.sections.time[0]?.key).toBe("final_0-60s");
    expect(surface.topLossBuckets.length).toBeGreaterThan(0);

    const proposals = generateMutationProposals(surface);
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals[0]?.id).toBe("fvm-toxic-fill-guard");
    expect(Object.keys(proposalSchemaExample()).sort()).toEqual(Object.keys(proposals[0]!).sort());
  });

  test("candidate variant is registered without overwriting the benchmark", () => {
    const champion = resolveStrategySelection("fvm-v1.1.0-raw-ungated");
    const candidate = resolveStrategySelection("fvm-v1.1.0-ai-mutant-poc");

    expect(champion.variant.id).toBe("fvm-v1.1.0-raw-ungated");
    expect(candidate.variant.id).toBe("fvm-v1.1.0-ai-mutant-poc");
    expect(champion.config.edgeWeightedSizing).toBeUndefined();
    expect(candidate.config.edgeWeightedSizing).toBe(true);
  });

  test("champion-vs-candidate comparison fails closed when metrics are missing", () => {
    const comparison = compareChampionCandidate({
      championVariant: "fvm-v1.1.0-raw-ungated",
      candidateVariant: "fvm-v1.1.0-ai-mutant-poc",
      summaries: [],
    });

    expect(comparison.decision).toBe("inconclusive");
    expect(comparison.reasons[0]).toContain("Missing");
  });

  test("champion-vs-candidate comparison is inconclusive without fill evidence", () => {
    const baseSummary = {
      baseStrategy: "fair-value-maker",
      label: "placeholder",
      paperEligible: false,
      runs: 1,
      completed: 1,
      failed: 0,
      canceled: 0,
      wins: 0,
      losses: 0,
      noTrades: 0,
      blockedVerdicts: 0,
      tradeCount: 1,
      winRate: 0,
      tradeRate: 1,
      totalPnl: 1,
      avgPnl: 1,
      bestPnl: 1,
      worstPnl: 1,
      conservativeAdjustedTotalPnl: 1,
      conservativeAdjustedAvgPnl: 1,
      conservativeAdjustedBestPnl: 1,
      conservativeAdjustedWorstPnl: 1,
      blocked: 0,
      problems: 0,
      brierScore: null,
      logLoss: null,
      avgFillRate: null,
      avgCancelRate: null,
      avgMarkout1s: null,
      avgMarkout5s: null,
      avgMarkout30s: null,
      avgSettlementMarkout: null,
      markoutSampleCount: 0,
      markoutUnavailableCount: 0,
      avgTurnover: null,
      conservativeFill: {
        noFillCount: 0,
        touchOnlyCount: 0,
        probableFillCount: 0,
        tradeThroughFillCount: 0,
        confirmedFillCount: 0,
        rejectedFillCount: 0,
        unknownInsufficientDataCount: 0,
        usableEvidenceRate: null,
        usableEvidenceCount: 0,
        evaluatedFillCount: 0,
        eligibleFillCount: 0,
        avgMarkout1s: null,
        avgMarkout5s: null,
        avgMarkout30s: null,
        adverseSelectionRate: null,
      },
      score: 1,
    };

    const comparison = compareChampionCandidate({
      championVariant: "fvm-v1.1.0-raw-ungated",
      candidateVariant: "fvm-v1.1.0-ai-mutant-poc",
      summaries: [
        { ...baseSummary, strategy: "fvm-v1.1.0-raw-ungated", conservativeAdjustedTotalPnl: 31.4 },
        { ...baseSummary, strategy: "fvm-v1.1.0-ai-mutant-poc", conservativeAdjustedTotalPnl: 26.3 },
      ],
    });

    expect(comparison.decision).toBe("inconclusive");
    expect(comparison.reasons).toContain("Comparison lacks useful conservative fill evidence.");
  });
});
