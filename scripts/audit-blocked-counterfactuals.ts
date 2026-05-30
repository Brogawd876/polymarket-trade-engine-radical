import { parseArgs } from "util";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "fs";
import * as path from "path";
import { type ProfitEventEnvelope, type StrategyPayload, type SettlementPayload } from "../engine/event-store/events.ts";
import { type PairManifest } from "../engine/replay/pair-manifest.ts";
import { evaluateBlockedIntent, deduplicateBlockedRecords, type BlockedCounterfactualRecord } from "../engine/replay/blocked-counterfactual.ts";
import { extractClobTokenIdsFromRawL2 } from "../engine/replay/paired-token-mapping.ts";


async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "pairs-dir": { type: "string", default: "data/pairs" },
      "pair": { type: "string" },
      "out-json": { type: "string", default: "data/reports/blocked-counterfactuals.json" },
      "out-md": { type: "string", default: "data/reports/blocked-counterfactuals.md" },
      "variants": { type: "string", multiple: true, default: ["late-entry", "late-entry-flow-aware", "fair-value-maker"] },
      "dedupe-window-ms": { type: "string", default: "1000" },
      "include-raw-records": { type: "boolean", default: false },
      "allow-contaminated": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const pairsDir = values["pairs-dir"] as string;
  const outJson = values["out-json"] as string;
  const outMd = values["out-md"] as string;
  const dedupeWindowMs = parseInt(values["dedupe-window-ms"] as string, 10);
  const allowContaminated = values["allow-contaminated"] as boolean;

  if (!existsSync(path.dirname(outJson))) mkdirSync(path.dirname(outJson), { recursive: true });
  if (!existsSync(path.dirname(outMd))) mkdirSync(path.dirname(outMd), { recursive: true });

  const manifests: PairManifest[] = [];
  if (values.pair) {
    const p = path.join(pairsDir, `${values.pair}.pair.json`);
    if (existsSync(p)) {
      manifests.push(JSON.parse(readFileSync(p, "utf8")));
    }
  } else if (existsSync(pairsDir)) {
    const files = readdirSync(pairsDir).filter(f => f.endsWith(".pair.json"));
    for (const f of files) {
      manifests.push(JSON.parse(readFileSync(path.join(pairsDir, f), "utf8")));
    }
  }

  const validManifests = manifests.filter(m => m.pairValidity === "valid");
  console.log(`Loaded ${validManifests.length} valid pairs.`);

  console.log("Indexing event files...");
  const eventsDir = "logs/events";
  const slugToEventFiles = new Map<string, string[]>();
  
  // Robust scanning: read enough lines to definitely find the slug, or parse the first few
  if (existsSync(eventsDir)) {
    const runDirs = readdirSync(eventsDir);
    for (const runDir of runDirs) {
      const eventFile = path.join(eventsDir, runDir, "events.ndjson");
      if (!existsSync(eventFile)) continue;
      
      const lines = readFileSync(eventFile, "utf8").split("\n").slice(0, 50);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.slug) {
            if (!slugToEventFiles.has(ev.slug)) slugToEventFiles.set(ev.slug, []);
            slugToEventFiles.get(ev.slug)!.push(eventFile);
            break;
          }
        } catch (e) {}
      }
    }
  }

  const allRecords: BlockedCounterfactualRecord[] = [];
  const runDiagnostics: any[] = [];

  for (const manifest of validManifests) {
    const diagnostic: any = {
      slug: manifest.slug,
      replayLogPath: manifest.replayLogPath,
      rawL2LogPath: manifest.rawL2LogPath,
      eventFilesUsed: [],
      runIdsUsed: [],
      strategyIdsDetected: [],
      skippedEventFiles: [],
      duplicateRunWarnings: [],
      contaminated: false,
    };

    const eventFiles = slugToEventFiles.get(manifest.slug) ?? [];

    if (eventFiles.length === 0) {
      console.warn(`No event logs found for ${manifest.slug}`);
      runDiagnostics.push(diagnostic);
      continue;
    }

    if (eventFiles.length > 1) {
      diagnostic.duplicateRunWarnings.push(`Found ${eventFiles.length} runs. This may indicate contaminated data from multiple strategy lab runs without cleanup.`);
      diagnostic.contaminated = true;
    }

    if (diagnostic.contaminated && !allowContaminated) {
      runDiagnostics.push(diagnostic);
      console.warn(`Skipping contaminated pair ${manifest.slug} (use --allow-contaminated to include)`);
      continue;
    }

    console.log(`Processing ${manifest.slug} (${eventFiles.length} runs)...`);
    
    // Load Raw L2 events once per manifest
    const l2Events: ProfitEventEnvelope[] = [];
    let l2FilePath = manifest.rawL2LogPath;
    if (!existsSync(l2FilePath)) {
       const altPath = path.join("..", "..", manifest.rawL2LogPath);
       if (existsSync(altPath)) l2FilePath = altPath;
    }

    let tokenMapping: { upTokenId: string; downTokenId: string } | undefined;
    if (existsSync(l2FilePath)) {
      l2Events.push(...readFileSync(l2FilePath, "utf8")
        .split("\n")
        .filter(l => l.trim())
        .map(l => JSON.parse(l)));
      
      const mappingResult = extractClobTokenIdsFromRawL2(l2FilePath);
      if (mappingResult.status === "ok") {
        tokenMapping = {
          upTokenId: mappingResult.tokenIds[0],
          downTokenId: mappingResult.tokenIds[1],
        };
      }
    }

    for (const eventFile of eventFiles) {
      diagnostic.eventFilesUsed.push(eventFile);
      const botEvents: ProfitEventEnvelope[] = readFileSync(eventFile, "utf8")
        .split("\n")
        .filter(l => l.trim())
        .map(l => JSON.parse(l));

      const runIds = new Set<string>();
      const strategyIds = new Set<string>();

      for (const ev of botEvents) {
        if (ev.runId) runIds.add(ev.runId);
        if (ev.strategyId) strategyIds.add(ev.strategyId);
      }

      diagnostic.runIdsUsed.push(...Array.from(runIds));
      for (const s of strategyIds) {
        if (!diagnostic.strategyIdsDetected.includes(s)) diagnostic.strategyIdsDetected.push(s);
      }

      diagnostic.predictiveDisagreementMismatchCount = diagnostic.predictiveDisagreementMismatchCount || 0;
      diagnostic.unmatchedBlockedDecisionCount = diagnostic.unmatchedBlockedDecisionCount || 0;
      diagnostic.unmatchedBlockedDecisionIds = diagnostic.unmatchedBlockedDecisionIds || [];

      const allEventsForRun = [...botEvents, ...l2Events].sort((a, b) => a.processedTsMs - b.processedTsMs);

      // 2. Extract blocked intents
      const intentsByIntentId = new Map<string, ProfitEventEnvelope<StrategyPayload>>();
      const decisionsByIntentId = new Map<string, ProfitEventEnvelope<StrategyPayload>>();
      let settlement: SettlementPayload | null = null;
      let slotEndMs: number | null = manifest.slotEndMs;

      // Extract predictives and quant for state
      // (State is now pulled directly from the risk gate decision feature payload)

      for (const event of allEventsForRun) {
        if (event.eventType === "order_intent") {
          const payload = event.payload as any;
          if (payload.intentId) intentsByIntentId.set(payload.intentId, event as any);
        } else if (event.eventType === "risk_gate_decision") {
          const payload = event.payload as any;
          if (payload.intent?.id) decisionsByIntentId.set(payload.intent.id, event as any);
        } else if (event.eventType === "settlement_result") {
          settlement = event.payload as SettlementPayload;
        }
      }

      const blockedIntentIds = [...decisionsByIntentId.entries()]
        .filter(([_, ev]) => !ev.payload.approved)
        .map(([id, _]) => id);

      for (const intentId of blockedIntentIds) {
        const intentEvent = intentsByIntentId.get(intentId);
        const decisionEvent = decisionsByIntentId.get(intentId);
        if (intentEvent && decisionEvent) {
          const record = evaluateBlockedIntent(intentEvent, decisionEvent, allEventsForRun, settlement, { tokenMapping });
          
          // Annotate with predictive/quant states and time to close
          const ts = record.timestampMs;
          if (slotEndMs) {
             (record as any).timeToCloseSecs = (slotEndMs - ts) / 1000;
          }
          // Extract states directly from the risk gate decision feature snapshot
          let diag = false;
          let sig = null;
          const pFeeds = (decisionEvent.payload as any).decisionFeature?.feeds;
          const pQuant = (decisionEvent.payload as any).decisionFeature?.quant;
          if (pFeeds && typeof pFeeds.predictiveDisagreement === "boolean") {
            diag = pFeeds.predictiveDisagreement;
          }
          if (pQuant && typeof pQuant.sigma === "number") {
            sig = pQuant.sigma;
          }
          (record as any).predictiveDisagreement = diag;
          (record as any).sigma = sig;

          if (record.reasons.some(r => r.includes("predictive aggregate disagreement is true")) && diag !== true) {
            diagnostic.predictiveDisagreementMismatchCount++;
          }

          allRecords.push(record);
        } else if (!intentEvent) {
          diagnostic.unmatchedBlockedDecisionCount++;
          if (diagnostic.unmatchedBlockedDecisionIds.length < 10) {
            diagnostic.unmatchedBlockedDecisionIds.push(intentId);
          }
        }
      }
    }

    runDiagnostics.push(diagnostic);
  }

  // 3. Deduplicate
  const processedRecords = deduplicateBlockedRecords(allRecords, dedupeWindowMs);

  // 4. Summarize
  const summary = summarizeRecords(processedRecords, runDiagnostics, allowContaminated);

  // 5. Write reports
  if (values["include-raw-records"]) {
    writeFileSync(outJson, JSON.stringify({ summary, records: processedRecords }, null, 2));
  } else {
    writeFileSync(outJson, JSON.stringify({ summary }, null, 2));
  }

  const mdReport = generateMarkdownReport(summary);
  writeFileSync(outMd, mdReport);

  console.log(`\nAudit complete.`);
  console.log(`Total blocked intents: ${allRecords.length}`);
  console.log(`Unique blocked intents: ${processedRecords.filter(r => r.duplicateVerdict === "unique").length}`);
  console.log(`JSON report: ${outJson}`);
  console.log(`Markdown report: ${outMd}`);
}

