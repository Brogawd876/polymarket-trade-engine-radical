import { createHash } from "crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  type FileHandle,
} from "fs/promises";
import { hostname, platform, release } from "os";
import { join } from "path";

export type RunMode = "replay" | "shadow" | "paper" | "micro-live" | "pilot";

export type RunManifest = {
  schemaVersion: 1;
  runId: string;
  gitCommit: string;
  dirtyWorktree: boolean;
  configHash: string;
  modelHash: string | null;
  datasetVersion: string;
  eventSchemaVersion: number;
  processStartedAtMs: number;
  processEndedAtMs: number | null;
  operatingMode: RunMode;
  host: {
    hostname: string;
    platform: string;
    release: string;
    bunVersion: string;
  };
  sourceCoverage: Record<
    string,
    {
      events: number;
      firstSourceTimestampMs: number | null;
      lastSourceTimestampMs: number | null;
      droppedMessages: number;
      reconnects: number;
    }
  >;
  clockOffsetsMs: Record<string, number>;
  files: Record<string, { bytes: number; sha256: string }>;
  completenessVerdict: "OPEN" | "COMPLETE" | "INCOMPLETE";
  incompleteReasons: string[];
};

export type RawRecorderEnvelope = {
  schemaVersion: number;
  source: string;
  sourceSequence?: string;
  sourceTimestampMs: number | null;
  ingestTimestampMs: number;
  monotonicIngestNs: string;
  originalPayloadHash: string;
  payload: unknown;
};

type StreamState = {
  handle: FileHandle;
  path: string;
  events: number;
  firstSourceTimestampMs: number | null;
  lastSourceTimestampMs: number | null;
  droppedMessages: number;
  reconnects: number;
  writeChain: Promise<void>;
};

export class RunRecorder {
  readonly runDirectory: string;
  private readonly streams = new Map<string, StreamState>();
  private readonly manifest: RunManifest;
  private failedReason: string | null = null;
  private sealed = false;

  private constructor(
    runDirectory: string,
    manifest: RunManifest,
    private readonly onFatal: (reason: string) => void,
    private readonly beforeRawWrite?: (
      streamName: string,
      envelope: RawRecorderEnvelope,
    ) => void,
  ) {
    this.runDirectory = runDirectory;
    this.manifest = manifest;
  }

  static async create(input: {
    rootDirectory: string;
    runId: string;
    gitCommit: string;
    dirtyWorktree: boolean;
    configHash: string;
    modelHash: string | null;
    datasetVersion: string;
    eventSchemaVersion: number;
    operatingMode: RunMode;
    processStartedAtMs?: number;
    onFatal?: (reason: string) => void;
    faultInjection?: {
      beforeRawWrite?: (
        streamName: string,
        envelope: RawRecorderEnvelope,
      ) => void;
    };
  }): Promise<RunRecorder> {
    if (!/^[A-Za-z0-9._-]+$/.test(input.runId)) {
      throw new Error("runId contains unsafe path characters");
    }
    await mkdir(input.rootDirectory, { recursive: true });
    const runDirectory = join(input.rootDirectory, input.runId);
    await mkdir(runDirectory, { recursive: false });
    return new RunRecorder(
      runDirectory,
      {
        schemaVersion: 1,
        runId: input.runId,
        gitCommit: input.gitCommit,
        dirtyWorktree: input.dirtyWorktree,
        configHash: input.configHash,
        modelHash: input.modelHash,
        datasetVersion: input.datasetVersion,
        eventSchemaVersion: input.eventSchemaVersion,
        processStartedAtMs: input.processStartedAtMs ?? Date.now(),
        processEndedAtMs: null,
        operatingMode: input.operatingMode,
        host: {
          hostname: hostname(),
          platform: platform(),
          release: release(),
          bunVersion: Bun.version,
        },
        sourceCoverage: {},
        clockOffsetsMs: {},
        files: {},
        completenessVerdict: "OPEN",
        incompleteReasons: [],
      },
      input.onFatal ?? (() => {}),
      input.faultInjection?.beforeRawWrite,
    );
  }

  async record(streamName: string, envelope: RawRecorderEnvelope): Promise<void> {
    this.assertWritable();
    this.validateEnvelope(envelope);
    const stream = await this.stream(streamName);
    const line = `${JSON.stringify(envelope)}\n`;
    stream.writeChain = stream.writeChain.then(async () => {
      try {
        this.beforeRawWrite?.(streamName, envelope);
        await stream.handle.write(line);
        await stream.handle.sync();
        stream.events += 1;
        if (envelope.sourceTimestampMs !== null) {
          stream.firstSourceTimestampMs ??= envelope.sourceTimestampMs;
          stream.lastSourceTimestampMs = envelope.sourceTimestampMs;
        }
      } catch (error) {
        this.fail(`raw stream ${streamName} write failed: ${String(error)}`);
        throw error;
      }
    });
    await stream.writeChain;
  }

