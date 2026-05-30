import { parseArgs } from "util";
import { spawn } from "child_process";
import { mkdirSync, existsSync, writeFileSync, readdirSync, readFileSync } from "fs";
import * as path from "path";
import { gitCommitFromEnv } from "../engine/event-store/events.ts";
import { summarizeCorpusQuality } from "../engine/replay/corpus-quality.ts";
import type { PairManifest } from "../engine/replay/pair-manifest.ts";
import { getSlug } from "../utils/slot.ts";
import {
  buildPairedCaptureArgs,
  countPairManifests,
  inspectCaptureArtifacts,
  type CaptureDirs,
} from "./capture-corpus-utils.ts";

const { values } = parseArgs({
  args: Bun.argv,
  options: {
    strategy: { type: "string", default: "fair-value-maker" },
    "rounds-per-capture": { type: "string", default: "1" },
    "target-valid-pairs": { type: "string", default: "20" },
    "max-attempts": { type: "string", default: "30" },
    "slot-offset": { type: "string", default: "1" },
    "strategy-lab-timeout-ms": { type: "string", default: "180000" },
    "capture-gap-ms": { type: "string", default: "0" },
    "capture-timeout-ms": { type: "string", default: "900000" },
    "duplicate-wait-ms": { type: "string", default: "5000" },
    "out-dir": { type: "string" },
    "pairs-dir": { type: "string", default: "data/pairs" },
    "raw-l2-dir": { type: "string", default: "data/raw-l2" },
    "invalid-pairs-dir": { type: "string" },
    variants: { type: "string", multiple: true, default: ["late-entry", "late-entry-flow-aware", "fair-value-maker"] },
    "dry-run": { type: "boolean" },
    "skip-capture": { type: "boolean" },
    "reuse-existing-pairs": { type: "string" },
    "overwrite-existing": { type: "boolean", default: false },
    "stop-after-readiness-pass": { type: "boolean", default: false },
  },
  strict: true,
  allowPositionals: true,
});

async function runProcess(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    let settled = false;
    const finish = (code: number | null, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, timedOut });
    };
    const timer = setTimeout(() => {
      console.error(`Capture timed out after ${timeoutMs}ms. Killing process tree.`);
      if (process.platform === "win32" && p.pid) {
        spawn("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "inherit" });
      } else {
        p.kill("SIGTERM");
      }
      finish(null, true);
    }, timeoutMs);
    p.on("close", (code) => finish(code, false));
    p.on("error", () => finish(null, false));
  });
}