export function summarizeRecords(records: BlockedCounterfactualRecord[], runDiagnostics: any[], allowContaminated: boolean = false) {
  const strategies = [...new Set(records.map(r => r.strategy))];
  const byStrategy: Record<string, any> = {};

  const byBlockReason: Record<string, { blockedCount: number; uniqueCount: number }> = {};
  const bySide: Record<string, { blockedCount: number; uniqueCount: number }> = { UP: { blockedCount: 0, uniqueCount: 0 }, DOWN: { blockedCount: 0, uniqueCount: 0 } };
  const byFillEvidence: Record<string, { blockedCount: number; uniqueCount: number }> = {};
  const byUnavailableReason: Record<string, { blockedCount: number; uniqueCount: number }> = {};
  const byTimeToCloseBucket: Record<string, { blockedCount: number; uniqueCount: number }> = {};
  const byPredictiveDisagreementState: Record<string, { blockedCount: number; uniqueCount: number }> = { "true": { blockedCount: 0, uniqueCount: 0 }, "false": { blockedCount: 0, uniqueCount: 0 }, "unknown": { blockedCount: 0, uniqueCount: 0 } };
  const byVolatilityBucket: Record<string, { blockedCount: number; uniqueCount: number }> = { "low": { blockedCount: 0, uniqueCount: 0 }, "medium": { blockedCount: 0, uniqueCount: 0 }, "high": { blockedCount: 0, uniqueCount: 0 }, "unknown": { blockedCount: 0, uniqueCount: 0 } };

  for (const record of records) {
    const isUnique = record.duplicateVerdict === "unique";

    // Block Reason (just use the first reason or aggregate)
    const reasonStr = record.reasons.join("|") || "unknown";
    if (!byBlockReason[reasonStr]) byBlockReason[reasonStr] = { blockedCount: 0, uniqueCount: 0 };
    byBlockReason[reasonStr].blockedCount++;
    if (isUnique) byBlockReason[reasonStr].uniqueCount++;

    // Side
    if (record.side) {
      if (!bySide[record.side]) bySide[record.side] = { blockedCount: 0, uniqueCount: 0 };
      bySide[record.side]!.blockedCount++;
      if (isUnique) bySide[record.side]!.uniqueCount++;
    }

    // Fill Evidence
    if (!byFillEvidence[record.fillEvidence]) byFillEvidence[record.fillEvidence] = { blockedCount: 0, uniqueCount: 0 };
    byFillEvidence[record.fillEvidence]!.blockedCount++;
    if (isUnique) byFillEvidence[record.fillEvidence]!.uniqueCount++;

    // Unavailable Reasons
    if (record.unavailableReasons.length > 0) {
      for (const uReasonStr of record.unavailableReasons) {
        if (!byUnavailableReason[uReasonStr]) byUnavailableReason[uReasonStr] = { blockedCount: 0, uniqueCount: 0 };
        byUnavailableReason[uReasonStr].blockedCount++;
        if (isUnique) byUnavailableReason[uReasonStr].uniqueCount++;
      }
    }

    // Time to Close
    const ttc = (record as any).timeToCloseSecs;
    let ttcBucket = "unknown";
    if (typeof ttc === "number") {
       if (ttc < 15) ttcBucket = "0-15s";
       else if (ttc < 30) ttcBucket = "15-30s";
       else if (ttc < 60) ttcBucket = "30-60s";
       else if (ttc < 120) ttcBucket = "60-120s";
       else ttcBucket = "120s+";
    }
    if (!byTimeToCloseBucket[ttcBucket]) byTimeToCloseBucket[ttcBucket] = { blockedCount: 0, uniqueCount: 0 };
    byTimeToCloseBucket[ttcBucket]!.blockedCount++;
    if (isUnique) byTimeToCloseBucket[ttcBucket]!.uniqueCount++;

    // Predictive Disagreement
    const diag = (record as any).predictiveDisagreement;
    let diagBucket = "unknown";
    if (diag === true) diagBucket = "true";
    if (diag === false) diagBucket = "false";
    byPredictiveDisagreementState[diagBucket]!.blockedCount++;
    if (isUnique) byPredictiveDisagreementState[diagBucket]!.uniqueCount++;

    // Volatility
    const sig = (record as any).sigma;
    let sigBucket = "unknown";
    if (typeof sig === "number") {
       if (sig < 0.2) sigBucket = "low";
       else if (sig < 0.6) sigBucket = "medium";
       else sigBucket = "high";
    }
    byVolatilityBucket[sigBucket]!.blockedCount++;
    if (isUnique) byVolatilityBucket[sigBucket]!.uniqueCount++;
  }

  for (const strat of strategies) {
    if (!strat) continue;
    const sRecords = records.filter(r => r.strategy === strat);
    const unique = sRecords.filter(r => r.duplicateVerdict === "unique");
    
    byStrategy[strat] = {
      blockedCount: sRecords.length,
      uniqueBlockedCount: unique.length,
      wouldFillCount: unique.filter(r => r.wouldFill).length,
      verdicts: {
        good_block: unique.filter(r => r.verdict === "good_block").length,
        bad_block: unique.filter(r => r.verdict === "bad_block").length,
        blocked_but_no_fill: unique.filter(r => r.verdict === "blocked_but_no_fill").length,
        unrealistic_duplicate: unique.filter(r => r.verdict === "unrealistic_duplicate").length,
        inconclusive: unique.filter(r => r.verdict === "inconclusive").length,
      },
      avgMarkout5s: average(unique.map(r => r.markout5s)),
      avgHypotheticalPnl: average(unique.map(r => r.hypotheticalPnl)),
    };
  }

  let totalUnmatchedBlockedDecisionCount = 0;
  let totalPredictiveDisagreementMismatchCount = 0;
  for (const diag of runDiagnostics) {
    totalUnmatchedBlockedDecisionCount += diag.unmatchedBlockedDecisionCount || 0;
    totalPredictiveDisagreementMismatchCount += diag.predictiveDisagreementMismatchCount || 0;
  }

  return {
    totalBlocked: records.length,
    totalUnique: records.filter(r => r.duplicateVerdict === "unique").length,
    totalUnmatchedBlockedDecisionCount,
    totalPredictiveDisagreementMismatchCount,
    allowContaminatedUsed: allowContaminated,
    byStrategy,
    byBlockReason,
    bySide,
    byTimeToCloseBucket,
    byPredictiveDisagreementState,
    byVolatilityBucket,
    byFillEvidence,
    byUnavailableReason,
    runDiagnostics,
  };
}

