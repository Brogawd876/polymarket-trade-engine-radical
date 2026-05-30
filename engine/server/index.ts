import { type Server, type ServerWebSocket } from "bun";
import { TelemetryBus, type TelemetryEvent } from "../telemetry/index.ts";
import type { SessionManager } from "../session-manager.ts";
import { readdir } from "fs/promises";
import * as path from "path";
import { validateReplayFixture } from "./helpers/replay-fixtures.ts";
import { StrategyLabBatchManager } from "../strategy-lab.ts";
import { Env } from "../../utils/config.ts";
import { LiveReadinessManager } from "../live-readiness.ts";

export type ControlServerOptions = {
  port?: number;
  telemetryBus: TelemetryBus;
  sessionManager: SessionManager;
  allowedOrigins?: string[];
};

/**
 * ControlPlane Server using Bun.serve.
 * Provides a WebSocket telemetry stream and REST control endpoints.
 */
export class ControlServer {
  private _server?: Server<{ sessionId: string }>;
  private _telemetryBus: TelemetryBus;
  private _sessionManager: SessionManager;
  private _strategyLab: StrategyLabBatchManager;
  private _liveReadiness: LiveReadinessManager;
  private _port: number;
  private _allowedOrigins: Set<string>;

  constructor(opts: ControlServerOptions) {
    this._port = opts.port ?? 3000;
    this._telemetryBus = opts.telemetryBus;
    this._sessionManager = opts.sessionManager;
    this._strategyLab = new StrategyLabBatchManager();
    this._liveReadiness = new LiveReadinessManager(this._strategyLab);
    this._sessionManager.setPaperEvidenceRecorder(async (evidence) => {
      await this._liveReadiness.recordPaperEvidence(evidence);
    });
    this._allowedOrigins = new Set(opts.allowedOrigins ?? [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:5174",
      "http://127.0.0.1:5174",
      "http://localhost:5175",
      "http://127.0.0.1:5175",
      "http://localhost:5176",
      "http://127.0.0.1:5176",
    ]);
  }

