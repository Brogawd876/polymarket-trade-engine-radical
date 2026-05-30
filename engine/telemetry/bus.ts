import type { TelemetryEvent, TelemetrySink } from "./types.ts";

/**
 * A non-blocking engine-level event bus for telemetry.
 * Decouples the hot trading loop from the UI/analytics consumers.
 */
export class TelemetryBus implements TelemetrySink {
  private _subscribers = new Set<(event: TelemetryEvent) => void>();

  /**
   * Add a subscriber. Returns an unsubscribe function.
   */
  subscribe(handler: (event: TelemetryEvent) => void): () => void {
    this._subscribers.add(handler);
    return () => this._subscribers.delete(handler);
  }

  /**
   * Push an event to all subscribers.
   * Execution is synchronous but wrapped in a try/catch to ensure 
   * a single failing subscriber doesn't crash the engine.
   */
  push(event: TelemetryEvent): void {
    for (const sub of this._subscribers) {
      try {
        sub(event);
      } catch (e) {
        // Log telemetry internal failure but do not rethrow
        console.error("[TelemetryBus] Error in subscriber:", e);
      }
    }
  }
}

/**
 * A Null implementation of TelemetrySink for testing or headless CLI runs.
 */
export class NullTelemetrySink implements TelemetrySink {
  push(_event: TelemetryEvent): void {}
}
