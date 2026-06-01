/**
 * FVM Profit Surface Report
 *
 * Reads FVM fill attribution JSONL and groups fills by regime buckets.
 * Outputs both markdown and JSON so humans and AI reviewers can inspect the
 * same evidence without re-running the simulation.
 *
 * Usage:
 *   bun scripts/fvm-profit-surface.ts [--in-jsonl <path>] [--out-md <path>] [--out-json <path>] [--variant <id>]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";
import type { FillAttributionRecord } from "./fvm-fill-attribution.ts";

export type BucketStats = {
  key: string;
  fillCount: number;
  totalNotional: number;
  totalSettlementPnl: number;
  avgPnlPerFill: number;
  pnlPerDollarExposed: number;
  winRate: number;
  avgMarkout5s: number | null;
  avgMarkout30s: number | null;
  adverseSelectionRate: number | null;
  maxLoss: number;
  losingSequenceCount: number;
};

export type ProfitSurfaceSections = {
  edge: BucketStats[];
  cvd: BucketStats[];
  basis: BucketStats[];
  time: BucketStats[];
  sigma: BucketStats[];
  spread: BucketStats[];
  inventory: BucketStats[];
  edgeByCvd: BucketStats[];
  timeByBasis: BucketStats[];
  inventoryBySigma: BucketStats[];
};

export type ProfitSurface = {
  generatedAt: string;
  variant: string;
  inputJsonl: string;
  summary: {
    recordCount: number;
    attributedFillCount: number;
    totalSettlementPnl: number;
    totalNotional: number;
    pnlPerDollarExposed: number | null;
    winRate: number;
  };
  sections: ProfitSurfaceSections;
  topLossBuckets: BucketStats[];
  topProfitBuckets: BucketStats[];
};

function aggregate(records: FillAttributionRecord[]): BucketStats {
  const withPnl = records.filter((r) => r.settlementPnl !== null);
  const totalPnl = withPnl.reduce((s, r) => s + (r.settlementPnl ?? 0), 0);
  const totalNotional = records.reduce((s, r) => s + r.notional, 0);
  const wins = withPnl.filter((r) => r.settlementWin === true).length;
  const maxLoss = withPnl.length > 0 ? Math.min(...withPnl.map((r) => r.settlementPnl ?? 0)) : 0;

  const m5 = records.filter((r) => r.markout5s !== null);
  const m30 = records.filter((r) => r.markout30s !== null);
  const adv = records.filter((r) => r.adverseSelection !== null);
  const losingSeq = records.filter((r) => r.sequenceEndedProfitable === false).length;

  return {
    key: "",
    fillCount: records.length,
    totalNotional,
    totalSettlementPnl: totalPnl,
    avgPnlPerFill: withPnl.length > 0 ? totalPnl / withPnl.length : 0,
    pnlPerDollarExposed: totalNotional > 0 ? totalPnl / totalNotional : 0,
    winRate: withPnl.length > 0 ? wins / withPnl.length : 0,
    avgMarkout5s: m5.length > 0 ? m5.reduce((s, r) => s + (r.markout5s ?? 0), 0) / m5.length : null,
    avgMarkout30s: m30.length > 0 ? m30.reduce((s, r) => s + (r.markout30s ?? 0), 0) / m30.length : null,
    adverseSelectionRate: adv.length > 0 ? adv.filter((r) => r.adverseSelection === true).length / adv.length : null,
    maxLoss,
    losingSequenceCount: losingSeq,
  };
}

function groupBy<T>(records: T[], keyFn: (r: T) => string | null): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const record of records) {
    const key = keyFn(record) ?? "(null)";
    const bucket = map.get(key) ?? [];
    bucket.push(record);
    map.set(key, bucket);
  }
  return map;
}

function bucketStats(records: FillAttributionRecord[], keyFn: (r: FillAttributionRecord) => string | null): BucketStats[] {
  return [...groupBy(records, keyFn).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, grouped]) => ({ ...aggregate(grouped), key }));
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function usd(n: number): string {
  return `$${n >= 0 ? "+" : ""}${n.toFixed(4)}`;
}

function fmt(n: number | null, decimals = 4): string {
  if (n === null) return "n/a";
  return n >= 0 ? `+${n.toFixed(decimals)}` : n.toFixed(decimals);
}

function renderTable(stats: BucketStats[], title: string): string {
  const header = "| Bucket | Fills | Total PnL | Avg/Fill | PnL/$ | WinRate | Avg M5s | Avg M30s | ASR | MaxLoss | LosSeq |";
  const sep = "|--------|-------|-----------|----------|-------|---------|---------|----------|-----|---------|--------|";
  const rows = stats.map((s) =>
    `| ${s.key} | ${s.fillCount} | ${usd(s.totalSettlementPnl)} | ${usd(s.avgPnlPerFill)} | ${fmt(s.pnlPerDollarExposed)} | ${pct(s.winRate)} | ${fmt(s.avgMarkout5s, 3)} | ${fmt(s.avgMarkout30s, 3)} | ${s.adverseSelectionRate !== null ? pct(s.adverseSelectionRate) : "n/a"} | ${usd(s.maxLoss)} | ${s.losingSequenceCount} |`
  ).join("\n");
  return `### ${title}\n\n${header}\n${sep}\n${rows}\n`;
}

export function buildProfitSurface(records: FillAttributionRecord[], options: {
  generatedAt?: string;
  variant?: string;
  inputJsonl?: string;
} = {}): ProfitSurface {
  const withPnl = records.filter((r) => r.settlementPnl !== null);
  const totalPnl = withPnl.reduce((s, r) => s + (r.settlementPnl ?? 0), 0);
  const totalNotional = records.reduce((s, r) => s + r.notional, 0);
  const wins = withPnl.filter((r) => r.settlementWin === true).length;

  const sections = {
    edge: bucketStats(records, (r) => r.edgeBucket),
    cvd: bucketStats(records, (r) => r.cvdBucket),
    basis: bucketStats(records, (r) => r.basisBucket),
    time: bucketStats(records, (r) => r.timeBucket),
    sigma: bucketStats(records, (r) => r.sigmaBucket),
    spread: bucketStats(records, (r) => r.spreadBucket),
    inventory: bucketStats(records, (r) => r.inventoryRegime ?? null),
    edgeByCvd: bucketStats(records, (r) => r.edgeBucket && r.cvdBucket ? `${r.edgeBucket} x ${r.cvdBucket}` : null),
    timeByBasis: bucketStats(records, (r) => r.timeBucket && r.basisBucket ? `${r.timeBucket} x ${r.basisBucket}` : null),
    inventoryBySigma: bucketStats(records, (r) => r.inventoryRegime && r.sigmaBucket ? `${r.inventoryRegime} x ${r.sigmaBucket}` : null),
  };

  const oneDimensional = [
    ...sections.edge,
    ...sections.cvd,
    ...sections.basis,
    ...sections.time,
    ...sections.sigma,
    ...sections.spread,
    ...sections.inventory,
  ];

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    variant: options.variant ?? "unknown",
    inputJsonl: options.inputJsonl ?? "",
    summary: {
      recordCount: records.length,
      attributedFillCount: withPnl.length,
      totalSettlementPnl: totalPnl,
      totalNotional,
      pnlPerDollarExposed: totalNotional > 0 ? totalPnl / totalNotional : null,
      winRate: withPnl.length > 0 ? wins / withPnl.length : 0,
    },
    sections,
    topLossBuckets: [...oneDimensional].sort((a, b) => a.totalSettlementPnl - b.totalSettlementPnl).slice(0, 10),
    topProfitBuckets: [...oneDimensional].sort((a, b) => b.totalSettlementPnl - a.totalSettlementPnl).slice(0, 10),
  };
}

export function renderProfitSurfaceMarkdown(surface: ProfitSurface): string {
  const sections: string[] = [
    `# FVM Profit Surface Report`,
    ``,
    `_Generated: ${surface.generatedAt}_`,
    ``,
    `Variant: \`${surface.variant}\``,
    ``,
    `> IMPORTANT: Per-fill PnL uses binary contract settlement payoff. This attribution is computed offline only and is never used inside strategy decisions.`,
    ``,
    `## Overall Summary`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total fills attributed | ${surface.summary.attributedFillCount} / ${surface.summary.recordCount} |`,
    `| Total settlement PnL | ${usd(surface.summary.totalSettlementPnl)} |`,
    `| Total notional exposed | ${usd(surface.summary.totalNotional)} |`,
    `| PnL per dollar exposed | ${fmt(surface.summary.pnlPerDollarExposed)} |`,
    `| Overall fill win rate | ${pct(surface.summary.winRate)} |`,
    ``,
    renderTable(surface.sections.edge, "By Edge Bucket"),
    renderTable(surface.sections.cvd, "By Side-Adjusted CVD Bucket"),
    renderTable(surface.sections.basis, "By Basis Bucket (% of anchor price)"),
    renderTable(surface.sections.time, "By Time-to-Expiry Bucket"),
    renderTable(surface.sections.sigma, "By Sigma Regime"),
    renderTable(surface.sections.spread, "By Spread Regime"),
    renderTable(surface.sections.inventory, "By Inventory Regime"),
    `## Cross-Tab: Edge x CVD`,
    renderTable(surface.sections.edgeByCvd, "Edge x CVD Cross-Tab"),
    `## Cross-Tab: Time x Basis`,
    renderTable(surface.sections.timeByBasis, "Time x Basis Cross-Tab"),
    `## Cross-Tab: Inventory Regime x Sigma`,
    renderTable(surface.sections.inventoryBySigma, "Inventory x Sigma Cross-Tab"),
    `## Top Loss Contributors (by total PnL)`,
    surface.topLossBuckets.map((s, i) =>
      `${i + 1}. **${s.key}** - ${usd(s.totalSettlementPnl)} (${s.fillCount} fills, winRate=${pct(s.winRate)})`
    ).join("\n"),
    ``,
    `## Top Profit Contributors (by total PnL)`,
    surface.topProfitBuckets.map((s, i) =>
      `${i + 1}. **${s.key}** - ${usd(s.totalSettlementPnl)} (${s.fillCount} fills, winRate=${pct(s.winRate)})`
    ).join("\n"),
    ``,
    `---`,
    `_This report identifies which regimes generate profit vs destroy bankroll._`,
  ];

  return sections.join("\n");
}

function readAttributionJsonl(inJsonl: string): FillAttributionRecord[] {
  return readFileSync(inJsonl, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FillAttributionRecord);
}

function ensureParentDir(filePath: string): void {
  const outDir = path.dirname(filePath);
  if (outDir && outDir !== "." && !existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  let inJsonl = "data/reports/fvm-fill-profit-attribution.jsonl";
  let outMd = path.join("..", "..", "AI_WORKSPACE", "FVM_PROFIT_SURFACE.md");
  let outJson = "";
  let variant = "unknown";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--in-jsonl") inJsonl = args[++i] || inJsonl;
    else if (args[i] === "--out-md") outMd = args[++i] || outMd;
    else if (args[i] === "--out-json") outJson = args[++i] || outJson;
    else if (args[i] === "--variant") variant = args[++i] || variant;
  }

  if (!existsSync(inJsonl)) {
    console.error(`Attribution file not found: ${inJsonl}`);
    console.error("Run scripts/fvm-fill-attribution.ts first.");
    process.exit(1);
  }

  const records = readAttributionJsonl(inJsonl);
  console.log(`Loaded ${records.length} attribution records.`);

  const surface = buildProfitSurface(records, { variant, inputJsonl: inJsonl });
  const md = renderProfitSurfaceMarkdown(surface);

  ensureParentDir(outMd);
  writeFileSync(outMd, md, "utf-8");
  console.log(`\nProfit surface markdown written -> ${outMd}`);

  if (outJson) {
    ensureParentDir(outJson);
    writeFileSync(outJson, JSON.stringify(surface, null, 2), "utf-8");
    console.log(`Profit surface JSON written -> ${outJson}`);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
