#!/usr/bin/env bun
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";

type LogEntry = Record<string, any>;

type CompletedMarket = {
  slug: string;
  strategyName?: string;
  pnl?: number;
  orderHistory?: Array<{
    action: "buy" | "sell";
    price: number;
    shares: number;
    fee?: number;
    tokenId?: string;
  }>;
};

type EngineState = {
  sessionPnl?: number;
  sessionLoss?: number;
  activeMarkets?: unknown[];
  completedMarkets?: CompletedMarket[];
};

type NormalizedRun = {
  filename: string;
  slug: string;
  asset: string | null;
  duration: string | null;
  strategy: string | null;
  startTime: number | null;
  endTime: number | null;
  outcome: "win" | "loss" | "breakeven" | "incomplete";
  pnl: number | null;
  spend: number;
  orderEvents: LogEntry[];
  orderHistory: CompletedMarket["orderHistory"];
  snapshotCount: number;
  tickerCount: number;
  firstPriceToBeat: number | null;
  lastPriceToBeat: number | null;
  firstGap: number | null;
  lastGap: number | null;
  firstAssetPrice: number | null;
  lastAssetPrice: number | null;
  logPath: string;
  chartPath: string | null;
  stateSource: "matched" | "missing";
  logHasResolution: boolean;
};

type Summary = {
  generatedAt: string;
  repoRoot: string;
  logsDir: string;
  statePath: string;
  sessionPnl: number | null;
  sessionLoss: number | null;
  activeMarketCount: number | null;
  runCount: number;
  runs: NormalizedRun[];
  warnings: string[];
};

function parseAllJson(text: string): LogEntry[] {
  const results: LogEntry[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === "{") {
      if (depth++ === 0) start = i;
    } else if (char === "}" && --depth === 0 && start !== -1) {
      try {
        results.push(JSON.parse(text.slice(start, i + 1)));
      } catch {
        // Skip malformed fragments; logs are append-only and may contain blanks.
      }
      start = -1;
    }
  }

  return results;
}

function parseSlug(slug: string): { asset: string | null; duration: string | null } {
  const parts = slug.split("-");
  return {
    asset: parts[0] ? parts[0].toUpperCase() : null,
    duration: parts[2] ?? null,
  };
}

function deriveOutcome(pnl: number | null): NormalizedRun["outcome"] {
  if (pnl == null) return "incomplete";
  if (pnl > 0) return "win";
  if (pnl < 0) return "loss";
  return "breakeven";
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function last<T>(items: T[]): T | undefined {
  return items[items.length - 1];
}

const analysisRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(analysisRoot, "..");
const logsDir = resolve(repoRoot, "logs");
const statePath = resolve(repoRoot, "state", "early-bird.json");
const outPath = resolve(analysisRoot, "src", "generated", "run-summary.json");

const state: EngineState = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : {};
const completedBySlug = new Map(
  (state.completedMarkets ?? []).map((market) => [market.slug, market]),
);

const warnings: string[] = [];
if (!existsSync(logsDir)) warnings.push(`logs directory missing: ${logsDir}`);
if (!existsSync(statePath)) warnings.push(`state file missing: ${statePath}`);

const logFiles = existsSync(logsDir)
  ? readdirSync(logsDir)
      .filter((file) => /^early-bird-.+\.log$/.test(file))
      .filter((file) => !/^early-bird-\d{4}-\d{2}-\d{2}/.test(file))
      .sort()
  : [];

const runs: NormalizedRun[] = [];

for (const file of logFiles) {
  const logPath = join(logsDir, file);
  const entries = parseAllJson(readFileSync(logPath, "utf8"));
  if (!entries.length) {
    warnings.push(`no JSON entries parsed from ${logPath}`);
    continue;
  }

  const slot = entries.find((entry) => entry.type === "slot" && entry.action === "start");
  const slug = String(slot?.slug ?? basename(file, ".log").replace(/^early-bird-/, ""));
  const completed = completedBySlug.get(slug);
  const resolution = entries.find((entry) => entry.type === "resolution");
  const orderEvents = entries.filter((entry) => entry.type === "order");
  const marketPrices = entries.filter((entry) => entry.type === "market_price");
  const tickers = entries.filter((entry) => entry.type === "ticker");
  const snapshots = entries.filter((entry) => entry.type === "orderbook_snapshot");

  const filledBuysSpend = orderEvents
    .filter(
      (entry) =>
        entry.action === "buy" &&
        entry.status === "filled" &&
        typeof entry.price === "number" &&
        typeof entry.shares === "number",
    )
    .reduce((sum, entry) => sum + entry.price * entry.shares, 0);

  const stateSpend = (completed?.orderHistory ?? [])
    .filter((entry) => entry.action === "buy")
    .reduce((sum, entry) => sum + entry.price * entry.shares, 0);

  const pnl = numeric(resolution?.pnl) ?? numeric(completed?.pnl);
  const { asset, duration } = parseSlug(slug);
  const firstMarketPrice = marketPrices[0];
  const lastMarketPrice = last(marketPrices);
  const firstTicker = tickers[0];
  const lastTicker = last(tickers);
  const chartPath = resolve(logsDir, file.replace(/\.log$/, ".html"));

  if (!resolution && completed) {
    warnings.push(
      `${slug}: PnL found in state but no resolution entry found in structured log`,
    );
  }
  if (!completed) warnings.push(`${slug}: no matching completed market in state`);

  runs.push({
    filename: file,
    slug,
    asset,
    duration,
    strategy: slot?.strategy ?? completed?.strategyName ?? null,
    startTime: numeric(slot?.startTime ?? entries[0]?.ts),
    endTime: numeric(slot?.endTime),
    outcome: deriveOutcome(pnl),
    pnl,
    spend: filledBuysSpend || stateSpend,
    orderEvents,
    orderHistory: completed?.orderHistory ?? [],
    snapshotCount: snapshots.length,
    tickerCount: tickers.length,
    firstPriceToBeat: numeric(firstMarketPrice?.priceToBeat),
    lastPriceToBeat: numeric(lastMarketPrice?.priceToBeat),
    firstGap: numeric(firstMarketPrice?.gap),
    lastGap: numeric(lastMarketPrice?.gap),
    firstAssetPrice: numeric(firstTicker?.assetPrice),
    lastAssetPrice: numeric(lastTicker?.assetPrice),
    logPath,
    chartPath: existsSync(chartPath) ? chartPath : null,
    stateSource: completed ? "matched" : "missing",
    logHasResolution: Boolean(resolution),
  });
}

const summary: Summary = {
  generatedAt: new Date().toISOString(),
  repoRoot,
  logsDir,
  statePath,
  sessionPnl: numeric(state.sessionPnl),
  sessionLoss: numeric(state.sessionLoss),
  activeMarketCount: Array.isArray(state.activeMarkets) ? state.activeMarkets.length : null,
  runCount: runs.length,
  runs,
  warnings,
};

mkdirSync(resolve(analysisRoot, "src", "generated"), { recursive: true });
writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n", "utf8");

console.log(`Normalized ${runs.length} run(s) -> ${outPath}`);
if (warnings.length) {
  console.log("Warnings:");
  for (const warning of warnings) console.log(`- ${warning}`);
}
