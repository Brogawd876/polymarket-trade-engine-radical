/**
 * FVM Fill Profit Attribution Extractor
 *
 * Runs fvm-v1.1.0-raw-ungated across the full paired corpus and computes
 * true per-fill settlement PnL using the binary contract payoff formula:
 *
 *   buy UP:   pnl = shares × ((settledUp ? 1 : 0) – fillPrice)
 *   buy DOWN: pnl = shares × ((settledDown ? 1 : 0) – fillPrice)
 *
 * Per-fill PnL is only computed in this OFFLINE attribution script.
 * It is NEVER injected into live strategy decisions.
 *
 * Outputs: data/reports/fvm-fill-profit-attribution.jsonl
 * Usage:
 *   npx tsx scripts/fvm-fill-attribution.ts [--pairs-dir data/pairs] [--out-jsonl <path>] [--balance 50]
 */

import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import * as path from "path";
import { type PairManifest } from "../engine/replay/pair-manifest.ts";
import { StrategyLabBatchManager } from "../engine/strategy-lab.ts";

// ── Bucket types ───────────────────────────────────────────────────────────────

export type EdgeBucket = "thin_<0.01" | "ok_0.01-0.03" | "fat_>0.03";
export type CvdBucket = "neg_heavy" | "neg" | "neutral" | "pos" | "pos_heavy";
export type BasisBucket = "tight_<0.5pct" | "normal_0.5-2pct" | "wide_2-5pct" | "extreme_>5pct";
export type TimeBucket = "final_0-60s" | "near_60-120s" | "mid_120-180s" | "early_>180s";
export type SpreadBucket = "tight_<0.02" | "normal_0.02-0.05" | "wide_>0.05";
export type SigmaBucket = "low_<0.5" | "normal_0.5-1.0" | "high_1.0-1.5" | "extreme_>1.5";
export type InventoryRegime = "new_position" | "adding_to_inventory" | "reducing_inventory";

export type FillAttributionRecord = {
  // Identity
  slug: string;
  orderId: string;
  side: "UP" | "DOWN";
  action: "buy" | "sell";
  fillTsMs: number;
  fillPrice: number;
  fillShares: number;
  notional: number;           // fillPrice × fillShares

  // True settlement PnL — binary contract payoff (offline attribution only)
  settlementPnl: number | null;
  settlementWin: boolean | null;
  roundDirection: "UP" | "DOWN" | null;

  // Short markouts (from conservative fill scorer)
  markout1s: number | null;
  markout5s: number | null;
  markout30s: number | null;
  adverseSelection: boolean | null;

  // Decision features at fill time
  edge: number | null;
  sigma: number | null;
  probabilityUp: number | null;
  timeRemainingMs: number | null;
  spreadAtDecision: number | null;
  cvdSideAdjusted: number | null;     // side-adjusted: positive = flow favoring this side
  imbalanceSideAdjusted: number | null;
  divergenceAbs: number | null;        // |composite – settlementAnchor|
  settlementAnchorPrice: number | null;
  basisPct: number | null;             // divergenceAbs / settlementAnchorPrice (normalized)

  // Inventory context at fill time
  inventoryBeforeFill: number | null;  // net inventory on this side before fill
  isAddingToInventory: boolean | null;

  // Sequence context
  sequenceId: string;                  // slug + side to group consecutive same-side fills
  fillIndexInSequence: number;         // 0-indexed position within the sequence

  // Round context
  roundPnl: number | null;
  sequenceEndedProfitable: boolean | null;  // roundPnl > 0

  // Regime buckets
  edgeBucket: EdgeBucket | null;
  cvdBucket: CvdBucket | null;
  basisBucket: BasisBucket | null;
  timeBucket: TimeBucket | null;
  spreadBucket: SpreadBucket | null;
  sigmaBucket: SigmaBucket | null;
  inventoryRegime: InventoryRegime | null;
};

// ── Bucket helpers ─────────────────────────────────────────────────────────────

function bucketEdge(edge: number | null): EdgeBucket | null {
  if (edge === null || !Number.isFinite(edge)) return null;
  if (edge < 0.01) return "thin_<0.01";
  if (edge < 0.03) return "ok_0.01-0.03";
  return "fat_>0.03";
}

function bucketCvd(cvd: number | null): CvdBucket | null {
  if (cvd === null || !Number.isFinite(cvd)) return null;
  if (cvd < -200) return "neg_heavy";
  if (cvd < -50)  return "neg";
  if (cvd <= 50)  return "neutral";
  if (cvd <= 200) return "pos";
  return "pos_heavy";
}

/**
 * Basis bucket using percentage-normalized basis: basisPct = |composite - anchor| / anchor.
 * Static dollar buckets are meaningless for BTC where $1 is noise and $10 is significant.
 */
function bucketBasis(basisPct: number | null): BasisBucket | null {
  if (basisPct === null || !Number.isFinite(basisPct)) return null;
  const pct = Math.abs(basisPct) * 100; // convert to percent
  if (pct < 0.5)  return "tight_<0.5pct";
  if (pct < 2.0)  return "normal_0.5-2pct";
  if (pct < 5.0)  return "wide_2-5pct";
  return "extreme_>5pct";
}

