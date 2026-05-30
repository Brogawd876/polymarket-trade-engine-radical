/**
 * FVM Profit Surface Report
 *
 * Reads fvm-fill-profit-attribution.jsonl and groups fills by regime buckets.
 * Outputs a markdown profit surface showing which conditions make money vs destroy it.
 *
 * Usage:
 *   npx tsx scripts/fvm-profit-surface.ts [--in-jsonl <path>] [--out-md <path>]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import * as path from "path";
import type { FillAttributionRecord } from "./fvm-fill-attribution.ts";

// ── Types ──────────────────────────────────────────────────────────────────────

type BucketStats = {
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

// ── Aggregation helpers ────────────────────────────────────────────────────────

function aggregate(records: FillAttributionRecord[]): BucketStats {
  const withPnl = records.filter(r => r.settlementPnl !== null);
  const totalPnl = withPnl.reduce((s, r) => s + (r.settlementPnl ?? 0), 0);
  const totalNotional = records.reduce((s, r) => s + r.notional, 0);
  const wins = withPnl.filter(r => r.settlementWin === true).length;
  const maxLoss = withPnl.length > 0 ? Math.min(...withPnl.map(r => r.settlementPnl ?? 0)) : 0;

  const m5 = records.filter(r => r.markout5s !== null);
  const m30 = records.filter(r => r.markout30s !== null);
  const adv = records.filter(r => r.adverseSelection !== null);
  const losingSeq = records.filter(r => r.sequenceEndedProfitable === false).length;

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
    adverseSelectionRate: adv.length > 0 ? adv.filter(r => r.adverseSelection === true).length / adv.length : null,
    maxLoss,
    losingSequenceCount: losingSeq,
  };
}

function groupBy<T>(
  records: T[],
  keyFn: (r: T) => string | null,
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const r of records) {
    const k = keyFn(r) ?? "(null)";
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  return map;
}

function pct(n: number) { return `${(n * 100).toFixed(1)}%`; }
function usd(n: number) { return `$${n >= 0 ? "+" : ""}${n.toFixed(4)}`; }
function fmt(n: number | null, decimals = 4) {
  if (n === null) return "n/a";
  return n >= 0 ? `+${n.toFixed(decimals)}` : n.toFixed(decimals);
}

function renderTable(stats: BucketStats[], title: string): string {
  const header = `| Bucket | Fills | Total PnL | Avg/Fill | PnL/$ | WinRate | Avg M5s | Avg M30s | ASR | MaxLoss | LosSeq |`;
  const sep =    `|--------|-------|-----------|----------|-------|---------|---------|----------|-----|---------|--------|`;
  const rows = stats.map(s =>
    `| ${s.key} | ${s.fillCount} | ${usd(s.totalSettlementPnl)} | ${usd(s.avgPnlPerFill)} | ${fmt(s.pnlPerDollarExposed)} | ${pct(s.winRate)} | ${fmt(s.avgMarkout5s, 3)} | ${fmt(s.avgMarkout30s, 3)} | ${s.adverseSelectionRate !== null ? pct(s.adverseSelectionRate) : "n/a"} | ${usd(s.maxLoss)} | ${s.losingSequenceCount} |`
  ).join("\n");
  return `### ${title}\n\n${header}\n${sep}\n${rows}\n`;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let inJsonl = "data/reports/fvm-fill-profit-attribution.jsonl";
  let outMd = path.join("..", "..", "AI_WORKSPACE", "FVM_PROFIT_SURFACE.md");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--in-jsonl") inJsonl = args[++i] || inJsonl;
    else if (args[i] === "--out-md") outMd = args[++i] || outMd;
  }

  if (!existsSync(inJsonl)) {
    console.error(`Attribution file not found: ${inJsonl}`);
    console.error("Run scripts/fvm-fill-attribution.ts first.");
    process.exit(1);
  }

  const lines = readFileSync(inJsonl, "utf-8").split("\n").filter(Boolean);
  const records: FillAttributionRecord[] = lines.map(l => JSON.parse(l));
  console.log(`Loaded ${records.length} attribution records.`);

  const withPnl = records.filter(r => r.settlementPnl !== null);
  const totalPnl = withPnl.reduce((s, r) => s + (r.settlementPnl ?? 0), 0);
  const totalNotional = records.reduce((s, r) => s + r.notional, 0);
  const wins = withPnl.filter(r => r.settlementWin === true).length;
  const now = new Date().toISOString();

  const sections: string[] = [
    `# FVM v1.1.0 Profit Surface Report`,
    `\n_Generated: ${now}_`,
    `\n> **IMPORTANT**: Per-fill PnL uses binary contract settlement payoff: \`pnl = shares × ((settled ? 1 : 0) – price)\`  `,
    `> This attribution is computed offline only and is NEVER used inside strategy decisions.`,
    `\n## Overall Summary`,
    `\n| Metric | Value |`,
    `|--------|-------|`,
    `| Total fills attributed | ${withPnl.length} / ${records.length} |`,
    `| Total settlement PnL | ${usd(totalPnl)} |`,
    `| Total notional exposed | ${usd(totalNotional)} |`,
    `| PnL per dollar exposed | ${fmt(totalNotional > 0 ? totalPnl / totalNotional : null)} |`,
    `| Overall fill win rate | ${pct(withPnl.length > 0 ? wins / withPnl.length : 0)} |`,
    ``,
  ];

  // ── 1-D bucket breakdowns ──────────────────────────────────────────────────

  const edgeGroups = groupBy(records, r => r.edgeBucket);
  const edgeStats: BucketStats[] = [...edgeGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, recs]) => ({ ...aggregate(recs), key: k }));
  sections.push(renderTable(edgeStats, "By Edge Bucket"));

  const cvdGroups = groupBy(records, r => r.cvdBucket);
  const cvdStats: BucketStats[] = [...cvdGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, recs]) => ({ ...aggregate(recs), key: k }));
  sections.push(renderTable(cvdStats, "By Side-Adjusted CVD Bucket"));

  const basisGroups = groupBy(records, r => r.basisBucket);
  const basisStats: BucketStats[] = [...basisGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, recs]) => ({ ...aggregate(recs), key: k }));
  sections.push(renderTable(basisStats, "By Basis Bucket (% of anchor price)"));

  const timeGroups = groupBy(records, r => r.timeBucket);
  const timeStats: BucketStats[] = [...timeGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, recs]) => ({ ...aggregate(recs), key: k }));
  sections.push(renderTable(timeStats, "By Time-to-Expiry Bucket"));

  const sigmaGroups = groupBy(records, r => r.sigmaBucket);
  const sigmaStats: BucketStats[] = [...sigmaGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, recs]) => ({ ...aggregate(recs), key: k }));
  sections.push(renderTable(sigmaStats, "By Sigma Regime"));

  const spreadGroups = groupBy(records, r => r.spreadBucket);
  const spreadStats: BucketStats[] = [...spreadGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, recs]) => ({ ...aggregate(recs), key: k }));
  sections.push(renderTable(spreadStats, "By Spread Regime"));

  const invGroups = groupBy(records, r => r.inventoryRegime ?? null);
  const invStats: BucketStats[] = [...invGroups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, recs]) => ({ ...aggregate(recs), key: k }));
  sections.push(renderTable(invStats, "By Inventory Regime"));

  // ── 2-D cross-tabs ─────────────────────────────────────────────────────────

  sections.push(`## Cross-Tab: Edge × CVD`);
  const edgeVsCvd = groupBy(records, r =>
    r.edgeBucket && r.cvdBucket ? `${r.edgeBucket} × ${r.cvdBucket}` : null
  );
  const edgeVsCvdStats: BucketStats[] = [...edgeVsCvd.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, recs]) => ({ ...aggregate(recs), key: k }));
  sections.push(renderTable(edgeVsCvdStats, "Edge × CVD Cross-Tab"));

  sections.push(`## Cross-Tab: Time × Basis`);
  const timeVsBasis = groupBy(records, r =>
    r.timeBucket && r.basisBucket ? `${r.timeBucket} × ${r.basisBucket}` : null
  );
  const timeVsBasisStats: BucketStats[] = [...timeVsBasis.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, recs]) => ({ ...aggregate(recs), key: k }));
  sections.push(renderTable(timeVsBasisStats, "Time × Basis Cross-Tab"));

  sections.push(`## Cross-Tab: Inventory Regime × Sigma`);
  const invVsSigma = groupBy(records, r =>
    r.inventoryRegime && r.sigmaBucket ? `${r.inventoryRegime} × ${r.sigmaBucket}` : null
  );
  const invVsSigmaStats: BucketStats[] = [...invVsSigma.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, recs]) => ({ ...aggregate(recs), key: k }));
  sections.push(renderTable(invVsSigmaStats, "Inventory × Sigma Cross-Tab"));

  // ── Top loss contributors ──────────────────────────────────────────────────

  const topLossBuckets = [...edgeStats, ...cvdStats, ...basisStats]
    .sort((a, b) => a.totalSettlementPnl - b.totalSettlementPnl)
    .slice(0, 10);
  const topWinBuckets = [...edgeStats, ...cvdStats, ...basisStats]
    .sort((a, b) => b.totalSettlementPnl - a.totalSettlementPnl)
    .slice(0, 10);

  sections.push(`## Top Loss Contributors (by total PnL)\n`);
  sections.push(topLossBuckets.map((s, i) =>
    `${i + 1}. **${s.key}** — ${usd(s.totalSettlementPnl)} (${s.fillCount} fills, winRate=${pct(s.winRate)})`
  ).join("\n"));

  sections.push(`\n## Top Profit Contributors (by total PnL)\n`);
  sections.push(topWinBuckets.map((s, i) =>
    `${i + 1}. **${s.key}** — ${usd(s.totalSettlementPnl)} (${s.fillCount} fills, winRate=${pct(s.winRate)})`
  ).join("\n"));

  sections.push(`\n---\n_This report identifies which regimes generate profit vs destroy bankroll._`);
  sections.push(`_Use this to validate v1.3.0 sizing decisions and regime filters._`);

  const md = sections.join("\n");
  const outDir = path.dirname(outMd);
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  writeFileSync(outMd, md, "utf-8");
  console.log(`\nProfit surface written → ${outMd}`);
}

main().catch(e => { console.error(e); process.exit(1); });
