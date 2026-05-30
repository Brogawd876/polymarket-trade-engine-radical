import { readFileSync, existsSync } from "fs";
import { type PairManifest } from "./pair-manifest.ts";
import { StrategyLabBatchManager } from "../strategy-lab.ts";

export interface PairValidationOptions {
  metadata?: Partial<PairManifest>;
  testStrategyLabVerdict?: "usable" | "unavailable_no_fills" | "unavailable_missing_mapping" | "unavailable_missing_l2" | "unavailable_insufficient_data" | "failed";
  testStrategyLabError?: string;
  strategyLabTimeoutMs?: number;
  skipStrategyLab?: boolean;
  /**
   * Optional manager instance for dependency injection (useful for tests)
   */
  batchManager?: StrategyLabBatchManager;
}

export async function validatePair(
  slug: string,
  replayLogPath: string,
  rawL2LogPath: string,
  strategy: string,
  options: PairValidationOptions = {}
): Promise<PairManifest> {
  const metadata = options.metadata ?? {};
  const parseErrors: string[] = [];
  const validationErrors: string[] = [];
  const validationWarnings: string[] = [];

  let replayEventCount = 0;
  let rawL2EventCount = 0;
  let rawL2BookEventCount = 0;
  let rawL2TradeEventCount = 0;
  let replayFirstEventTsMs: number | null = null;
  let replayLastEventTsMs: number | null = null;
  let rawL2FirstEventTsMs: number | null = null;
  let rawL2LastEventTsMs: number | null = null;

  let replaySlugFound: string | null = null;
  let rawL2SlugFound: string | null = null;
  let recorderCompletedEventSeen = false;

  // Read Replay Log
  if (!existsSync(replayLogPath)) {
    validationErrors.push(`Replay log not found: ${replayLogPath}`);
  } else {
    try {
      const replayContent = readFileSync(replayLogPath, "utf-8");
      const lines = replayContent.split("\n").filter(l => l.trim().length > 0);
      replayEventCount = lines.length;
      
      let minTs: number | null = null;
      let maxTs: number | null = null;

      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          const ts = event.ts;
          if (typeof ts === "number") {
            if (minTs === null || ts < minTs) minTs = ts;
            if (maxTs === null || ts > maxTs) maxTs = ts;
          }
          if (event.event?.slug) replaySlugFound = event.event.slug;
          if (event.slug) replaySlugFound = event.slug;
        } catch (e) {
          parseErrors.push(`Failed to parse replay event: ${e}`);
          break;
        }
      }
      
      replayFirstEventTsMs = minTs;
      replayLastEventTsMs = maxTs;

      if (replayEventCount === 0) {
        validationErrors.push("Replay log is empty");
      }
      
      if (replaySlugFound && replaySlugFound !== slug) {
        validationErrors.push(`Replay log slug mismatch: expected ${slug}, found ${replaySlugFound}`);
      }
    } catch (e) {
      parseErrors.push(`Failed to read replay log: ${e}`);
    }
  }

  // Read Raw L2 Log
  if (!existsSync(rawL2LogPath)) {
    validationErrors.push(`Raw L2 log not found: ${rawL2LogPath}`);
  } else {
    try {
      const rawL2Content = readFileSync(rawL2LogPath, "utf-8");
      const lines = rawL2Content.split("\n").filter(l => l.trim().length > 0);
      rawL2EventCount = lines.length;
      
      let minTs: number | null = null;
      let maxTs: number | null = null;

      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          const type = event.eventType;
          if (type === "market_book_snapshot" || type === "market_book_delta") {
            rawL2BookEventCount++;
          } else if (type === "market_trade") {
            rawL2TradeEventCount++;
          } else if (type === "recorder_completed") {
            recorderCompletedEventSeen = true;
          }
          
          const ts = event.receivedTsMs ?? event.processedTsMs;
          if (typeof ts === "number") {
            if (minTs === null || ts < minTs) minTs = ts;
            if (maxTs === null || ts > maxTs) maxTs = ts;
          }

          if (event.slug) {
            rawL2SlugFound = event.slug;
          }
        } catch (e) {
          parseErrors.push(`Failed to parse raw L2 event: ${e}`);
          break;
        }
      }
      rawL2FirstEventTsMs = minTs;
      rawL2LastEventTsMs = maxTs;

      if (rawL2EventCount === 0) {
        validationErrors.push("Raw L2 log is empty");
      } else if (rawL2BookEventCount === 0 && rawL2TradeEventCount === 0) {
        validationErrors.push("Raw L2 log contains zero useful book or trade events.");
      } else if (rawL2TradeEventCount === 0) {
        validationWarnings.push("Raw L2 log has zero trade events (book-only data). Coverage is diagnostic only.");
      }

      if (rawL2SlugFound && rawL2SlugFound !== slug) {
        validationErrors.push(`Raw L2 log slug mismatch: expected ${slug}, found ${rawL2SlugFound}`);
      }
    } catch (e) {
      parseErrors.push(`Failed to read raw L2 log: ${e}`);
    }
  }

  let coverageVerdict: "complete" | "partial" | "missing" | "unknown" = "unknown";
  let coverageLeadMs: number | null = null;
  let coverageTailMs: number | null = null;

  if (replayEventCount === 0 || rawL2EventCount === 0) {
    coverageVerdict = "missing";
  } else if (replayFirstEventTsMs !== null && replayLastEventTsMs !== null && rawL2FirstEventTsMs !== null && rawL2LastEventTsMs !== null) {
    coverageLeadMs = replayFirstEventTsMs - rawL2FirstEventTsMs;
    coverageTailMs = rawL2LastEventTsMs - replayLastEventTsMs;

    if (rawL2FirstEventTsMs <= replayFirstEventTsMs && rawL2LastEventTsMs >= replayLastEventTsMs) {
      coverageVerdict = "complete";
    } else {
      coverageVerdict = "partial";
    }
  }

  // Recorder Shutdown Logic
  let recorderExitCode = metadata.recorderExitCode ?? null;
  let recorderSignal = metadata.recorderSignal ?? null;
  let recorderStopReason = metadata.recorderStopReason ?? "unknown";

  if (recorderExitCode === 0) {
    recorderStopReason = "completed";
  } else if (recorderExitCode === null && recorderSignal === "SIGINT") {
    if (recorderCompletedEventSeen) {
      recorderStopReason = "expected_sigint";
    } else {
      recorderStopReason = "unknown"; // null exit without completion marker
      validationErrors.push("Recorder exited via SIGINT but no recorder_completed event was seen.");
    }
  } else if (recorderExitCode !== null && recorderExitCode !== 0) {
    recorderStopReason = "crashed";
    validationErrors.push(`Recorder crashed with exit code ${recorderExitCode}`);
  } else if (recorderStopReason === "unknown") {
    validationWarnings.push("Recorder stop reason is unknown. Recorder may not have shut down cleanly.");
  }

  let strategyLabStatus: "completed" | "timed_out" | "failed" | "skipped" = "skipped";
  let strategyLabEvidenceVerdict: "usable" | "unavailable_no_fills" | "unavailable_missing_mapping" | "unavailable_missing_l2" | "unavailable_insufficient_data" | "failed" = "failed";
  let strategyLabStartedAtMs: number | undefined;
  let strategyLabEndedAtMs: number | undefined;
  let strategyLabError: string | undefined;

  const skipStrategyLab = options.skipStrategyLab || validationErrors.length > 0 || parseErrors.length > 0 || coverageVerdict !== "complete";

  if (!skipStrategyLab) {
    if (options.testStrategyLabVerdict || options.testStrategyLabError) {
      strategyLabStatus = options.testStrategyLabError ? "failed" : "completed";
      strategyLabEvidenceVerdict = options.testStrategyLabVerdict ?? "failed";
      strategyLabError = options.testStrategyLabError;
    } else {
      strategyLabStartedAtMs = Date.now();
      try {
        const manager = options.batchManager ?? new StrategyLabBatchManager();
        const batch = await manager.createBatch({
          strategies: [strategy],
          files: [replayLogPath],
          l2Files: { [replayLogPath]: rawL2LogPath }
        });

        const timeoutMs = options.strategyLabTimeoutMs ?? 60000;
        const start = Date.now();
        let finishedBatch = manager.getBatch(batch.id);
        
        while (finishedBatch && (finishedBatch.state === "running" || finishedBatch.state === "queued")) {
          if (Date.now() - start > timeoutMs) {
            strategyLabStatus = "timed_out";
            strategyLabError = "Strategy Lab batch timed out during validation";
            break;
          }
          await new Promise(r => setTimeout(r, 200));
          finishedBatch = manager.getBatch(batch.id);
        }

        if (strategyLabStatus !== "timed_out") {
          if (finishedBatch && (finishedBatch.state === "completed" || finishedBatch.state === "failed")) {
            strategyLabStatus = finishedBatch.state === "completed" ? "completed" : "failed";
            const run = finishedBatch.runs[0];
            if (run && run.status === "completed") {
              const cFill = run.execution.conservativeFill;
              if (!cFill.conservativeFillEvidenceAvailable) {
                strategyLabEvidenceVerdict = "unavailable_missing_l2";
              } else if (cFill.eligibleFillCount === 0) {
                strategyLabEvidenceVerdict = "unavailable_no_fills";
              } else if (cFill.conservativeFillUnavailableReasons.unmatched_intent_id || 
                       cFill.conservativeFillUnavailableReasons.ambiguous_intent_mapping || 
                       cFill.conservativeFillUnavailableReasons.missing_intent_mapping) {
                strategyLabEvidenceVerdict = "unavailable_missing_mapping";
                validationWarnings.push("Fills occurred but mapping was incomplete or ambiguous.");
              } else if (cFill.usableEvidenceCount > 0) {
                strategyLabEvidenceVerdict = "usable";
              } else if (cFill.eligibleFillCount > 0 && cFill.evaluatedFillCount > 0) {
                strategyLabEvidenceVerdict = "unavailable_insufficient_data";
              } else {
                strategyLabEvidenceVerdict = "failed";
              }
            } else if (run && run.status === "failed") {
              strategyLabStatus = "failed";
              strategyLabError = (run as any).error || (run as any).execution?.error || "run failed";
            } else {
              strategyLabStatus = "failed";
              strategyLabError = `Run status: ${run ? run.status : "missing"}`;
            }
          } else {
            strategyLabStatus = "failed";
            strategyLabError = `Batch state: ${finishedBatch ? finishedBatch.state : "missing"}`;
          }
        }
      } catch (e: any) {
        strategyLabStatus = "failed";
        strategyLabError = e.message;
      }
      strategyLabEndedAtMs = Date.now();
    }
  }

  let pairValidity: "valid" | "invalid" = "valid";
  if (validationErrors.length > 0 || parseErrors.length > 0 || coverageVerdict !== "complete") {
    pairValidity = "invalid";
  }

  return {
    slug,
    replayLogPath,
    rawL2LogPath,
    strategy,
    slotStartMs: metadata.slotStartMs ?? 0,
    slotEndMs: metadata.slotEndMs ?? 0,
    captureStartedAtMs: metadata.captureStartedAtMs ?? 0,
    captureEndedAtMs: metadata.captureEndedAtMs ?? 0,
    runtimeStartedAtMs: metadata.runtimeStartedAtMs ?? 0,
    runtimeEndedAtMs: metadata.runtimeEndedAtMs ?? 0,
    recorderStartedAtMs: metadata.recorderStartedAtMs ?? 0,
    recorderEndedAtMs: metadata.recorderEndedAtMs ?? 0,
    runtimeExitCode: metadata.runtimeExitCode ?? null,
    recorderExitCode: recorderExitCode,
    recorderSignal: metadata.recorderSignal ?? recorderSignal,
    recorderStopReason: recorderStopReason,
    recorderCompletedEventSeen: recorderCompletedEventSeen,
    replayEventCount,
    rawL2EventCount,
    rawL2BookEventCount,
    rawL2TradeEventCount,
    replayFirstEventTsMs,
    replayLastEventTsMs,
    rawL2FirstEventTsMs,
    rawL2LastEventTsMs,
    coverageLeadMs,
    coverageTailMs,
    parseErrors,
    validationErrors,
    validationWarnings,
    coverageVerdict,
    pairValidity,
    strategyLabStatus,
    strategyLabEvidenceVerdict,
    strategyLabStartedAtMs,
    strategyLabEndedAtMs,
    strategyLabTimeoutMs: options.strategyLabTimeoutMs,
    strategyLabError,
    gitCommit: metadata.gitCommit ?? "unknown",
    commands: metadata.commands ?? [],
    validatedAtMs: Date.now(),
    createdAtMs: metadata.createdAtMs ?? Date.now(),
  };
}
