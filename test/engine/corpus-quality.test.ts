import { test, expect } from "bun:test";
import { summarizeCorpusQuality } from "../../engine/replay/corpus-quality.ts";
import type { PairManifest } from "../../engine/replay/pair-manifest.ts";
import type { CalibrationRecord } from "../../engine/replay/calibration-extractor.ts";

function createMockManifest(slug: string, isValid: boolean): PairManifest {
  return {
    slug,
    replayLogPath: "",
    rawL2LogPath: "",
    strategy: "test",
    slotStartMs: 1000,
    slotEndMs: 2000,
    captureStartedAtMs: 0,
    captureEndedAtMs: 0,
    runtimeStartedAtMs: 0,
    runtimeEndedAtMs: 0,
    recorderStartedAtMs: 0,
    recorderEndedAtMs: 0,
    runtimeExitCode: 0,
    recorderExitCode: 0,
    replayEventCount: 100,
    rawL2EventCount: 100,
    rawL2BookEventCount: 50,
    rawL2TradeEventCount: 50,
    replayFirstEventTsMs: 0,
    replayLastEventTsMs: 0,
    rawL2FirstEventTsMs: 0,
    rawL2LastEventTsMs: 0,
    coverageLeadMs: 0,
    coverageTailMs: 0,
    parseErrors: [],
    validationErrors: [],
    validationWarnings: [],
    coverageVerdict: isValid ? "complete" : "missing",
    pairValidity: isValid ? "valid" : "invalid",
    strategyLabEvidenceVerdict: "usable",
    gitCommit: "",
    commands: [],
    validatedAtMs: 0,
    createdAtMs: 0,
  };
}

test("Corpus Quality > summarizes valid and invalid pairs correctly", () => {
  const manifests = [
    { path: "1", manifest: createMockManifest("slug-1", true) },
    { path: "2", manifest: createMockManifest("slug-2", false) },
  ];
  
  const summary = summarizeCorpusQuality(manifests);
  expect(summary.validPairCount).toBe(1);
  expect(summary.invalidPairCount).toBe(1);
  expect(summary.temporalSpan.uniqueMarkets).toBe(2);
  expect(summary.completeCoverageCount).toBe(1);
});

test("Corpus Quality > calculates corpus thresholds and calibration stats", () => {
  const manifests = [{ path: "1", manifest: createMockManifest("slug-1", true) }];
  const records = [
    { fillTsMs: 1000, markout30s: 1, adverseSelection: true, dataQuality: { hasMarketTradeEvidence: true } } as CalibrationRecord,
    { fillTsMs: 1000, markout30s: 1, adverseSelection: false, dataQuality: { hasMarketTradeEvidence: false } } as CalibrationRecord,
  ];

  const summary = summarizeCorpusQuality(manifests, records, { minTotalRecords: 10, minTradePrintBackedRecords: 5 });
  
  expect(summary.totalCalibrationRecords).toBe(2);
  expect(summary.tradePrintBackedCount).toBe(1);
  expect(summary.touchOnlyCount).toBe(1);
  expect(summary.labeledRecordCount).toBe(2);
  expect(summary.adverseSelectionRate).toBe(0.5);
  
  expect(summary.readinessThresholdProgress?.totalRecords.required).toBe(10);
  expect(summary.readinessThresholdProgress?.tradePrintBacked.current).toBe(1);
});
