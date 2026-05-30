import type { PairManifest } from "./pair-manifest.ts";
import type { CalibrationRecord } from "./calibration-extractor.ts";

export type CorpusQualitySummary = {
  pairs: Array<{
    pairPath: string;
    slug: string;
    strategy: string;
    pairValidity: string;
    coverageVerdict: string;
    strategyLabStatus: string;
    strategyLabEvidenceVerdict: string;
    replayEventCount: number;
    rawL2EventCount: number;
    rawL2TradeEventCount: number;
    recorderStopReason?: string;
    recorderCompletedEventSeen?: boolean;
    validationErrorsCount: number;
    validationWarningsCount: number;
  }>;

  validPairCount: number;
  invalidPairCount: number;
  completeCoverageCount: number;
  totalRawL2TradeEvents: number;
  
  totalCalibrationRecords: number;
  labeledRecordCount: number;
  missingLabelCount: number;
  tradePrintBackedCount: number;
  touchOnlyCount: number;
  noFillCount: number;
  adverseSelectionRate: number | null;
  
  temporalSpan: {
    firstSlotMs: number | null;
    lastSlotMs: number | null;
    uniqueMarkets: number;
    approxHoursCovered: number;
  };
  
  readinessThresholdProgress?: {
    totalRecords: { current: number; required: number };
    tradePrintBacked: { current: number; required: number };
  };
};

export function summarizeCorpusQuality(
  manifests: { path: string; manifest: PairManifest }[],
  records?: CalibrationRecord[],
  thresholds?: { minTotalRecords: number; minTradePrintBackedRecords: number }
): CorpusQualitySummary {
  const summary: CorpusQualitySummary = {
    pairs: [],
    validPairCount: 0,
    invalidPairCount: 0,
    completeCoverageCount: 0,
    totalRawL2TradeEvents: 0,
    totalCalibrationRecords: 0,
    labeledRecordCount: 0,
    missingLabelCount: 0,
    tradePrintBackedCount: 0,
    touchOnlyCount: 0,
    noFillCount: 0,
    adverseSelectionRate: null,
    temporalSpan: {
      firstSlotMs: null,
      lastSlotMs: null,
      uniqueMarkets: 0,
      approxHoursCovered: 0,
    }
  };

  const slugs = new Set<string>();
  
  for (const { path, manifest } of manifests) {
    summary.pairs.push({
      pairPath: path,
      slug: manifest.slug,
      strategy: manifest.strategy,
      pairValidity: manifest.pairValidity,
      coverageVerdict: manifest.coverageVerdict,
      strategyLabStatus: manifest.strategyLabStatus || "unknown",
      strategyLabEvidenceVerdict: manifest.strategyLabEvidenceVerdict,
      replayEventCount: manifest.replayEventCount,
      rawL2EventCount: manifest.rawL2EventCount,
      rawL2TradeEventCount: manifest.rawL2TradeEventCount,
      recorderStopReason: manifest.recorderStopReason,
      recorderCompletedEventSeen: manifest.recorderCompletedEventSeen,
      validationErrorsCount: manifest.validationErrors.length,
      validationWarningsCount: manifest.validationWarnings.length,
    });

    if (manifest.pairValidity === "valid") {
      summary.validPairCount++;
      summary.totalRawL2TradeEvents += manifest.rawL2TradeEventCount;
      if (manifest.coverageVerdict === "complete") {
        summary.completeCoverageCount++;
      }
    } else {
      summary.invalidPairCount++;
    }

    slugs.add(manifest.slug);
    
    if (summary.temporalSpan.firstSlotMs === null || manifest.slotStartMs < summary.temporalSpan.firstSlotMs) {
      summary.temporalSpan.firstSlotMs = manifest.slotStartMs;
    }
    if (summary.temporalSpan.lastSlotMs === null || manifest.slotEndMs > summary.temporalSpan.lastSlotMs) {
      summary.temporalSpan.lastSlotMs = manifest.slotEndMs;
    }
  }

  summary.temporalSpan.uniqueMarkets = slugs.size;
  if (summary.temporalSpan.firstSlotMs !== null && summary.temporalSpan.lastSlotMs !== null) {
    summary.temporalSpan.approxHoursCovered = (summary.temporalSpan.lastSlotMs - summary.temporalSpan.firstSlotMs) / (1000 * 60 * 60);
  }

  if (records) {
    summary.totalCalibrationRecords = records.length;
    let adverseSum = 0;
    
    for (const record of records) {
      if (record.fillTsMs !== undefined) {
        if (record.dataQuality.hasMarketTradeEvidence) {
          summary.tradePrintBackedCount++;
        } else {
          summary.touchOnlyCount++;
        }
      } else {
        summary.noFillCount++;
      }

      // Checking for existence of any holdout label (using markout30s as proxy)
      if (record.markout30s !== null && record.markout30s !== undefined) {
        summary.labeledRecordCount++;
      } else {
        summary.missingLabelCount++;
      }

      if (record.adverseSelection === true) {
        adverseSum++;
      }
    }

    if (summary.labeledRecordCount > 0) {
      summary.adverseSelectionRate = adverseSum / summary.labeledRecordCount;
    }

    if (thresholds) {
      summary.readinessThresholdProgress = {
        totalRecords: { current: summary.totalCalibrationRecords, required: thresholds.minTotalRecords },
        tradePrintBacked: { current: summary.tradePrintBackedCount, required: thresholds.minTradePrintBackedRecords },
      };
    }
  }

  return summary;
}
