import type { AuthoritativeJournal, JournalRecord } from "./journal.ts";

export type OutboxState =
  | "QUEUED"
  | "SUBMITTING"
  | "AMBIGUOUS"
  | "ACKNOWLEDGED"
  | "RESOLVED"
  | "FAILED";

export type ExecutionCommand = {
  executionCommandId: string;
  intentId: string;
  clientCorrelationId: string;
  kind: "SUBMIT" | "CANCEL";
  payload: Record<string, unknown>;
  state: OutboxState;
  attemptCount: number;
  exchangeOrderId?: string;
  lastError?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

const ALLOWED: Record<OutboxState, ReadonlySet<OutboxState>> = {
  QUEUED: new Set(["SUBMITTING", "FAILED"]),
  SUBMITTING: new Set(["AMBIGUOUS", "ACKNOWLEDGED", "FAILED"]),
  AMBIGUOUS: new Set(["ACKNOWLEDGED", "RESOLVED", "FAILED"]),
  ACKNOWLEDGED: new Set(["RESOLVED"]),
  RESOLVED: new Set([]),
  FAILED: new Set([]),
};

export class ExecutionOutbox {
  private readonly commands = new Map<string, ExecutionCommand>();

  constructor(
    private readonly journal: AuthoritativeJournal,
    private readonly nowMs: () => number = Date.now,
  ) {}

  async enqueue(
    command: Omit<ExecutionCommand, "state" | "attemptCount" | "createdAtMs" | "updatedAtMs">,
  ): Promise<ExecutionCommand> {
    if (this.commands.has(command.executionCommandId)) {
      throw new Error(`duplicate execution command ${command.executionCommandId}`);
    }
    if (
      [...this.commands.values()].some(
        (existing) =>
          existing.clientCorrelationId === command.clientCorrelationId,
      )
    ) {
      throw new Error(
        `duplicate client correlation id ${command.clientCorrelationId}`,
      );
    }
    const now = this.nowMs();
    const queued: ExecutionCommand = {
      ...structuredClone(command),
      state: "QUEUED",
      attemptCount: 0,
      createdAtMs: now,
      updatedAtMs: now,
    };
    await this.journal.append({
      kind: "execution_command_queued",
      aggregateId: queued.executionCommandId,
      payload: queued,
    });
    this.commands.set(queued.executionCommandId, queued);
    return structuredClone(queued);
  }

  async transition(
    executionCommandId: string,
    next: OutboxState,
    details: { exchangeOrderId?: string; error?: string } = {},
  ): Promise<ExecutionCommand> {
    const current = this.require(executionCommandId);
    if (!ALLOWED[current.state].has(next)) {
      throw new Error(
        `illegal outbox transition ${executionCommandId}: ${current.state} -> ${next}`,
      );
    }
    const updated: ExecutionCommand = {
      ...current,
      state: next,
      attemptCount:
        next === "SUBMITTING" ? current.attemptCount + 1 : current.attemptCount,
      exchangeOrderId: details.exchangeOrderId ?? current.exchangeOrderId,
      lastError: details.error,
      updatedAtMs: this.nowMs(),
    };
    await this.journal.append({
      kind: "execution_command_state_changed",
      aggregateId: executionCommandId,
      payload: updated,
    });
    this.commands.set(executionCommandId, updated);
    return structuredClone(updated);
  }

  /**
   * An ambiguous submission is never retried here. The caller must query by
   * correlation/order evidence and resolve this command first.
   */
  assertCanSubmit(executionCommandId: string): void {
    const command = this.require(executionCommandId);
    if (command.state === "AMBIGUOUS") {
      throw new Error(
        `ambiguous command ${executionCommandId} requires reconciliation before retry`,
      );
    }
    if (command.attemptCount > 0 && command.state !== "QUEUED") {
      throw new Error(`blind retry blocked for ${executionCommandId}`);
    }
    if (command.state !== "QUEUED") {
      throw new Error(
        `command ${executionCommandId} is not submit-ready (${command.state})`,
      );
    }
  }

  restore(commands: readonly ExecutionCommand[]): void {
    for (const command of commands) {
      if (this.commands.has(command.executionCommandId)) {
        throw new Error(`duplicate restored command ${command.executionCommandId}`);
      }
      this.commands.set(command.executionCommandId, structuredClone(command));
    }
  }

  restoreFromJournal(records: readonly JournalRecord[]): void {
    const latest = new Map<string, ExecutionCommand>();
    for (const event of records) {
      if (
        event.kind !== "execution_command_queued" &&
        event.kind !== "execution_command_state_changed"
      ) {
        continue;
      }
      latest.set(
        event.aggregateId,
        structuredClone(event.payload) as ExecutionCommand,
      );
    }
    this.restore([...latest.values()]);
  }

  get(executionCommandId: string): ExecutionCommand | null {
    const command = this.commands.get(executionCommandId);
    return command ? structuredClone(command) : null;
  }

  all(): ExecutionCommand[] {
    return [...this.commands.values()].map((command) => structuredClone(command));
  }

  unresolved(): ExecutionCommand[] {
    return this.all().filter(
      (command) => command.state !== "RESOLVED" && command.state !== "FAILED",
    );
  }

  private require(executionCommandId: string): ExecutionCommand {
    const command = this.commands.get(executionCommandId);
    if (!command) throw new Error(`unknown execution command ${executionCommandId}`);
    return command;
  }
}
