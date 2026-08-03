import { createHash, randomUUID } from "crypto";
import { mkdir, open, readFile, type FileHandle } from "fs/promises";
import { dirname } from "path";

export const JOURNAL_SCHEMA_VERSION = 1 as const;

export type JournalPayload = Record<string, unknown>;

export type JournalRecord = {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  sequence: number;
  eventId: string;
  occurredAtMs: number;
  kind: string;
  aggregateId: string;
  payload: JournalPayload;
  previousHash: string;
  hash: string;
};

export type AppendJournalInput = {
  eventId?: string;
  occurredAtMs?: number;
  kind: string;
  aggregateId: string;
  payload: JournalPayload;
};

export interface AuthoritativeJournal {
  append(input: AppendJournalInput): Promise<JournalRecord>;
  records(): readonly JournalRecord[];
  flush(): Promise<void>;
  close(): Promise<void>;
}
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "bigint") return value.toString();
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("journal payload contains a non-finite number");
  }
  return value;
}

function hashRecord(record: Omit<JournalRecord, "hash">): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(record)))
    .digest("hex");
}

function buildRecord(
  previous: JournalRecord | undefined,
  input: AppendJournalInput,
  nowMs: () => number,
): JournalRecord {
  const withoutHash: Omit<JournalRecord, "hash"> = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    sequence: (previous?.sequence ?? 0) + 1,
    eventId: input.eventId ?? randomUUID(),
    occurredAtMs: input.occurredAtMs ?? nowMs(),
    kind: input.kind,
    aggregateId: input.aggregateId,
    payload: canonicalize(input.payload) as JournalPayload,
    previousHash: previous?.hash ?? "GENESIS",
  };
  return { ...withoutHash, hash: hashRecord(withoutHash) };
}

export function verifyJournalRecords(records: readonly JournalRecord[]): void {
  const eventIds = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const previous = records[index - 1];
    if (record.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
      throw new Error(
        `unsupported journal schema ${record.schemaVersion} at sequence ${record.sequence}`,
      );
    }
    if (record.sequence !== index + 1) {
      throw new Error(`journal sequence gap at ${index + 1}`);
    }
    if (record.previousHash !== (previous?.hash ?? "GENESIS")) {
      throw new Error(`journal hash-chain break at sequence ${record.sequence}`);
    }
    const { hash, ...withoutHash } = record;
    if (hashRecord(withoutHash) !== hash) {
      throw new Error(`journal record hash mismatch at sequence ${record.sequence}`);
    }
    if (eventIds.has(record.eventId)) {
      throw new Error(`duplicate journal event id ${record.eventId}`);
    }
    eventIds.add(record.eventId);
  }
}

export class MemoryJournal implements AuthoritativeJournal {
  private readonly entries: JournalRecord[] = [];

  constructor(private readonly nowMs: () => number = Date.now) {}

  async append(input: AppendJournalInput): Promise<JournalRecord> {
    if (input.eventId && this.entries.some((entry) => entry.eventId === input.eventId)) {
      throw new Error(`duplicate journal event id ${input.eventId}`);
    }
    const record = buildRecord(this.entries.at(-1), input, this.nowMs);
    this.entries.push(record);
    return record;
  }

  records(): readonly JournalRecord[] {
    return this.entries.map((entry) => structuredClone(entry));
  }

  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

export class DurableJournal implements AuthoritativeJournal {
  private readonly entries: JournalRecord[];
  private handle: FileHandle | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private isClosed = false;

  private constructor(
    readonly filePath: string,
    entries: JournalRecord[],
    private readonly nowMs: () => number,
  ) {
    this.entries = entries;
  }

  static async open(
    filePath: string,
    opts: { nowMs?: () => number } = {},
  ): Promise<DurableJournal> {
    let entries: JournalRecord[] = [];
    try {
      const raw = await readFile(filePath, "utf8");
      if (raw.length > 0 && !raw.endsWith("\n")) {
        throw new Error("journal ends with an incomplete record");
      }
      entries = raw
        .split("\n")
        .filter(Boolean)
        .map((line, index) => {
          try {
            return JSON.parse(line) as JournalRecord;
          } catch (error) {
            throw new Error(
              `invalid journal JSON at line ${index + 1}: ${String(error)}`,
            );
          }
        });
      verifyJournalRecords(entries);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
    return new DurableJournal(filePath, entries, opts.nowMs ?? Date.now);
  }

  async append(input: AppendJournalInput): Promise<JournalRecord> {
    if (this.isClosed) throw new Error("journal is closed");
    if (input.eventId && this.entries.some((entry) => entry.eventId === input.eventId)) {
      throw new Error(`duplicate journal event id ${input.eventId}`);
    }
    const record = buildRecord(this.entries.at(-1), input, this.nowMs);
    const line = `${JSON.stringify(record)}\n`;
    this.writeChain = this.writeChain.then(async () => {
      const handle = await this.openHandle();
      await handle.write(line);
      await handle.sync();
      this.entries.push(record);
    });
    await this.writeChain;
    return structuredClone(record);
  }

  records(): readonly JournalRecord[] {
    return this.entries.map((entry) => structuredClone(entry));
  }

  async flush(): Promise<void> {
    await this.writeChain;
    if (this.handle) await this.handle.sync();
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    await this.flush();
    await this.handle?.close();
    this.handle = null;
    this.isClosed = true;
  }

  private async openHandle(): Promise<FileHandle> {
    if (this.handle) return this.handle;
    await mkdir(dirname(this.filePath), { recursive: true });
    this.handle = await open(this.filePath, "a");
    return this.handle;
  }
}