function average(vals: (number | null)[]): number | null {
  const filtered = vals.filter((v): v is number => v !== null);
  if (filtered.length === 0) return null;
  return filtered.reduce((a, b) => a + b, 0) / filtered.length;
}

export function generateMarkdownReport(summary: any): string {
  let md = `# Blocked Counterfactual Audit\n\n`;
  md += `> **Warning:** Diagnostic-only replay report. This does not imply proof of profitability, paper readiness, or definitive risk-gate correctness. Missing raw L2 data, ambiguous fill evidence, duplicate intents, and wallet/inventory uncertainty are preserved as inconclusive rather than fabricated.\n\n`;

  const contaminatedRuns = summary.runDiagnostics.filter((d: any) => d.contaminated).length;
  if (contaminatedRuns > 0) {
    if (summary.allowContaminatedUsed) {
      md += `> **WARNING:** Detected ${contaminatedRuns} contaminated pairs (multiple runs found for the same slug). These contaminated results are directional evidence only.\n\n`;
    } else {
      md += `> **WARNING:** Detected ${contaminatedRuns} contaminated pairs. They were skipped from the summary.\n\n`;
    }
  }

  md += `## Global Summary\n`;
  md += `- **Total Blocked Intents:** ${summary.totalBlocked}\n`;
  md += `- **Unique Blocked Intents:** ${summary.totalUnique}\n`;
  md += `- **Unmatched Blocked Decisions:** ${summary.totalUnmatchedBlockedDecisionCount}\n`;
  if (summary.totalUnmatchedBlockedDecisionCount > 0) {
    const samples = summary.runDiagnostics.flatMap((d: any) => d.unmatchedBlockedDecisionIds || []).slice(0, 10);
    md += `  - Sample IDs: ${samples.join(", ")}\n`;
  }
  md += `- **Predictive Disagreement State Mismatches:** ${summary.totalPredictiveDisagreementMismatchCount}\n\n`;
  if (summary.totalPredictiveDisagreementMismatchCount > 0) {
    md += `> **WARNING:** Predictive disagreement state mismatches detected. Do not use byPredictiveDisagreementState as evidence of predictive-disagreement gate quality until resolved.\n\n`;
  }

  md += `## By Strategy\n\n`;
  md += `| Strategy | Blocked | Unique | Would Fill | Good Block | Bad Block | No Fill | Inconclusive | Avg PnL |\n`;
  md += `| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |\n`;

  for (const [name, s] of Object.entries(summary.byStrategy)) {
    const strat = s as any;
    md += `| ${name} | ${strat.blockedCount} | ${strat.uniqueBlockedCount} | ${strat.wouldFillCount} | ${strat.verdicts.good_block} | ${strat.verdicts.bad_block} | ${strat.verdicts.blocked_but_no_fill} | ${strat.verdicts.inconclusive} | ${strat.avgHypotheticalPnl?.toFixed(4) ?? "N/A"} |\n`;
  }

  md += `\n## By Fill Evidence\n\n`;
  for (const [name, stats] of Object.entries(summary.byFillEvidence)) {
    const s = stats as any;
    md += `- **${name}:** ${s.blockedCount} (Unique: ${s.uniqueCount})\n`;
  }

  md += `\n## By Side\n\n`;
  for (const [name, stats] of Object.entries(summary.bySide)) {
    const s = stats as any;
    md += `- **${name}:** ${s.blockedCount} (Unique: ${s.uniqueCount})\n`;
  }

  md += `\n## By Block Reason\n\n`;
  for (const [name, stats] of Object.entries(summary.byBlockReason)) {
    const s = stats as any;
    md += `- **${name}:** ${s.blockedCount} (Unique: ${s.uniqueCount})\n`;
  }

  md += `\n## By Time To Close\n\n`;
  for (const [name, stats] of Object.entries(summary.byTimeToCloseBucket)) {
    const s = stats as any;
    md += `- **${name}:** ${s.blockedCount} (Unique: ${s.uniqueCount})\n`;
  }

  md += `\n## By Predictive Disagreement\n\n`;
  for (const [name, stats] of Object.entries(summary.byPredictiveDisagreementState)) {
    const s = stats as any;
    md += `- **${name}:** ${s.blockedCount} (Unique: ${s.uniqueCount})\n`;
  }

  md += `\n## By Unavailable Reason\n\n`;
  for (const [name, stats] of Object.entries(summary.byUnavailableReason)) {
    const s = stats as any;
    md += `- **${name}:** ${s.blockedCount} (Unique: ${s.uniqueCount})\n`;
  }

  return md;
}

if (import.meta.main) {
  main().catch(console.error);
}
