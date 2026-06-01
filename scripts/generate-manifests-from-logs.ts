/**
 * Generate pair manifests from existing replay logs in logs/ directory.
 * These manifests will NOT have raw L2 data, so conservative fill verification
 * won't work, but calibration math (Brier, LogLoss, ECE) will still function.
 */
import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import * as path from "path";
import type { PairManifest } from "../engine/replay/pair-manifest.ts";

const LOGS_DIR = "logs";
const PAIRS_DIR = "data/pairs";

mkdirSync(PAIRS_DIR, { recursive: true });

const existingPairs = new Set<string>();
if (existsSync(PAIRS_DIR)) {
  for (const f of readdirSync(PAIRS_DIR).filter(f => f.endsWith(".pair.json"))) {
    const m = JSON.parse(readFileSync(path.join(PAIRS_DIR, f), "utf-8")) as PairManifest;
    existingPairs.add(m.slug);
  }
}

const replayLogs = readdirSync(LOGS_DIR)
  .filter(f => f.startsWith("early-bird-btc-updown-5m-") && f.endsWith(".log"))
  .sort();

let created = 0;
let skipped = 0;

for (const logFile of replayLogs) {
  // Extract slug: early-bird-btc-updown-5m-1778891400.log -> btc-updown-5m-1778891400
  const match = logFile.match(/early-bird-(btc-updown-5m-\d+)\.log/);
  if (!match) continue;
  
  const slug = match[1]!;
  
  if (existingPairs.has(slug)) {
    skipped++;
    continue;
  }

  const logPath = path.join(LOGS_DIR, logFile);
  const content = readFileSync(logPath, "utf-8");
  const lines = content.split(/\r?\n/);
  const events = lines.filter(l => l.trim().length > 0).map((line) => JSON.parse(line));
  const eventCount = events.length;
  
  // Extract slot timing from slug
  const slotStart = parseInt(slug.split("-").pop()!, 10);
  const slotEnd = slotStart + 300; // 5 minute window
  const replayTs = events
    .map((event) => event.ts)
    .filter((ts): ts is number => typeof ts === "number");
  const replayFirstEventTsMs = replayTs.length > 0 ? Math.min(...replayTs) : null;
  const replayLastEventTsMs = replayTs.length > 0 ? Math.max(...replayTs) : null;
  const hasMarketPrice = events.some((event) => event.type === "market_price");
  const hasResolution = events.some((event) => event.type === "resolution");
  const endedBeforeMarketOpen =
    replayLastEventTsMs !== null &&
    replayLastEventTsMs < slotStart * 1000 &&
    !hasMarketPrice &&
    !hasResolution;
  const validationErrors = endedBeforeMarketOpen
    ? ["Replay ended before market open and has no terminal market price or resolution"]
    : [];

  const manifest: PairManifest = {
    slug,
    replayLogPath: logPath,
    rawL2LogPath: "", // No L2 data available
    strategy: "fair-value-maker",
    slotStartMs: slotStart * 1000,
    slotEndMs: slotEnd * 1000,
    captureStartedAtMs: slotStart * 1000,
    captureEndedAtMs: slotEnd * 1000,
    runtimeStartedAtMs: slotStart * 1000,
    runtimeEndedAtMs: slotEnd * 1000,
    recorderStartedAtMs: 0,
    recorderEndedAtMs: 0,
    runtimeExitCode: 0,
    recorderExitCode: null as any,
    recorderSignal: null,
    recorderStopReason: "unknown",
    recorderCompletedEventSeen: false,
    replayEventCount: eventCount,
    rawL2EventCount: 0,
    rawL2BookEventCount: 0,
    rawL2TradeEventCount: 0,
    replayFirstEventTsMs,
    replayLastEventTsMs,
    rawL2FirstEventTsMs: 0,
    rawL2LastEventTsMs: 0,
    coverageLeadMs: 0,
    coverageTailMs: 0,
    parseErrors: [],
    validationErrors,
    validationWarnings: ["Generated from existing replay log - no raw L2 data available"],
    coverageVerdict: "missing",
    pairValidity: validationErrors.length > 0 ? "invalid" : "valid",
    strategyLabStatus: "skipped",
    strategyLabEvidenceVerdict: "unavailable_missing_l2",
    strategyLabStartedAtMs: 0,
    strategyLabEndedAtMs: 0,
    strategyLabTimeoutMs: 120000,
    gitCommit: "local",
    commands: [`generated from ${logFile}`],
    validatedAtMs: Date.now(),
    createdAtMs: Date.now(),
  };

  const outPath = path.join(PAIRS_DIR, `${slug}.pair.json`);
  writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  created++;
}

console.log(`Generated ${created} pair manifests from existing replay logs.`);
console.log(`Skipped ${skipped} (already had manifests).`);
console.log(`Total pairs in ${PAIRS_DIR}: ${created + skipped + existingPairs.size}`);
