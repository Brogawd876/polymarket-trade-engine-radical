import { describe, expect, test, spyOn } from "bun:test";
import { fetchWithRetry } from "../../utils/fetch-retry.ts";
import { MaintenanceTracker } from "../../utils/maintenance.ts";

describe("HTTP 425 & Maintenance Hardening", () => {
  test("exponential backoff on HTTP 425", async () => {
    let callCount = 0;
    const mockFetch = spyOn(globalThis, "fetch").mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        return new Response("Too Early", { status: 425 });
      }
      return new Response(JSON.stringify({ success: true }));
    });

    const delays: number[] = [];
    const res = await fetchWithRetry("http://localhost/test", {
      totalRetry: 5,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    expect(callCount).toBe(3);
    expect(res.status).toBe(200);
    expect(delays).toEqual([5000, 10000]);
    
    mockFetch.mockRestore();
  });

  test("MaintenanceTracker records 425 and pauses activity", () => {
    const tracker = new MaintenanceTracker(60_000); // 1m cooldown
    expect(tracker.isActive().active).toBe(false);

    tracker.record425(1000);
    const check1 = tracker.isActive(2000);
    expect(check1.active).toBe(true);
    expect(check1.reason).toContain("HTTP 425");

    // Cooldown expires
    expect(tracker.isActive(70000).active).toBe(false);
  });
});