  start() {
    const bus = this._telemetryBus;
    const allowedOrigins = this._allowedOrigins;

    this._server = Bun.serve<{ sessionId: string }>({
      port: this._port,
      hostname: "127.0.0.1", // Bind to localhost only for security
      
      fetch: async (req, server) => {
        const url = new URL(req.url);
        const origin = req.headers.get("origin");
        const responseHeaders = new Headers();
        if (origin && allowedOrigins.has(origin)) {
          responseHeaders.set("Access-Control-Allow-Origin", origin);
          responseHeaders.set("Vary", "Origin");
        }

        responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        responseHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization");

        // Security: Origin validation
        if (origin && !allowedOrigins.has(origin)) {
            return new Response("Unauthorized Origin", { status: 403 });
        }

        if (req.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: responseHeaders });
        }

        // Auth Token Validation (Optional but recommended for production)
        const authToken = Env.get("OPERATOR_AUTH_TOKEN");
        if (authToken && url.pathname.startsWith("/api/operator/")) {
            const authHeader = req.headers.get("Authorization");
            if (!authHeader || authHeader !== `Bearer ${authToken}`) {
                return new Response("Unauthorized: Invalid or missing Operator Token", { 
                    status: 401, 
                    headers: responseHeaders 
                });
            }
        }
        // WebSocket Telemetry Path
        if (url.pathname === "/telemetry") {
          const success = server.upgrade(req, {
            data: { sessionId: crypto.randomUUID() },
          });
          return success
            ? undefined
            : new Response("WebSocket upgrade failed", { status: 400 });
        }

        // REST Endpoints
        if (url.pathname === "/api/operator/status") {
            return Response.json(this._sessionManager.getStatus(), { headers: responseHeaders });
        }

        // Keep legacy /api/status for backwards compatibility with UI before update
        if (url.pathname === "/api/status") {
            const status = this._sessionManager.getStatus().engineStatus;
            return Response.json(status || { status: "offline" }, { headers: responseHeaders });
        }

        if (url.pathname === "/api/operator/simulation/start" && req.method === "POST") {
            try {
                const config = await req.json() as any;
                if (config.presetId) {
                    const presets = await this._liveReadiness.listPresets();
                    const preset = presets.find(item => item.id === config.presetId);
                    if (!preset) throw new Error("Strategy preset not found");
                    config.strategy = preset.moduleId;
                    config.strategyConfigOverride = preset.config;
                    config.presetContext = {
                        id: preset.id,
                        moduleId: preset.moduleId,
                        label: preset.label,
                        configHash: preset.configHash,
                        strategyVersion: "1.0.0",
                    };
                }
                await this._sessionManager.startSimulation(config);
                return Response.json({ success: true }, { headers: responseHeaders });
            } catch (e: any) {
                return Response.json({ success: false, error: e.message }, { status: 400, headers: responseHeaders });
            }
        }

        if (url.pathname === "/api/operator/replay/start" && req.method === "POST") {
            try {
                const config = await req.json() as any;
                if (!config.file) throw new Error("Replay file required");
                const strategy = typeof config.strategy === "string" && config.strategy.trim().length > 0
                    ? config.strategy
                    : undefined;
                await this._sessionManager.startReplay(config.file, { strategy });
                return Response.json({ success: true }, { headers: responseHeaders });
            } catch (e: any) {
                return Response.json({ success: false, error: e.message }, { status: 400, headers: responseHeaders });
            }
        }

        if (url.pathname === "/api/operator/session/stop" && req.method === "POST") {
            try {
                await this._sessionManager.stopSession();
                return Response.json({ success: true }, { headers: responseHeaders });
            } catch (e: any) {
                return Response.json({ success: false, error: e.message }, { status: 400, headers: responseHeaders });
            }
        }

        if (url.pathname === "/api/operator/simulation/reset-state" && req.method === "POST") {
            try {
                await this._sessionManager.resetState();
                return Response.json({ success: true }, { headers: responseHeaders });
            } catch (e: any) {
                return Response.json({ success: false, error: e.message }, { status: 400, headers: responseHeaders });
            }
        }

        if (url.pathname === "/api/operator/replay-fixtures") {
            try {
                const files = await readdir("logs");
                const logFiles = files.filter(f => f.endsWith(".log"));
                const fixtures = await Promise.all(
                    logFiles.map(f => validateReplayFixture(path.join("logs", f)))
                );
                return Response.json({ files: fixtures }, { headers: responseHeaders });
            } catch (e: any) {
                return Response.json({ error: e.message }, { status: 500, headers: responseHeaders });
            }
        }

        if (url.pathname === "/api/operator/strategy-lab/strategies") {
            return Response.json({ strategies: this._strategyLab.listStrategies(), variants: this._strategyLab.listVariants() }, { headers: responseHeaders });
        }

        if (url.pathname === "/api/operator/strategy/modules" && req.method === "GET") {
            return Response.json({ modules: await this._liveReadiness.listModules() }, { headers: responseHeaders });
        }

        if (url.pathname === "/api/operator/strategy/modules/validate" && req.method === "POST") {
            try {
                const result = await this._liveReadiness.validateModule(await req.json() as any);
                return Response.json(result, { status: result.success ? 200 : 400, headers: responseHeaders });
            } catch (e: any) {
                return Response.json({ success: false, errors: [e.message] }, { status: 400, headers: responseHeaders });
            }
        }

        if (url.pathname === "/api/operator/strategy/presets" && req.method === "GET") {
            return Response.json({ presets: await this._liveReadiness.listPresets() }, { headers: responseHeaders });
        }

        if (url.pathname === "/api/operator/strategy/presets" && req.method === "POST") {
            try {
                const preset = await this._liveReadiness.savePreset(await req.json() as any);
                return Response.json({ success: true, preset }, { headers: responseHeaders });
            } catch (e: any) {
                return Response.json({ success: false, error: e.message }, { status: 400, headers: responseHeaders });
            }
        }

        if (url.pathname === "/api/operator/strategy/evidence" && req.method === "GET") {
            return Response.json({ evidence: await this._liveReadiness.listEvidence() }, { headers: responseHeaders });
        }

        const presetEvidenceMatch = url.pathname.match(/^\/api\/operator\/strategy\/presets\/([^/]+)\/evidence$/);
        if (presetEvidenceMatch && req.method === "GET") {
            return Response.json({ evidence: await this._liveReadiness.getPresetEvidence(decodeURIComponent(presetEvidenceMatch[1]!)) }, { headers: responseHeaders });
        }

        const promotePresetMatch = url.pathname.match(/^\/api\/operator\/strategy\/presets\/([^/]+)\/promote-paper-candidate$/);
        if (promotePresetMatch && req.method === "POST") {
            try {
                const result = await this._liveReadiness.promotePaperCandidate(decodeURIComponent(promotePresetMatch[1]!));
                return Response.json(result, { status: result.success ? 200 : 400, headers: responseHeaders });
            } catch (e: any) {
                return Response.json({ success: false, error: e.message }, { status: 400, headers: responseHeaders });
            }
        }

        if (url.pathname === "/api/operator/strategy-lab/experiments" && req.method === "POST") {
            try {
                const experiment = await this._liveReadiness.createExperiment(await req.json() as any);
                return Response.json({ success: true, experimentId: experiment.id, experiment }, { headers: responseHeaders });
            } catch (e: any) {
                return Response.json({ success: false, error: e.message }, { status: 400, headers: responseHeaders });
            }
        }

        const experimentMatch = url.pathname.match(/^\/api\/operator\/strategy-lab\/experiments\/([^/]+)$/);
        if (experimentMatch && req.method === "GET") {
            const experiment = this._liveReadiness.getExperiment(experimentMatch[1]!);
            if (!experiment) return Response.json({ success: false, error: "Experiment not found" }, { status: 404, headers: responseHeaders });
            return Response.json({ success: true, experiment }, { headers: responseHeaders });
        }

        const applyRecommendationMatch = url.pathname.match(/^\/api\/operator\/paper-tuning\/recommendations\/([^/]+)\/apply$/);
        if (applyRecommendationMatch && req.method === "POST") {
            try {
                const preset = await this._liveReadiness.applyRecommendation(applyRecommendationMatch[1]!);
                return Response.json({ success: true, preset }, { headers: responseHeaders });
            } catch (e: any) {
                return Response.json({ success: false, error: e.message }, { status: 400, headers: responseHeaders });
            }
        }

        if (url.pathname === "/api/operator/tiny-live/unlock" && req.method === "POST") {
            try {
                const result = await this._liveReadiness.unlockTinyLive(await req.json() as any);
                return Response.json(result, { status: result.success ? 200 : 400, headers: responseHeaders });
            } catch (e: any) {
                return Response.json({ success: false, error: e.message }, { status: 400, headers: responseHeaders });
            }
        }

        if (url.pathname === "/api/operator/strategy-lab/batches" && req.method === "POST") {
            try {
                const config = await req.json() as any;
                const batch = await this._strategyLab.createBatch(config);
                return Response.json({ success: true, batchId: batch.id, batch }, { headers: responseHeaders });
            } catch (e: any) {
                return Response.json({ success: false, error: e.message }, { status: 400, headers: responseHeaders });
            }
        }

        const strategyBatchMatch = url.pathname.match(/^\/api\/operator\/strategy-lab\/batches\/([^/]+)$/);
        if (strategyBatchMatch && req.method === "GET") {
            const batch = this._strategyLab.getBatch(strategyBatchMatch[1]!);
            if (!batch) {
                return Response.json({ success: false, error: "Strategy Lab batch not found" }, { status: 404, headers: responseHeaders });
            }
            return Response.json({ success: true, batch }, { headers: responseHeaders });
        }

        const strategyBatchCancelMatch = url.pathname.match(/^\/api\/operator\/strategy-lab\/batches\/([^/]+)\/cancel$/);
        if (strategyBatchCancelMatch && req.method === "POST") {
            const batch = this._strategyLab.cancelBatch(strategyBatchCancelMatch[1]!);
            if (!batch) {
                return Response.json({ success: false, error: "Strategy Lab batch not found" }, { status: 404, headers: responseHeaders });
            }
            return Response.json({ success: true, batch }, { headers: responseHeaders });
        }

        if (url.pathname === "/api/operator/config") {
            const redact = (val: string) => (val && val.length > 8) ? `${val.slice(0, 4)}...${val.slice(-4)}` : (val ? "****" : "MISSING");
            const config = {
                TICKER: Env.get("TICKER"),
                MARKET_WINDOW: Env.get("MARKET_WINDOW"),
                MARKET_ASSET: Env.get("MARKET_ASSET"),
                PROD: Env.get("PROD"),
                FORCE_PROD: process.env.FORCE_PROD === "true",
                BINANCE_US: Env.get("BINANCE_US"),
                PRIVATE_KEY: redact(Env.get("PRIVATE_KEY")),
                POLY_FUNDER_ADDRESS: Env.get("POLY_FUNDER_ADDRESS"),
                POLY_SIGNATURE_TYPE: Env.get("POLY_SIGNATURE_TYPE"),
                BUILDER_KEY: redact(Env.get("BUILDER_KEY")),
                BUILDER_SECRET: redact(Env.get("BUILDER_SECRET")),
                BUILDER_PASSPHRASE: redact(Env.get("BUILDER_PASSPHRASE")),
            };
            return Response.json(config, { headers: responseHeaders });
        }

        if (url.pathname === "/api/operator/logs") {
            try {
                const files = await readdir("logs");
                const logFiles = files.filter(f => f.endsWith(".log")).sort().reverse();
                return Response.json({ files: logFiles }, { headers: responseHeaders });
            } catch (e: any) {
                return Response.json({ error: e.message }, { status: 500, headers: responseHeaders });
            }
        }

        const logFileMatch = url.pathname.match(/^\/api\/operator\/logs\/([^/]+)$/);
        if (logFileMatch && req.method === "GET") {
            try {
                const fileName = path.basename(decodeURIComponent(logFileMatch[1]!));
                const filePath = path.join("logs", fileName);
                const content = await Bun.file(filePath).text();
                return new Response(content, { headers: responseHeaders });
            } catch (e: any) {
                return Response.json({ error: e.message }, { status: 404, headers: responseHeaders });
            }
        }

        if (url.pathname === "/api/health") {
            return new Response("OK", { headers: responseHeaders });
        }

        return new Response("Not Found", { status: 404, headers: responseHeaders });
      },

      websocket: {
        open: (ws) => {
          console.log(`[ControlServer] Telemetry client connected: ${ws.data.sessionId}`);
          // Subscribe this specific WS to the bus
          const unsubscribe = bus.subscribe((event: TelemetryEvent) => {
            ws.send(JSON.stringify(event));
          });
          (ws as any)._unsubscribe = unsubscribe;
        },
        message: (_ws, message) => {
          // Handle incoming commands via WS if needed
          console.log(`[ControlServer] Received message: ${message}`);
        },
        close: (ws) => {
          console.log(`[ControlServer] Telemetry client disconnected: ${ws.data.sessionId}`);
          if ((ws as any)._unsubscribe) {
              (ws as any)._unsubscribe();
          }
        },
      },
    });

    console.log(`[ControlServer] Listening on http://127.0.0.1:${this._port}`);
  }

  stop() {
    this._server?.stop();
    this._server = undefined;
  }
}
