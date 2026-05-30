/**
 * TerminalAccessError represents a non-retryable failure to access
 * external infrastructure, typically due to region restrictions (geoblocking)
 * or explicit IP blacklisting.
 */
export class TerminalAccessError extends Error {
  constructor(message: string, public readonly status?: number, public readonly body?: string) {
    super(message);
    this.name = "TerminalAccessError";
  }
}

/**
 * FatalEngineError is the base class for engine-stopping conditions
 * that should be handled gracefully by the session manager or CLI.
 */
export class FatalEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalEngineError";
  }
}

export class InsufficientBalanceError extends FatalEngineError {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientBalanceError";
  }
}

export class LossLimitExceededError extends FatalEngineError {
  constructor(message: string) {
    super(message);
    this.name = "LossLimitExceededError";
  }
}

/**
 * Heuristic check to see if a response body looks like a Cloudflare or
 * provider-level block page.
 */
export function isBlockedBody(body: string): boolean {
  const lower = body.toLowerCase();
  return (
    lower.includes("access denied") ||
    lower.includes("error code 1020") ||
    lower.includes("restricted access") ||
    lower.includes("not available in your country") ||
    lower.includes("cloudflare") && lower.includes("403")
  );
}

