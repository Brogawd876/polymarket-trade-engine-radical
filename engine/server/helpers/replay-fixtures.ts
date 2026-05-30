import { readFile } from "fs/promises";
import * as path from "path";

export type ReplayFixtureMetadata = {
  path: string;
  label: string;
  replayable: boolean;
  validationStatus: "valid" | "invalid" | "unsupported";
  reason?: string;
  slug?: string;
  strategy?: string;
};

/**
 * Validates a log file to see if it's a replayable structured market log.
 */
export async function validateReplayFixture(logPath: string): Promise<ReplayFixtureMetadata> {
  const filename = path.basename(logPath);
  const metadata: ReplayFixtureMetadata = {
    path: logPath,
    label: filename,
    replayable: false,
    validationStatus: "unsupported",
  };

  if (!filename.endsWith(".log")) {
    metadata.reason = "Not a .log file";
    return metadata;
  }

  // Heuristic: Console logs follow early-bird-YYYY-MM-DD-HH-MM-SS.log
  // Market logs usually have the slug or are just different.
  if (/^early-bird-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.log$/.test(filename)) {
    metadata.validationStatus = "unsupported";
    metadata.reason = "General process console log (not a market log)";
    return metadata;
  }

  try {
    const content = await readFile(logPath, "utf-8");
    const lines = content.split("\n").filter(l => l.trim().length > 0);
    
    if (lines.length === 0) {
      metadata.validationStatus = "invalid";
      metadata.reason = "Empty log file";
      return metadata;
    }

    // Check first few lines for NDJSON and 'slot' type
    let foundSlot = false;
    for (let i = 0; i < Math.min(5, lines.length); i++) {
      try {
        const line = lines[i];
        if (line === undefined) continue;
        const entry = JSON.parse(line);
        if (entry.type === "slot") {
          metadata.slug = entry.payload?.slug || entry.slug;
          metadata.strategy = entry.payload?.strategy || entry.strategy;
          foundSlot = true;
          break;
        }
      } catch (e) {
        // Not JSON, continue checking
      }
    }

    if (foundSlot) {
      metadata.replayable = true;
      metadata.validationStatus = "valid";
      if (metadata.slug) {
          metadata.label = `${metadata.slug} (${metadata.strategy || 'unknown strategy'})`;
      }
    } else {
      metadata.validationStatus = "invalid";
      metadata.reason = "Not a structured market log (missing slot header)";
    }

  } catch (e: any) {
    metadata.validationStatus = "invalid";
    metadata.reason = `Read/Parse failed: ${e.message}`;
  }

  return metadata;
}