function bucketTime(timeRemainingMs: number | null): TimeBucket | null {
  if (timeRemainingMs === null || !Number.isFinite(timeRemainingMs)) return null;
  const secs = timeRemainingMs / 1000;
  if (secs < 60)  return "final_0-60s";
  if (secs < 120) return "near_60-120s";
  if (secs < 180) return "mid_120-180s";
  return "early_>180s";
}

function bucketSpread(spread: number | null): SpreadBucket | null {
  if (spread === null || !Number.isFinite(spread)) return null;
  if (spread < 0.02) return "tight_<0.02";
  if (spread < 0.05) return "normal_0.02-0.05";
  return "wide_>0.05";
}

function bucketSigma(sigma: number | null): SigmaBucket | null {
  if (sigma === null || !Number.isFinite(sigma)) return null;
  if (sigma < 0.5)  return "low_<0.5";
  if (sigma < 1.0)  return "normal_0.5-1.0";
  if (sigma < 1.5)  return "high_1.0-1.5";
  return "extreme_>1.5";
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let pairsDir = "data/pairs";
  let outJsonl = "data/reports/fvm-fill-profit-attribution.jsonl";
  let balance = 50;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--pairs-dir") pairsDir = args[++i] || pairsDir;
    else if (args[i] === "--out-jsonl") outJsonl = args[++i] || outJsonl;
    else if (args[i] === "--balance") balance = parseFloat(args[++i] || String(balance));
  }

  if (!existsSync(pairsDir)) {
    console.error(`Pairs directory not found: ${pairsDir}`);
    process.exit(1);
  }

  // Load valid pair manifests
  const files = readdirSync(pairsDir).filter(f => f.endsWith(".pair.json"));
  const validManifests: PairManifest[] = [];
  for (const file of files) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(pairsDir, file), "utf-8")) as PairManifest;
      if (manifest.pairValidity === "valid") validManifests.push(manifest);
    } catch { /* skip malformed */ }
  }

  console.log(`Loaded ${validManifests.length} valid pair manifests.`);
  if (validManifests.length === 0) { console.log("Nothing to process."); process.exit(0); }

  process.env.WALLET_BALANCE = String(balance);

  const VARIANT = "fvm-v1.1.0-raw-ungated";
  const BATCH_SIZE = 25;  // 25 files × 1 variant = 25 runs, well under 50-cap
  const allRecords: FillAttributionRecord[] = [];

  const manager = new StrategyLabBatchManager();

  const chunks: PairManifest[][] = [];
  for (let i = 0; i < validManifests.length; i += BATCH_SIZE) {
    chunks.push(validManifests.slice(i, i + BATCH_SIZE));
  }

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]!;
    const replayFiles = chunk.map(m => m.replayLogPath);
    const l2Files = Object.fromEntries(chunk.map(m => [m.replayLogPath, m.rawL2LogPath]));

    console.log(`\n[Attribution] Batch ${ci + 1}/${chunks.length}: ${chunk.length} pairs...`);

    let batch = await manager.createBatch({
      variants: [VARIANT],
      files: replayFiles,
      l2Files,
      continuousBankroll: false,
    });

    const startMs = Date.now();
    while (batch.state === "queued" || batch.state === "running") {
      if (Date.now() - startMs > 300_000) {
        console.warn("  Batch timed out — using partial results.");
        manager.cancelBatch(batch.id);
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
      batch = manager.getBatch(batch.id) ?? batch;
      process.stdout.write(`\r  ${batch.progress.completedRuns}/${batch.progress.totalRuns} runs...`);
    }
    console.log(`\n  Batch complete. State: ${batch.state}`);

    for (const run of batch.runs) {
      if (run.status !== "completed") continue;

      const evidence = run.execution.conservativeFill.evidence ?? [];
      if (evidence.length === 0) continue;

      const roundPnl = run.pnl ?? null;
      const roundDirection = run.direction;

      // Track cumulative inventory per side for this run to compute inventoryBeforeFill
      const inventoryBySide: Record<"UP" | "DOWN", number> = { UP: 0, DOWN: 0 };
      // Track fill index per sequence (slug+side)
      const sequenceIndex: Record<string, number> = {};

      for (const fill of evidence) {
        const df = fill.decisionFeature;

        // ── True binary contract settlement PnL ───────────────────────────────
        // This uses settlement direction — ONLY valid in offline attribution.
        // Never use this inside strategy decisions.
        let settlementPnl: number | null = null;
        let settlementWin: boolean | null = null;
        if (roundDirection !== null && fill.action === "buy") {
          const settledThisSide = roundDirection === fill.side;
          settlementPnl = fill.shares * ((settledThisSide ? 1 : 0) - fill.price);
          settlementWin = settledThisSide;
        }

        // ── Decision features ─────────────────────────────────────────────────
        const sigma = df?.quant?.sigma ?? null;
        const probabilityUp = df?.quant?.probabilityUp ?? null;
        const timeRemainingMs = df?.round?.timeRemainingMs ?? null;
        const spreadAtDecision = df?.orderbook?.spread ?? null;
        const cvdSideAdjusted = df?.flow?.cvd10s ?? null;     // already side-adjusted
        const imbalanceSideAdjusted = df?.flow?.imbalance ?? null;  // already side-adjusted
        const divergenceAbs = df?.predictiveTape?.divergenceFromSettlementAbs ?? null;
        const settlementAnchorPrice = df?.settlementTruth?.settlementAnchorPrice ?? null;

        // Normalized basis: divergence as fraction of anchor price
        const basisPct = divergenceAbs !== null && settlementAnchorPrice !== null && settlementAnchorPrice !== 0
          ? divergenceAbs / settlementAnchorPrice
          : null;

        // Edge: probability - price for buy on this side
        let edge: number | null = null;
        if (probabilityUp !== null && fill.action === "buy") {
          edge = fill.side === "UP"
            ? probabilityUp - fill.price
            : (1 - probabilityUp) - fill.price;
        }

        // ── Inventory context ─────────────────────────────────────────────────
        const inventoryBeforeFill = inventoryBySide[fill.side];
        const isAddingToInventory = fill.action === "buy"
          ? inventoryBeforeFill >= 0   // already long this side
          : inventoryBeforeFill <= 0;  // already short this side

        // Update running inventory
        if (fill.action === "buy") {
          inventoryBySide[fill.side] += fill.shares;
        } else {
          inventoryBySide[fill.side] -= fill.shares;
        }

        // ── Sequence tracking ─────────────────────────────────────────────────
        const seqKey = `${run.slug ?? "unknown"}:${fill.side}`;
        const seqIdx = sequenceIndex[seqKey] ?? 0;
        sequenceIndex[seqKey] = seqIdx + 1;

        // ── Inventory regime ──────────────────────────────────────────────────
        let inventoryRegime: InventoryRegime | null = null;
        if (fill.action === "buy") {
          inventoryRegime = inventoryBeforeFill === 0 ? "new_position"
            : isAddingToInventory ? "adding_to_inventory"
            : "reducing_inventory";
        }

        const record: FillAttributionRecord = {
          slug: run.slug ?? "unknown",
          orderId: fill.orderId,
          side: fill.side,
          action: fill.action,
          fillTsMs: fill.fillTsMs ?? fill.placedTsMs,
          fillPrice: fill.price,
          fillShares: fill.shares,
          notional: parseFloat((fill.price * fill.shares).toFixed(4)),
          settlementPnl: settlementPnl !== null ? parseFloat(settlementPnl.toFixed(4)) : null,
          settlementWin,
          roundDirection,
          markout1s: fill.markouts["1s"],
          markout5s: fill.markouts["5s"],
          markout30s: fill.markouts["30s"],
          adverseSelection: fill.adverseSelection,
          edge: edge !== null ? parseFloat(edge.toFixed(5)) : null,
          sigma,
          probabilityUp,
          timeRemainingMs,
          spreadAtDecision,
          cvdSideAdjusted,
          imbalanceSideAdjusted,
          divergenceAbs,
          settlementAnchorPrice,
          basisPct: basisPct !== null ? parseFloat(basisPct.toFixed(6)) : null,
          inventoryBeforeFill,
          isAddingToInventory,
          sequenceId: seqKey,
          fillIndexInSequence: seqIdx,
          roundPnl,
          sequenceEndedProfitable: roundPnl !== null ? roundPnl > 0 : null,
          edgeBucket: bucketEdge(edge),
          cvdBucket: bucketCvd(cvdSideAdjusted),
          basisBucket: bucketBasis(basisPct),
          timeBucket: bucketTime(timeRemainingMs),
          spreadBucket: bucketSpread(spreadAtDecision),
          sigmaBucket: bucketSigma(sigma),
          inventoryRegime,
        };

        allRecords.push(record);
      }
    }

    console.log(`  ${allRecords.length} total attribution records so far.`);
  }

  // Write output
  mkdirSync(path.dirname(outJsonl), { recursive: true });
  const jsonl = allRecords.map(r => JSON.stringify(r)).join("\n");
  writeFileSync(outJsonl, jsonl, "utf-8");
  console.log(`\nFill attribution complete: ${allRecords.length} records → ${outJsonl}`);

  // Quick summary
  const withPnl = allRecords.filter(r => r.settlementPnl !== null);
  if (withPnl.length > 0) {
    const totalPnl = withPnl.reduce((sum, r) => sum + (r.settlementPnl ?? 0), 0);
    const wins = withPnl.filter(r => r.settlementWin === true).length;
    const noDecision = allRecords.filter(r => r.sigmaBucket === null).length;
    console.log(`\nQuick summary:`);
    console.log(`  Total fills attributed: ${withPnl.length}`);
    console.log(`  Total settlement PnL:   $${totalPnl.toFixed(4)}`);
    console.log(`  Fill win rate:          ${(wins / withPnl.length * 100).toFixed(1)}%`);
    console.log(`  Fills missing df:       ${noDecision} (no decision feature → no regime buckets)`);
  }
}

// Duplicate interface removed

main().catch(e => { console.error(e); process.exit(1); });
