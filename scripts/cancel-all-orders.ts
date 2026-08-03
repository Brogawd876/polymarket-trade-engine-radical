/**
 * Intentionally tombstoned.
 *
 * The previous utility derived multiple credentials, printed credential
 * identifiers and issued unjournaled cancel sweeps outside the authoritative
 * lifecycle/outbox/reconciliation kernel. That behavior can create orphan
 * state and is not a safe production recovery mechanism.
 */
throw new Error(
  "cancel-all-orders is disabled: cancellations must be journaled and reconciled through the authoritative execution kernel",
);
