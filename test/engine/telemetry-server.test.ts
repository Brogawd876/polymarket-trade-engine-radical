import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { 
    TelemetryBus, 
    ControlServer, 
    VirtualClock,
    ReplayLogReader,
    ReplayRunner
} from "../../engine/bot-core/index.ts";
import { EarlyBird } from "../../engine/early-bird.ts";
import { SessionManager } from "../../engine/session-manager.ts";
import { join } from "path";

describe("Telemetry & Control Plane Hardening", () => {
  test("TelemetryBus dispatches events to multiple subscribers", () => {
    const bus = new TelemetryBus();
    let count1 = 0;
    let count2 = 0;

    bus.subscribe(() => count1++);
    const unsub2 = bus.subscribe(() => count2++);

    bus.push({ ts: 100, type: "MARKET_TICK", payload: { slug: "test", asset: "btc", price: 100, bid: 99, ask: 101 } });
    
    expect(count1).toBe(1);
    expect(count2).toBe(1);

    unsub2();
    bus.push({ ts: 101, type: "MARKET_TICK", payload: { slug: "test", asset: "btc", price: 102, bid: 101, ask: 103 } });

    expect(count1).toBe(2);
    expect(count2).toBe(1);
  });

  test("ControlServer REST endpoints (health/status)", async () => {
    const bus = new TelemetryBus();
    const sessionManager = new SessionManager(bus);
    // Mock the session manager's bot status
    (sessionManager as any)._bot = new EarlyBird("simulation", 1, false, 1, false);

    const server = new ControlServer({ port: 3005, telemetryBus: bus, sessionManager });
    server.start();

    try {
      const health = await fetch("http://127.0.0.1:3005/api/health");
      expect(health.status).toBe(200);
      const healthData = await health.json() as any;
      expect(healthData.controlPlane).toBe("HEALTHY");
      expect(healthData.tradingReadiness).toBe("BLOCKED");
      expect(healthData.dependencies.reconciliation.status).toBe("UNKNOWN");

      const status = await fetch("http://127.0.0.1:3005/api/status");
      expect(status.status).toBe(200);
      const data = await status.json() as any;
      expect(data.mode).toBe("sim");
      expect(data.strategy).toBe("simulation");
    } finally {
      server.stop();
    }
  });

  test("ControlServer WebSocket telemetry stream", async () => {
    const bus = new TelemetryBus();
    const sessionManager = new SessionManager(bus);
    const server = new ControlServer({ port: 3006, telemetryBus: bus, sessionManager });
    server.start();

    try {
      const ws = new WebSocket("ws://127.0.0.1:3006/telemetry");
      let received: any[] = [];
      ws.onmessage = (e) => received.push(JSON.parse(e.data));

      await new Promise(r => setTimeout(r, 100)); // wait for connect
      
      const evt: any = { ts: 200, type: "SYSTEM_BOOT", payload: { version: "1.0", mode: "sim", strategy: "test" } };
      bus.push(evt);

      await new Promise(r => setTimeout(r, 100)); // wait for dispatch
      
      expect(received.length).toBe(1);
      expect(received[0].type).toBe("SYSTEM_BOOT");
      ws.close();
    } finally {
      server.stop();
    }
  });

  test("ControlServer protects operator endpoints when OPERATOR_AUTH_TOKEN is set", async () => {
    const originalToken = process.env.OPERATOR_AUTH_TOKEN;
    process.env.OPERATOR_AUTH_TOKEN = "test-operator-token";

    const bus = new TelemetryBus();
    const sessionManager = new SessionManager(bus);
    const server = new ControlServer({ port: 3008, telemetryBus: bus, sessionManager });
    server.start();

    const protectedRequests: Array<[string, RequestInit | undefined]> = [
      ["/api/operator/status", undefined],
      ["/api/operator/simulation/start", { method: "POST", body: "{}" }],
      ["/api/operator/replay/start", { method: "POST", body: "{}" }],
      ["/api/operator/session/stop", { method: "POST" }],
      ["/api/operator/simulation/reset-state", { method: "POST" }],
      ["/api/operator/strategy/presets", { method: "POST", body: "{}" }],
      ["/api/operator/strategy-lab/experiments", { method: "POST", body: "{}" }],
      ["/api/operator/tiny-live/unlock", { method: "POST", body: "{}" }],
      ["/api/operator/config", undefined],
      ["/api/operator/logs", undefined],
    ];

    try {
      const health = await fetch("http://127.0.0.1:3008/api/health");
      expect(health.status).toBe(200);

      for (const [path, init] of protectedRequests) {
        const res = await fetch(`http://127.0.0.1:3008${path}`, init);
        expect(res.status).toBe(401);
      }

      const authorized = await fetch("http://127.0.0.1:3008/api/operator/status", {
        headers: { Authorization: "Bearer test-operator-token" },
      });
      expect(authorized.status).toBe(200);

      const legacyStatus = await fetch("http://127.0.0.1:3008/api/status");
      expect(legacyStatus.status).toBe(401);
      const telemetry = await fetch("http://127.0.0.1:3008/telemetry");
      expect(telemetry.status).toBe(401);
    } finally {
      server.stop();
      if (originalToken === undefined) {
        delete process.env.OPERATOR_AUTH_TOKEN;
      } else {
        process.env.OPERATOR_AUTH_TOKEN = originalToken;
      }
    }
  });

  test("ControlServer forwards replay strategy to SessionManager", async () => {
    const originalToken = process.env.OPERATOR_AUTH_TOKEN;
    delete process.env.OPERATOR_AUTH_TOKEN;

    const bus = new TelemetryBus();
    const sessionManager = new SessionManager(bus);
    const calls: Array<{ file: string; config: { strategy?: string } }> = [];
    (sessionManager as any).startReplay = async (file: string, config: { strategy?: string } = {}) => {
      calls.push({ file, config });
    };

    const server = new ControlServer({ port: 3009, telemetryBus: bus, sessionManager });
    server.start();

    try {
      const response = await fetch("http://127.0.0.1:3009/api/operator/replay/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: "logs/captured-round.log", strategy: "late-entry" }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
      expect(calls).toEqual([{ file: "logs/captured-round.log", config: { strategy: "late-entry" } }]);
    } finally {
      server.stop();
      if (originalToken === undefined) {
        delete process.env.OPERATOR_AUTH_TOKEN;
      } else {
        process.env.OPERATOR_AUTH_TOKEN = originalToken;
      }
    }
  });

  test("ControlServer cannot smuggle prod through the simulation endpoint", async () => {
    const bus = new TelemetryBus();
    const sessionManager = new SessionManager(bus);
    const server = new ControlServer({
      port: 3010,
      telemetryBus: bus,
      sessionManager,
    });
    server.start();

    try {
      const response = await fetch(
        "http://127.0.0.1:3010/api/operator/simulation/start",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ strategy: "simulation", prod: true }),
        },
      );
      const body = (await response.json()) as {
        success: boolean;
        error: string;
      };

      expect(response.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error).toContain("live exchange submission is disabled");
      expect(sessionManager.getStatus().sessionState).toBe("idle");
    } finally {
      server.stop();
    }
  });

  test("ControlServer live promotion and unlock endpoints are tombstoned", async () => {
    const originalToken = process.env.OPERATOR_AUTH_TOKEN;
    delete process.env.OPERATOR_AUTH_TOKEN;
    const bus = new TelemetryBus();
    const sessionManager = new SessionManager(bus);
    const server = new ControlServer({
      port: 3011,
      telemetryBus: bus,
      sessionManager,
    });
    server.start();

    try {
      for (const path of [
        "/api/operator/strategy/presets/simulation/promote-paper-candidate",
        "/api/operator/tiny-live/unlock",
      ]) {
        const response = await fetch(`http://127.0.0.1:3011${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            presetId: "simulation",
            operatorAck: true,
          }),
        });
        const body = (await response.json()) as {
          success: boolean;
          error: string;
        };
        expect(response.status).toBe(423);
        expect(body.success).toBe(false);
        expect(body.error).toMatch(/disabled|unpassed/);
      }

    } finally {
      server.stop();
      if (originalToken === undefined) {
        delete process.env.OPERATOR_AUTH_TOKEN;
      } else {
        process.env.OPERATOR_AUTH_TOKEN = originalToken;
      }
    }
  });

  test("ControlServer refuses production startup without operator authentication", () => {
    const originalToken = process.env.OPERATOR_AUTH_TOKEN;
    const originalNodeEnv = process.env.NODE_ENV;
    delete process.env.OPERATOR_AUTH_TOKEN;
    process.env.NODE_ENV = "production";
    const server = new ControlServer({
      port: 3011,
      telemetryBus: new TelemetryBus(),
      sessionManager: new SessionManager(new TelemetryBus()),
    });
    try {
      expect(() => server.start()).toThrow(
        "OPERATOR_AUTH_TOKEN is mandatory outside local development",
      );
    } finally {
      server.stop();
      if (originalToken === undefined) delete process.env.OPERATOR_AUTH_TOKEN;
      else process.env.OPERATOR_AUTH_TOKEN = originalToken;
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  test("Replay telemetry integration", async () => {
    const logPath = join(import.meta.dir, "..", "fixtures", "replay", "expired-order.log");
    const clock = new VirtualClock();
    const telemetryBus = new TelemetryBus();
    
    let events: string[] = [];
    telemetryBus.subscribe(e => events.push(e.type));

    const bot = new EarlyBird("simulation", 1, false, 1, true, logPath, { clock, persistState: false, telemetry: telemetryBus });
    const reader = bot.replayReader!;
    const runner = new ReplayRunner(reader, bot, clock, telemetryBus);

    await runner.run();

    expect(events).toContain("SYSTEM_BOOT");
    expect(events).toContain("REPLAY_PROGRESS");
    expect(events).toContain("LIFECYCLE_STATE");
    expect(events).toContain("SESSION_PNL");
  });

  test("ControlServer remains responsive while an incomplete replay fails closed", async () => {
    const logPath = join(import.meta.dir, "..", "fixtures", "replay", "filled-order.log");
    const telemetryBus = new TelemetryBus();
    const sessionManager = new SessionManager(telemetryBus);
    const server = new ControlServer({ port: 3007, telemetryBus, sessionManager });

    server.start();
    try {
      await sessionManager.startReplay(logPath);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1_000);
      const status = await fetch("http://127.0.0.1:3007/api/status", {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      expect(status.status).toBe(200);
      const data = await status.json() as any;
      expect(data.mode).toBe("replay");

      for (let attempt = 0; attempt < 100; attempt++) {
        if (sessionManager.getStatus().sessionState === "failed") break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(sessionManager.getStatus().sessionState).toBe("failed");
      expect(sessionManager.getStatus().blockReason).toContain(
        "replay ended without explicit settlement evidence",
      );
    } finally {
      server.stop();
    }
  }, 30_000);
});
