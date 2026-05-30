import { readFileSync, writeFileSync } from "fs";
import { validatePair } from "../engine/replay/pair-validator.ts";
import { type PairManifest } from "../engine/replay/pair-manifest.ts";

async function main() {
  const args = process.argv.slice(2);
  let pairPath = "";
  let replayPath = "";
  let l2Path = "";
  let slug = "";
  let strategy = "late-entry";
  let strategyLabTimeoutMs = 60000;
  let skipStrategyLab = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--pair") pairPath = args[++i] || "";
    else if (arg === "--replay") replayPath = args[++i] || "";
    else if (arg === "--l2") l2Path = args[++i] || "";
    else if (arg === "--slug") slug = args[++i] || "";
    else if (arg === "--strategy") strategy = args[++i] || "";
    else if (arg === "--strategy-lab-timeout-ms") strategyLabTimeoutMs = parseInt(args[++i] || "60000", 10);
    else if (arg === "--skip-strategy-lab") skipStrategyLab = true;
  }

  if (pairPath) {
    try {
      const manifestStr = readFileSync(pairPath, "utf-8");
      const manifest = JSON.parse(manifestStr) as PairManifest;
      console.log(`Validating existing pair manifest: ${pairPath}`);
      const updated = await validatePair(
        manifest.slug,
        manifest.replayLogPath,
        manifest.rawL2LogPath,
        manifest.strategy,
        { 
          metadata: manifest,
          strategyLabTimeoutMs,
          skipStrategyLab
        }
      );
      writeFileSync(pairPath, JSON.stringify(updated, null, 2));
      console.log("Validation complete.");
      console.log(JSON.stringify(updated, null, 2));
      process.exit(updated.validationErrors.length > 0 ? 1 : 0);
    } catch (e) {
      console.error(`Failed to read/validate pair manifest ${pairPath}:`, e);
      process.exit(1);
    }
  } else if (replayPath && l2Path && slug) {
    console.log(`Validating raw paths for slug ${slug}`);
    const manifest = await validatePair(slug, replayPath, l2Path, strategy, {
      strategyLabTimeoutMs,
      skipStrategyLab
    });
    console.log(JSON.stringify(manifest, null, 2));
    process.exit(manifest.validationErrors.length > 0 ? 1 : 0);
  } else {
    console.error("Usage: bun run scripts/validate-paired-l2.ts --pair <path> OR --replay <path> --l2 <path> --slug <slug>");
    process.exit(1);
  }
}

main().catch(console.error);
