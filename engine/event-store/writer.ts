import { mkdir, open, type FileHandle } from "fs/promises";
import * as path from "path";
import {
  createProfitEvent,
  gitCommitFromEnv,
  type ProfitEventContext,
  type ProfitEventEnvelope,
  type ProfitEventInput,
  type ProfitEventPayload,
} from "./events.ts";

export interface EventWriter {
  readonly runId: string;
  readonly sessionId: string;
  append<TPayload extends ProfitEventPayload>(
    event: ProfitEventInput<TPayload>,
  ): Promise<ProfitEventEnvelope<TPayload>>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export type EventWriterOptions = {
  rootDir?: string;
  runId?: string;
  sessionId?: string;
  commitSha?: string;
  nowMs?: () => number;
  monotonicNs?: () => bigint;
  exactFilePath?: string;
};

export class NoopEventWriter implements EventWriter {
  readonly runId: string;
  readonly sessionId: string;
  private readonly context: ProfitEventContext;
  readonly events: ProfitEventEnvelope[] = [];

  constructor(opts: EventWriterOptions = {}) {
    this.runId = opts.runId ?? `run-${crypto.randomUUID()}`;
    this.sessionId = opts.sessionId ?? crypto.randomUUID();
    this.context = {
      runId: this.runId,
      sessionId: this.sessionId,
      commitSha: opts.commitSha ?? gitCommitFromEnv(),
      nowMs: opts.nowMs,
      monotonicNs: opts.monotonicNs,
    };
  }

  async append<TPayload extends ProfitEventPayload>(
    event: ProfitEventInput<TPayload>,
  ): Promise<ProfitEventEnvelope<TPayload>> {
    const envelope = createProfitEvent(this.context, event);
    this.events.push(envelope);
    return envelope;
  }

  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

export class NdjsonEventWriter implements EventWriter {
  readonly runId: string;
  readonly sessionId: string;
  readonly filePath: string;
  private readonly context: ProfitEventContext;
  private handle: FileHandle | null = null;
  private closed = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: EventWriterOptions = {}) {
    this.runId = opts.runId ?? `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
    this.sessionId = opts.sessionId ?? crypto.randomUUID();
    if (opts.exactFilePath) {
      this.filePath = opts.exactFilePath;
    } else {
      const rootDir = opts.rootDir ?? path.join("logs", "events");
      this.filePath = path.join(rootDir, this.runId, "events.ndjson");
    }
    this.context = {
      runId: this.runId,
      sessionId: this.sessionId,
      commitSha: opts.commitSha ?? gitCommitFromEnv(),
      nowMs: opts.nowMs,
      monotonicNs: opts.monotonicNs,
    };
  }

  async append<TPayload extends ProfitEventPayload>(
    event: ProfitEventInput<TPayload>,
  ): Promise<ProfitEventEnvelope<TPayload>> {
    if (this.closed) throw new Error("event writer is closed");
    const envelope = createProfitEvent(this.context, event);
    const line = safeStringify(envelope) + "\n";
    this.writeChain = this.writeChain.then(async () => {
      const handle = await this.openHandle();
      await handle.write(line);
    });
    await this.writeChain;
    return envelope;
  }

  async flush(): Promise<void> {
    await this.writeChain;
    if (this.handle) await this.handle.sync();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
    this.closed = true;
  }

  private async openHandle(): Promise<FileHandle> {
    if (this.handle) return this.handle;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    this.handle = await open(this.filePath, "a");
    return this.handle;
  }
}

export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, raw) => {
    if (typeof raw === "bigint") return raw.toString();
    if (typeof raw === "number" && !Number.isFinite(raw)) return null;
    if (raw instanceof Date) return raw.toISOString();
    if (raw instanceof Error) {
      return {
        name: raw.name,
        message: raw.message,
        stack: raw.stack,
      };
    }
    if (typeof raw === "object" && raw !== null) {
      if (seen.has(raw)) return "[Circular]";
      seen.add(raw);
    }
    return raw;
  });
}
