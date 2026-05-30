export type PairManifest = {
  slug: string;
  replayLogPath: string;
  rawL2LogPath: string;
  strategy: string;
  slotStartMs: number;
  slotEndMs: number;
  captureStartedAtMs: number;
  captureEndedAtMs: number;
  runtimeStartedAtMs: number;
  runtimeEndedAtMs: number;
  recorderStartedAtMs: number;
  recorderEndedAtMs: number;
  runtimeExitCode: number | null;
  recorderExitCode: number | null;
  
  // New lifecycle fields
  recorderStopReason?: "completed" | "expected_sigint" | "timeout" | "crashed" | "unknown";
  recorderCompletedEventSeen?: boolean;
  recorderSignal?: string | null;
  
  replayEventCount: number;
  rawL2EventCount: number;
  rawL2BookEventCount: number;
  rawL2TradeEventCount: number;
  replayFirstEventTsMs: number | null;
  replayLastEventTsMs: number | null;
  rawL2FirstEventTsMs: number | null;
  rawL2LastEventTsMs: number | null;
  coverageLeadMs: number | null;
  coverageTailMs: number | null;
  parseErrors: string[];
  validationErrors: string[];
  validationWarnings: string[];
  coverageVerdict: "complete" | "partial" | "missing" | "unknown";
  pairValidity: "valid" | "invalid";
  
  strategyLabStatus?: "completed" | "timed_out" | "failed" | "skipped";
  strategyLabEvidenceVerdict: "usable" | "unavailable_no_fills" | "unavailable_missing_mapping" | "unavailable_missing_l2" | "unavailable_insufficient_data" | "failed";
  strategyLabStartedAtMs?: number;
  strategyLabEndedAtMs?: number;
  strategyLabTimeoutMs?: number;
  strategyLabError?: string;

  gitCommit: string;
  commands: string[];
  validatedAtMs: number | null;
  createdAtMs: number;
};
