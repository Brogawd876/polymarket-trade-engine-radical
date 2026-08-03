import { DurableJournal } from "./journal.ts";
import { LotLedger } from "./ledger.ts";
import { OrderLifecycleManager } from "./order-lifecycle.ts";
import { ExecutionOutbox } from "./outbox.ts";
import {
  ReconciliationService,
  type ExchangeReconciliationSnapshot,
  type ReconciliationResult,
} from "./reconciliation.ts";

/**
 * Restart-safe composition root for all capital-changing local state.
 * Exchange submission remains outside this object and is only legal after the
 * command has been persisted in `outbox`.
 */
export class ProductionAuthority {
  private constructor(
    readonly journal: DurableJournal,
    readonly ledger: LotLedger,
    readonly lifecycle: OrderLifecycleManager,
    readonly outbox: ExecutionOutbox,
    readonly reconciliation: ReconciliationService,
  ) {}

  static async open(input: {
    journalPath: string;
    initialCash?: string;
    nowMs?: () => number;
  }): Promise<ProductionAuthority> {
    const journal = await DurableJournal.open(input.journalPath, {
      nowMs: input.nowMs,
    });
    const lifecycle = new OrderLifecycleManager(journal, input.nowMs);
    lifecycle.restoreFromJournal(journal.records());
    const outbox = new ExecutionOutbox(journal, input.nowMs);
    outbox.restoreFromJournal(journal.records());
    const ledger = await LotLedger.open(journal, input.initialCash);
    const reconciliation = new ReconciliationService(
      journal,
      outbox,
      lifecycle,
    );
    return new ProductionAuthority(
      journal,
      ledger,
      lifecycle,
      outbox,
      reconciliation,
    );
  }

  async startup(
    exchange: ExchangeReconciliationSnapshot,
  ): Promise<ReconciliationResult> {
    const result = await this.reconciliation.reconcile(
      "STARTUP",
      this.ledger.snapshot(),
      exchange,
    );
    this.reconciliation.assertReadyForNewTrading();
    return result;
  }

  async onUserChannelOutage(
    exchange: ExchangeReconciliationSnapshot,
  ): Promise<ReconciliationResult> {
    return this.reconciliation.reconcile(
      "USER_CHANNEL_OUTAGE",
      this.ledger.snapshot(),
      exchange,
    );
  }

  async shutdown(exchange: ExchangeReconciliationSnapshot): Promise<void> {
    await this.reconciliation.reconcile(
      "SHUTDOWN",
      this.ledger.snapshot(),
      exchange,
    );
    this.reconciliation.assertShutdownComplete();
    await this.journal.close();
  }
}
