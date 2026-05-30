import { type PairManifest } from "../engine/replay/pair-manifest.ts";

export interface PairedCorpusSummary {
  totalCaptures: number;
  validPairs: number;
  invalidPairs: number;
  skippedPairs: number;
  malformedPairs: number;
  completeCoverage: number;
  incompleteCoverage: number;
  usableEvidence: number;
  noFills: number;
  insufficientData: number;
  missingMapping: number;
  failedSL: number;
  manifests: PairManifest[];
  runnerStatus?: "completed" | "timed_out" | "failed" | "not_run";
  runnerCompletedRuns?: number;
  runnerTotalRuns?: number;
}

export function summarizePairManifests(manifests: PairManifest[]): PairedCorpusSummary {
  const summary: PairedCorpusSummary = {
    totalCaptures: manifests.length,
    validPairs: 0,
    invalidPairs: 0,
    skippedPairs: 0,
    malformedPairs: 0,
    completeCoverage: 0,
    incompleteCoverage: 0,
    usableEvidence: 0,
    noFills: 0,
    insufficientData: 0,
    missingMapping: 0,
    failedSL: 0,
    manifests,
    runnerStatus: "not_run",
  };

  for (const m of manifests) {
    if (!m) {
      summary.malformedPairs++;
      continue;
    }

    if (m.pairValidity === undefined) {
      summary.skippedPairs++;
      continue; // Do not aggregate evidence verdicts for skipped pairs
    }

    if (m.pairValidity === "valid") {
      summary.validPairs++;
      if (m.coverageVerdict === "complete") summary.completeCoverage++;
      else summary.incompleteCoverage++;

      switch (m.strategyLabEvidenceVerdict) {
        case "usable": summary.usableEvidence++; break;
        case "unavailable_no_fills": summary.noFills++; break;
        case "unavailable_insufficient_data": summary.insufficientData++; break;
        case "unavailable_missing_mapping": summary.missingMapping++; break;
        default: summary.failedSL++; break;
      }
    } else {
      summary.invalidPairs++;
    }
  }

  return summary;
}

export function formatPairedCorpusReport(summary: PairedCorpusSummary): string {
  const md = [
    `# Phase 8G Paired Corpus Report`,
    ``,
    `## Aggregate Counts`,
    `- **Total manifests scanned:** ${summary.totalCaptures}`,
    `- **Valid pairs:** ${summary.validPairs}`,
    `- **Invalid pairs:** ${summary.invalidPairs}`,
    `- **Skipped old-schema pairs:** ${summary.skippedPairs}`,
    `- **Malformed pairs:** ${summary.malformedPairs}`,
    ``,
    `## Valid Pairs Evidence Verdicts`,
    `- **Complete coverage count:** ${summary.completeCoverage}`,
    `- **Partial/Missing/Unknown coverage count:** ${summary.incompleteCoverage}`,
    `- **Usable evidence count:** ${summary.usableEvidence}`,
    `- **Unavailable (No Fills) count:** ${summary.noFills}`,
    `- **Unavailable (Insufficient Data) count:** ${summary.insufficientData}`,
    `- **Unavailable (Missing Mapping) count:** ${summary.missingMapping}`,
    `- **Failed SL Evaluation count:** ${summary.failedSL}`,
    ``,
    `## Strategy Lab Paired-Corpus Runner`,
    `- **Status:** ${summary.runnerStatus}`,
  ];

  if (summary.runnerStatus === "timed_out" && summary.runnerTotalRuns) {
    md.push(`- **Progress:** ${summary.runnerCompletedRuns} / ${summary.runnerTotalRuns} runs completed before timeout`);
  } else if (summary.runnerTotalRuns) {
    md.push(`- **Progress:** ${summary.runnerCompletedRuns} / ${summary.runnerTotalRuns} runs completed`);
  }

  md.push(
    ``,
    `## Corpus Summary Table`,
    ``,
    `| Slug | Strategy | Validity | Coverage | SL Verdict | Replay Ev | L2 Ev (Book/Trade) | Errors/Warnings |`,
    `|------|----------|----------|----------|------------|-----------|---------------------|-----------------|`
  );

  for (const m of summary.manifests) {
    if (!m) continue;
    md.push(`| ${m.slug ?? "unknown"} | ${m.strategy ?? "unknown"} | ${m.pairValidity ?? "undefined"} | ${m.coverageVerdict ?? "unknown"} | ${m.strategyLabEvidenceVerdict ?? "unknown"} | ${m.replayEventCount ?? 0} | ${m.rawL2EventCount ?? 0} (${m.rawL2BookEventCount ?? 0}/${m.rawL2TradeEventCount ?? 0}) | ${(m.parseErrors?.length ?? 0) + (m.validationErrors?.length ?? 0)} / ${m.validationWarnings?.length ?? 0} |`);
  }

  md.push(``, `## Interpretation`);
  md.push(`- **What the corpus proves:** The evaluation plumbing works correctly to pair live shadows with L2 data.`);
  md.push(`- **What it does not prove:** Any profitability claim. We are still establishing the data foundation.`);
  md.push(`- **Data missing:** We need to ensure strategies are actually taking trades so we have sufficient usable evidence for markout reporting.`);
  
  md.push(``, `## Next Recommendation`);
  md.push(`Proceed to run Strategy Lab paired corpus batch over these generated datasets, or capture more if usable evidence is low.`);

  return md.join("\n");
}

export function shouldTimeout(startMs: number, timeoutMs: number): boolean {
  return Date.now() - startMs > timeoutMs;
}
