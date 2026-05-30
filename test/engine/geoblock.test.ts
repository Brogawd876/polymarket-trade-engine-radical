import { describe, expect, test, spyOn, afterEach } from "bun:test";
import { fetchWithRetry } from "../../utils/fetch-retry";
import { TerminalAccessError, isBlockedBody } from "../../utils/errors";
import { createReconnectingWs } from "../../utils/reconnecting-ws";

describe("Region / Geoblock Detection", () => {
  afterEach(() => {
    spyOn(global, "fetch").mockRestore();
  });

  test("isBlockedBody detects common block strings", () => {
    expect(isBlockedBody("Access Denied")).toBe(true);
    expect(isBlockedBody("Error code 1020")).toBe(true);
    expect(isBlockedBody("not available in your country")).toBe(true);
    expect(isBlockedBody("Cloudflare" + "403")).toBe(true);
    expect(isBlockedBody("Normal response")).toBe(false);
  });

  test("fetchWithRetry classifies 403 as TerminalAccessError", async () => {
    spyOn(global, "fetch").mockImplementation((async () => {
      return new Response("Forbidden", { status: 403 });
    }) as any);

    try {
      await fetchWithRetry("https://example.com");
      expect(false).toBe(true); // Should not reach here
    } catch (e: any) {
      expect(e).toBeInstanceOf(TerminalAccessError);
      expect((e as TerminalAccessError).status).toBe(403);
    }
  });

  test("fetchWithRetry classifies blocked body as TerminalAccessError", async () => {
    spyOn(global, "fetch").mockImplementation((async () => {
      return new Response("Access Denied by Cloudflare", { status: 500 });
    }) as any);

    try {
      await fetchWithRetry("https://example.com");
      expect(false).toBe(true); 
    } catch (e: any) {
      expect(e).toBeInstanceOf(TerminalAccessError);
      expect(e.message).toContain("Access Blocked");
    }
  });

  test("createReconnectingWs stops retrying on terminal closure", async () => {
    // Mock WebSocket to simulate terminal close
    let connectCount = 0;
    const mockWS = {
        send: () => {},
        close: () => {},
    };

    // We need to globalize WebSocket for createReconnectingWs to use it
    const originalWS = global.WebSocket;
    (global as any).WebSocket = class {
        onclose: any;
        constructor() {
            connectCount++;
            setTimeout(() => {
                const event = {
                    code: 4003,
                    reason: "Forbidden Region",
                };
                if (this.onclose) this.onclose(event);
            }, 10);
        }
        close() {}
    };

    const ws = createReconnectingWs({
        url: "ws://example.com",
        isTerminal: (event) => {
            if (event.code === 4003) return "Terminal block";
            return null;
        },
        onmessage: () => {},
    });

    await new Promise(r => setTimeout(r, 100));
    
    // Should have only connected once
    expect(connectCount).toBe(1);

    global.WebSocket = originalWS;
    ws.destroy();
  });
});
