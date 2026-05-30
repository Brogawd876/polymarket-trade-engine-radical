import { readdirSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";
import { type PairManifest } from "../engine/replay/pair-manifest.ts";
import { summarizePairManifests, formatPairedCorpusReport } from "./paired-corpus-utils.ts";

function main() {
  const args = process.argv.slice(2);
  let pairsDir = "data/pairs";
  let outPath = "AI_WORKSPACE/PHASE8G_PAIRED_CORPUS_REPORT.md";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--pairs") pairsDir = args[++i] || pairsDir;
    else if (args[i] === "--out") outPath = args[++i] || outPath;
  }

  const files = readdirSync(pairsDir).filter(f => f.endsWith(".pair.json"));
  const manifests: PairManifest[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(path.join(pairsDir, file), "utf-8");
      manifests.push(JSON.parse(content) as PairManifest);
    } catch (e) {
      console.error(`Failed to read/parse ${file}:`, e);
    }
  }

  const summary = summarizePairManifests(manifests);
  
  // Optionally read the runner status from a file if we want to pipe it here,
  // but for now we just mark it as not_run unless updated externally.

  const md = formatPairedCorpusReport(summary);

  writeFileSync(outPath, md);
  console.log(`Wrote summary to ${outPath}`);
}

main();