async function waitForSlugChange(currentSlug: string, slotOffset: number, waitMs: number) {
  console.log(`Target ${currentSlug} already has capture artifacts. Waiting for the next slot...`);
  while (getSlug(slotOffset) === currentSlug) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

async function main() {
  const timestamp = Date.now();
  const outDir = values["out-dir"] || `data/corpus-runs/${timestamp}`;
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const maxAttempts = parseInt(values["max-attempts"] as string, 10);
  const targetValidPairs = parseInt(values["target-valid-pairs"] as string, 10);
  const slotOffset = parseInt(values["slot-offset"] as string, 10);
  const captureGapMs = parseInt(values["capture-gap-ms"] as string, 10);
  const captureTimeoutMs = parseInt(values["capture-timeout-ms"] as string, 10);
  const duplicateWaitMs = parseInt(values["duplicate-wait-ms"] as string, 10);
  const pairsDir = values["pairs-dir"] as string;
  const invalidPairsDir = (values["invalid-pairs-dir"] as string | undefined) ?? pairsDir;
  const dirs: CaptureDirs = {
    pairsDir,
    rawL2Dir: values["raw-l2-dir"] as string,
    invalidPairsDir,
  };
  
  let validPairs = 0;
  let invalidPairs = 0;
  let failedCaptures = 0;
  let timedOutCaptures = 0;
  let attempts = 0;
  let skippedPairs = 0;
  let skippedExisting = 0;

  const runStartedAtMs = Date.now();

  if (values["reuse-existing-pairs"]) {
    const reuseDir = values["reuse-existing-pairs"] as string;
    if (existsSync(reuseDir)) {
      const files = readdirSync(reuseDir).filter(f => f.endsWith(".pair.json"));
      for (const f of files) {
        try {
          const m = JSON.parse(readFileSync(path.join(reuseDir, f), "utf8")) as PairManifest;
          if (m.pairValidity === "valid") validPairs++;
          else invalidPairs++;
          skippedPairs++;
        } catch {}
      }
    }
  } else {
    const counts = countPairManifests(pairsDir, invalidPairsDir);
    validPairs = counts.validPairs;
    invalidPairs = counts.invalidPairs;
  }

  while (attempts < maxAttempts && validPairs < targetValidPairs) {
    console.log(`\n=== Capture Attempt ${attempts + 1} / ${maxAttempts} ===`);
    console.log(`Target: ${validPairs} / ${targetValidPairs} valid pairs`);
    const targetSlug = getSlug(slotOffset);
    const artifactStatus = inspectCaptureArtifacts(
      targetSlug,
      dirs,
      Boolean(values["overwrite-existing"]),
    );

    if (artifactStatus.shouldSkip) {
      skippedExisting++;
      skippedPairs++;
      console.log(
        `[Skip Existing] ${targetSlug}: manifest=${artifactStatus.manifestExists} rawL2=${artifactStatus.rawL2Exists} replay=${artifactStatus.replayLogExists}`,
      );
      await waitForSlugChange(targetSlug, slotOffset, duplicateWaitMs);
      continue;
    }

    attempts++;
    console.log(`Capturing slug: ${targetSlug} using slot offset ${slotOffset}`);

    if (values["dry-run"]) {
      console.log(`[Dry Run] Simulating capture...`);
      validPairs++;
    } else if (values["skip-capture"]) {
      console.log(`[Skip Capture] Skipping actual capture process...`);
    } else {
      const cmdArgs = buildPairedCaptureArgs({
        strategy: values.strategy as string,
        rounds: values["rounds-per-capture"] as string,
        slotOffset: slotOffset.toString(),
        strategyLabTimeoutMs: values["strategy-lab-timeout-ms"] as string,
        dirs,
      });
      
      const res = await runProcess("bun", cmdArgs, captureTimeoutMs);
      
      if (res.code !== 0) {
        console.error(`Capture failed with code ${res.code}`);
        failedCaptures++;
        if (res.timedOut) timedOutCaptures++;
      } else {
        const counts = countPairManifests(pairsDir, invalidPairsDir);
        validPairs = counts.validPairs;
        invalidPairs = counts.invalidPairs;
      }
    }

    if (captureGapMs > 0 && attempts < maxAttempts && validPairs < targetValidPairs) {
      console.log(`Waiting ${captureGapMs}ms before next capture...`);
      await new Promise(r => setTimeout(r, captureGapMs));
    }
  }

  const runEndedAtMs = Date.now();
  
  console.log(`\n=== Corpus Expansion Complete ===`);
  console.log(`Attempts: ${attempts}`);
  console.log(`Valid Pairs: ${validPairs}`);
  
  const summaryJsonPath = path.join(outDir, "corpus-summary.json");
  const summaryMdPath = path.join(outDir, "corpus-summary.md");

  const manifests = [];
  const manifestDirs = invalidPairsDir === pairsDir ? [pairsDir] : [pairsDir, invalidPairsDir];
  const seenManifestPaths = new Set<string>();
  for (const dir of manifestDirs) {
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter(f => f.endsWith(".pair.json"));
      for (const f of files) {
        const p = path.join(dir, f);
        if (seenManifestPaths.has(p)) continue;
        seenManifestPaths.add(p);
        manifests.push({ path: p, manifest: JSON.parse(readFileSync(p, "utf8")) });
      }
    }
  }

  const quality = summarizeCorpusQuality(manifests);

  const summary = {
    runStartedAtMs,
    runEndedAtMs,
    gitCommit: gitCommitFromEnv(),
    commands: process.argv,
    attempts,
    validPairs,
    invalidPairs,
    failedCaptures,
    timedOutCaptures,
    skippedPairs,
    skippedExisting,
    totalReplayEvents: manifests.reduce((acc, m) => acc + m.manifest.replayEventCount, 0),
    totalRawL2Events: manifests.reduce((acc, m) => acc + m.manifest.rawL2EventCount, 0),
    totalMarketTradeEvents: quality.totalRawL2TradeEvents,
    totalCalibrationRecords: 0,
    totalTradePrintBackedRecords: 0,
    variants: values.variants,
    perPairStatus: manifests.map(m => ({ slug: m.manifest.slug, valid: m.manifest.pairValidity })),
    readinessGateResult: null,
    nextRecommendedAction: validPairs >= targetValidPairs ? "Run offline calibration pipeline." : "Continue gathering data.",
  };

  writeFileSync(summaryJsonPath, JSON.stringify(summary, null, 2));

  let md = `# Corpus Expansion Summary\n`;
  md += `- Started: ${new Date(runStartedAtMs).toISOString()}\n`;
  md += `- Ended: ${new Date(runEndedAtMs).toISOString()}\n`;
  md += `- Valid Pairs: ${validPairs}\n`;
  md += `- Invalid Pairs: ${invalidPairs}\n`;
  md += `- Failed Captures: ${failedCaptures}\n`;
  md += `- Timed Out Captures: ${timedOutCaptures}\n`;
  md += `- Skipped Existing Targets: ${skippedExisting}\n`;
  md += `- Total Market Trade Events: ${summary.totalMarketTradeEvents}\n`;
  md += `- Total Raw L2 Events: ${summary.totalRawL2Events}\n`;
  md += `- Total Replay Events: ${summary.totalReplayEvents}\n`;
  md += `- Next Recommended Action: ${summary.nextRecommendedAction}\n`;
  
  writeFileSync(summaryMdPath, md);
  console.log(`Summary written to ${outDir}`);
}

main().catch(console.error);