  async close(): Promise<void> {
    for (const stream of this.streams.values()) {
      await stream.writeChain.catch(() => {});
      await stream.handle.close().catch(() => {});
    }
  }

  noteDropped(streamName: string, count = 1): void {
    const stream = this.streams.get(streamName);
    if (!stream) throw new Error(`unknown stream ${streamName}`);
    stream.droppedMessages += count;
  }

  noteReconnect(streamName: string): void {
    const stream = this.streams.get(streamName);
    if (!stream) throw new Error(`unknown stream ${streamName}`);
    stream.reconnects += 1;
  }

  noteClockOffset(source: string, offsetMs: number): void {
    if (!Number.isFinite(offsetMs)) throw new Error("clock offset must be finite");
    this.manifest.clockOffsetsMs[source] = offsetMs;
  }

  async seal(input: {
    endedAtMs?: number;
    requiredStreams: string[];
    additionalIncompleteReasons?: string[];
  }): Promise<RunManifest> {
    this.assertWritable();
    for (const stream of this.streams.values()) {
      await stream.writeChain;
      await stream.handle.sync();
      await stream.handle.close();
    }
    this.manifest.processEndedAtMs = input.endedAtMs ?? Date.now();
    const reasons = [
      ...(input.additionalIncompleteReasons ?? []),
      ...(this.failedReason ? [this.failedReason] : []),
    ];
    for (const required of input.requiredStreams) {
      const stream = this.streams.get(required);
      if (!stream || stream.events === 0) {
        reasons.push(`required stream ${required} is missing or empty`);
      }
    }

    for (const [name, stream] of this.streams) {
      const raw = await readFile(stream.path);
      this.manifest.files[`${name}.ndjson`] = {
        bytes: (await stat(stream.path)).size,
        sha256: createHash("sha256").update(raw).digest("hex"),
      };
      this.manifest.sourceCoverage[name] = {
        events: stream.events,
        firstSourceTimestampMs: stream.firstSourceTimestampMs,
        lastSourceTimestampMs: stream.lastSourceTimestampMs,
        droppedMessages: stream.droppedMessages,
        reconnects: stream.reconnects,
      };
      if (stream.droppedMessages > 0) {
        reasons.push(`${name} dropped ${stream.droppedMessages} message(s)`);
      }
    }
    this.manifest.incompleteReasons = [...new Set(reasons)];
    this.manifest.completenessVerdict =
      this.manifest.incompleteReasons.length === 0
        ? "COMPLETE"
        : "INCOMPLETE";
    const manifestPath = join(this.runDirectory, "manifest.json");
    const temporaryPath = join(
      this.runDirectory,
      `manifest.${crypto.randomUUID()}.tmp`,
    );
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.write(JSON.stringify(this.manifest, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, manifestPath);
    this.sealed = true;
    return structuredClone(this.manifest);
  }

  health(): { writable: boolean; failureReason: string | null } {
    return {
      writable: !this.sealed && this.failedReason === null,
      failureReason: this.failedReason,
    };
  }

  private async stream(streamName: string): Promise<StreamState> {
    if (!/^[A-Za-z0-9._-]+$/.test(streamName)) {
      throw new Error("stream name contains unsafe path characters");
    }
    const current = this.streams.get(streamName);
    if (current) return current;
    const path = join(this.runDirectory, `${streamName}.ndjson`);
    const created: StreamState = {
      handle: await open(path, "wx"),
      path,
      events: 0,
      firstSourceTimestampMs: null,
      lastSourceTimestampMs: null,
      droppedMessages: 0,
      reconnects: 0,
      writeChain: Promise.resolve(),
    };
    this.streams.set(streamName, created);
    return created;
  }

  private validateEnvelope(envelope: RawRecorderEnvelope): void {
    if (!envelope.source) throw new Error("raw event source is required");
    if (!Number.isFinite(envelope.ingestTimestampMs)) {
      throw new Error("raw event ingestion timestamp is required");
    }
    if (!/^[a-f0-9]{64}$/i.test(envelope.originalPayloadHash)) {
      throw new Error("raw event payload hash must be SHA-256");
    }
  }

  private assertWritable(): void {
    if (this.sealed) throw new Error("run recorder is sealed");
    if (this.failedReason) {
      throw new Error(`run recorder failed: ${this.failedReason}`);
    }
  }

  private fail(reason: string): void {
    if (this.failedReason) return;
    this.failedReason = reason;
    this.onFatal(reason);
  }
}
