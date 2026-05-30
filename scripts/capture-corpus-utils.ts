import { existsSync, readFileSync, readdirSync } from "fs";
import * as path from "path";
import type { PairManifest } from "../engine/replay/pair-manifest.ts";

export type CaptureDirs = {
  pairsDir: string;
  rawL2Dir: string;
  invalidPairsDir: string;
};

export type CaptureCounts = {
  validPairs: number;
  invalidPairs: number;
  totalPairs: number;
};

export type CaptureArtifactStatus = {
  manifestPath: string;
  rawL2LogPath: string;
  replayLogPath: string;
  manifestExists: boolean;
  rawL2Exists: boolean;
  replayLogExists: boolean;
  shouldSkip: boolean;
};

export function pairManifestPath(dir: string, slug: string): string {
  return path.join(dir, `${slug}.pair.json`);
}

export function rawL2LogPath(dir: string, slug: string): string {
  return path.join(dir, `raw-l2-${slug}.ndjson`);
}

export function replayLogPath(slug: string): string {
  return path.join("logs", `early-bird-${slug}.log`);
}

export function inspectCaptureArtifacts(
  slug: string,
  dirs: CaptureDirs,
  overwriteExisting = false,
): CaptureArtifactStatus {
  const manifestPath = pairManifestPath(dirs.pairsDir, slug);
  const invalidManifestPath = pairManifestPath(dirs.invalidPairsDir, slug);
  const rawPath = rawL2LogPath(dirs.rawL2Dir, slug);
  const replayPath = replayLogPath(slug);
  const manifestExists =
    existsSync(manifestPath) ||
    (dirs.invalidPairsDir !== dirs.pairsDir && existsSync(invalidManifestPath));
  const rawL2Exists = existsSync(rawPath);
  const replayLogExists = existsSync(replayPath);

  return {
    manifestPath,
    rawL2LogPath: rawPath,
    replayLogPath: replayPath,
    manifestExists,
    rawL2Exists,
    replayLogExists,
    shouldSkip:
      !overwriteExisting && (manifestExists || rawL2Exists || replayLogExists),
  };
}

export function readPairManifest(filePath: string): PairManifest | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as PairManifest;
  } catch {
    return null;
  }
}

export function countPairManifests(
  pairsDir: string,
  invalidPairsDir = pairsDir,
): CaptureCounts {
  const seen = new Set<string>();
  let validPairs = 0;
  let invalidPairs = 0;

  const addDir = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".pair.json"))) {
      const fullPath = path.join(dir, file);
      if (seen.has(fullPath)) continue;
      seen.add(fullPath);
      const manifest = readPairManifest(fullPath);
      if (!manifest) {
        invalidPairs++;
      } else if (manifest.pairValidity === "valid") {
        validPairs++;
      } else {
        invalidPairs++;
      }
    }
  };

  addDir(pairsDir);
  if (invalidPairsDir !== pairsDir) addDir(invalidPairsDir);

  return {
    validPairs,
    invalidPairs,
    totalPairs: validPairs + invalidPairs,
  };
}

export function manifestIsCompleteAndValid(manifest: PairManifest): boolean {
  return (
    manifest.pairValidity === "valid" &&
    manifest.coverageVerdict === "complete" &&
    manifest.validationErrors.length === 0 &&
    manifest.parseErrors.length === 0
  );
}

export function buildPairedCaptureArgs(opts: {
  strategy: string;
  rounds: string;
  slotOffset: string;
  strategyLabTimeoutMs: string;
  dirs: CaptureDirs;
}): string[] {
  return [
    "scripts/capture-paired-replay-l2.ts",
    "--strategy",
    opts.strategy,
    "--rounds",
    opts.rounds,
    "--slot-offset",
    opts.slotOffset,
    "--strategy-lab-timeout-ms",
    opts.strategyLabTimeoutMs,
    "--pairs-dir",
    opts.dirs.pairsDir,
    "--raw-l2-dir",
    opts.dirs.rawL2Dir,
    "--invalid-pairs-dir",
    opts.dirs.invalidPairsDir,
  ];
}
