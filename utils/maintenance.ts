/**
 * Polymarket Maintenance Utilities
 */

/**
 * Checks if the current time falls within the known Polymarket weekly maintenance window.
 * Polymarket typically restarts their matching engine on Tuesdays around 7:00 AM ET.
 * We block trading 5 minutes before and after this window for safety.
 */
export function isPolymarketMaintenance(now: Date = new Date()): {
  inWindow: boolean;
  reason?: string;
} {
  // Convert to Eastern Time (New York)
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    weekday: "long",
    hour: "numeric",
    minute: "numeric",
  });

  const parts = formatter.formatToParts(now);
  const find = (type: string) => parts.find((p) => p.type === type)?.value;

  const weekday = find("weekday");
  const hour = parseInt(find("hour") ?? "-1", 10);
  const minute = parseInt(find("minute") ?? "-1", 10);

  // Tuesday 7:00 AM ET window
  if (weekday === "Tuesday") {
    // 6:55 AM to 7:15 AM
    const totalMinutes = hour * 60 + minute;
    const startWindow = 6 * 60 + 55;
    const endWindow = 7 * 60 + 15;

    if (totalMinutes >= startWindow && totalMinutes <= endWindow) {
      return {
        inWindow: true,
        reason: "Polymarket Tuesday 7:00 AM ET matching engine restart window",
      };
    }
  }

  return { inWindow: false };
}

/**
 * MaintenanceTracker manages both scheduled and unscheduled (HTTP 425) 
 * maintenance states.
 */
export class MaintenanceTracker {
  private _unscheduledActive = false;
  private _last425At = 0;
  private _cooldownMs: number;

  constructor(cooldownMs = 300_000) {
    this._cooldownMs = cooldownMs;
  }

  /** Mark that an HTTP 425 was received. */
  record425(nowMs: number = Date.now()) {
    this._unscheduledActive = true;
    this._last425At = nowMs;
  }

  /** Returns true if either scheduled or unscheduled maintenance is active. */
  isActive(nowMs: number = Date.now()): { active: boolean; reason?: string } {
    // 1. Check unscheduled (425) state
    if (this._unscheduledActive) {
      if (nowMs - this._last425At > this._cooldownMs) {
        this._unscheduledActive = false;
      } else {
        return {
          active: true,
          reason: "Unscheduled matching engine restart (HTTP 425 cooldown)",
        };
      }
    }

    // 2. Check scheduled window
    const scheduled = isPolymarketMaintenance(new Date(nowMs));
    if (scheduled.inWindow) {
      return { active: true, reason: scheduled.reason };
    }

    return { active: false };
  }
}
