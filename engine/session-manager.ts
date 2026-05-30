import { EarlyBird, type EngineStatus } from "./early-bird.ts";
import { ReplayRunner, VirtualClock, RealClock, TelemetryBus } from "./bot-core/index.ts";
import type { PaperSessionEvidence, StrategyPreset } from "./live-readiness.ts";
import type { TelemetryEvent } from "./telemetry/types.ts";
import * as fs from "fs/promises";
import * as path from "path";

export type SessionState = "idle" | "starting" | "running" | "stopping" | "completed" | "failed";

export type OperatorStatus = {
  backend: "reachable";
  telemetry: "connected"; // UI will fill this
  sessionState: SessionState;
  engineMode: "idle" | "live" | "sim" | "replay";
  engineStatus: EngineStatus | null;
  blockReason: string | null;
  activeReplayFile: string | null;
  activePreset: ActivePresetContext | null;
};

export type ActivePresetContext = Pick<StrategyPreset, "id" | "moduleId" | "label" | "configHash"> & {
  strategyVersion: string;
};

type PaperEvidenceDraft = Omit<PaperSessionEvidence, "id" | "endedAtMs" | "status" | "verdict">;
type PaperEvidenceRecorder = (evidence: Omit<PaperSessionEvidence, "id" | "verdict">) => void | Promise<void>;

export class SessionManager {
  private _sessionState: SessionState = "idle";
  private _bot: EarlyBird | null = null;
  private _runner: ReplayRunner | null = null;
  private _blockReason: string | null = null;
  private _activeReplayFile: string | null = null;
  private _activePreset: ActivePresetContext | null = null;
  private _paperEvidenceDraft: PaperEvidenceDraft | null = null;
  private _paperEvidenceUnsubscribe: (() => void) | null = null;
  private _paperEvidenceRecorded = false;
  private _paperEvidenceRecorder: PaperEvidenceRecorder | null = null;
  
  constructor(public telemetryBus: TelemetryBus) {}

  setPaperEvidenceRecorder(recorder: PaperEvidenceRecorder): void {
    this._paperEvidenceRecorder = recorder;
  }

  getStatus(): OperatorStatus {
    return {
      backend: "reachable",
      telemetry: "connected",
      sessionState: this._sessionState,
      engineMode: this._bot ? (this._runner ? "replay" : (this._bot.getStatus().mode === "live" ? "live" : "sim")) : "idle",
      engineStatus: this._bot ? this._bot.getStatus() : null,
      blockReason: this._blockReason,
      activeReplayFile: this._activeReplayFile,
      activePreset: this._activePreset
    };
  }

  async startSimulation(config: { 
    strategy: string; 
    rounds?: number; 
    alwaysLog?: boolean; 
    maxSessionLoss?: number; 
    prod?: boolean;
    slotOffset?: number;
    strategyConfigOverride?: Record<string, unknown>; 
    presetContext?: ActivePresetContext 
  }): Promise<void> {
    if (this._sessionState === "running" || this._sessionState === "starting") {
      throw new Error("Session is already active");
    }
    
    this._sessionState = "starting";
    this._blockReason = null;
    this._activeReplayFile = null;
    this._activePreset = config.presetContext ?? null;
    this._startPaperEvidence(config.presetContext);
    
    if (config.maxSessionLoss !== undefined) {
      process.env.MAX_SESSION_LOSS = config.maxSessionLoss.toString();
    }
    
    try {
      const clock = new RealClock();
      this._bot = new EarlyBird(
        config.strategy,
        config.slotOffset ?? 1,
        config.prod ?? false,
        config.rounds ?? null,

        config.alwaysLog ?? false,
        undefined, // replayFile
        {
          clock,
          persistState: true,
          telemetry: this.telemetryBus,
          strategyConfigOverride: config.strategyConfigOverride,
          presetId: config.presetContext?.id,
        }
      );
      
      // We do not await start() here forever, start() resolves when setup is done
      await this._bot.start();
      
      this._sessionState = "running";
      
      // We must monitor for when the bot stops naturally
      this._monitorBot();
    } catch (e: any) {
      this._sessionState = "failed";
      this._blockReason = e.message;
      await this._finalizePaperEvidence("failed");
      this._bot = null;
      this._activePreset = null;
      throw e;
    }
  }

  async startReplay(file: string, config: { strategy?: string } = {}): Promise<void> {
    if (this._sessionState === "running" || this._sessionState === "starting") {
      throw new Error("Session is already active");
    }
    
    this._sessionState = "starting";
    this._blockReason = null;
    this._activeReplayFile = file;
    this._activePreset = null;
    this._clearPaperEvidenceCollector();
    
    try {
      const clock = new VirtualClock();
      this._bot = new EarlyBird(
        config.strategy,
        1,
        false,
        1,
        false,
        file,
        {
          clock,
          persistState: false,
          telemetry: this.telemetryBus
        }
      );
      
      const reader = this._bot.replayReader;
      if (!reader) throw new Error("Replay reader not initialized");
      
      this._runner = new ReplayRunner(reader, this._bot, clock, this.telemetryBus);
      
      this._sessionState = "running";
      
      this._runner.run().then(() => {
        this._sessionState = "completed";
        setTimeout(() => {
          if (this._sessionState === "completed") {
            this._sessionState = "idle";
            this._bot = null;
            this._runner = null;
            this._activeReplayFile = null;
            this._activePreset = null;
          }
        }, 3000);
      }).catch((e) => {
        this._sessionState = "failed";
        this._blockReason = e.message;
      });
      
    } catch (e: any) {
      this._sessionState = "failed";
      this._blockReason = e.message;
      this._bot = null;
      this._runner = null;
      this._activeReplayFile = null;
      this._activePreset = null;
      throw e;
    }
  }

  async stopSession(): Promise<void> {
    if (this._sessionState !== "running") return;
    this._sessionState = "stopping";
    try {
      if (this._bot) {
         await this._bot.stop();
      }
      this._sessionState = "completed";
      await this._finalizePaperEvidence("canceled");
      setTimeout(() => {
        if (this._sessionState === "completed") {
            this._sessionState = "idle";
            this._bot = null;
            this._runner = null;
            this._activeReplayFile = null;
            this._activePreset = null;
        }
      }, 2000);
    } catch (e: any) {
      this._sessionState = "failed";
      this._blockReason = e.message;
      await this._finalizePaperEvidence("failed");
      throw e;
    }
  }

  async resetState(): Promise<void> {
    if (this._sessionState === "running" || this._sessionState === "starting") {
      throw new Error("Cannot reset state while a session is active");
    }
    try {
      // Just delete the state files to reset
      await fs.unlink("state/early-bird.json").catch(() => {});
      this._blockReason = null;
    } catch (e: any) {
      throw new Error("Failed to reset state: " + e.message);
    }
  }

  private _monitorBot() {
    if (!this._bot) return;
    const bot = this._bot;
    const interval = setInterval(() => {
      // If shutting down is true and lifecycles = 0, it has settled.
      if (bot.isShuttingDown && bot.activeLifecycleCount === 0) {
         clearInterval(interval);
         this._sessionState = "completed";
         void this._finalizePaperEvidence("completed");
         // Transition to idle after a short delay so UI can see "completed"
         setTimeout(() => {
            if (this._sessionState === "completed") {
                this._sessionState = "idle";
                this._bot = null;
                this._activePreset = null;
            }
         }, 3000);
      }
    }, 500);
  }

  private _startPaperEvidence(preset: ActivePresetContext | undefined): void {
    this._clearPaperEvidenceCollector();
    this._paperEvidenceRecorded = false;
    if (!preset) {
      this._paperEvidenceDraft = null;
      return;
    }
    this._paperEvidenceDraft = {
      presetId: preset.id,
      moduleId: preset.moduleId,
      label: preset.label,
      configHash: preset.configHash,
      strategyVersion: preset.strategyVersion,
      startedAtMs: Date.now(),
      pnl: 0,
      fills: 0,
      blocked: 0,
      problems: 0,
      decisionSnapshots: 0,
    };
    this._paperEvidenceUnsubscribe = this.telemetryBus.subscribe((event) => this._capturePaperEvidenceEvent(event));
  }

  private _capturePaperEvidenceEvent(event: TelemetryEvent): void {
    if (!this._paperEvidenceDraft) return;
    if (event.type === "RISK_DECISION" && !event.payload.approved) {
      this._paperEvidenceDraft.blocked++;
    }
    if (event.type === "ORDER_LIFECYCLE") {
      if (event.payload.status === "filled") this._paperEvidenceDraft.fills++;
      if (event.payload.status === "failed") this._paperEvidenceDraft.problems++;
    }
    if (event.type === "DECISION_FEATURE_SNAPSHOT") {
      this._paperEvidenceDraft.decisionSnapshots++;
      if (event.payload.event === "failed") this._paperEvidenceDraft.problems++;
    }
    if (event.type === "SESSION_PNL") {
      this._paperEvidenceDraft.pnl = event.payload.pnl;
    }
  }

  private async _finalizePaperEvidence(status: PaperSessionEvidence["status"]): Promise<void> {
    if (!this._paperEvidenceDraft || this._paperEvidenceRecorded) return;
    this._paperEvidenceRecorded = true;
    const evidence = {
      ...this._paperEvidenceDraft,
      status,
      endedAtMs: Date.now(),
    };
    this._clearPaperEvidenceCollector();
    if (this._paperEvidenceRecorder) {
      try {
        await this._paperEvidenceRecorder(evidence);
      } catch (error) {
        console.error("[SessionManager] Failed to record paper evidence:", error);
      }
    }
  }

  private _clearPaperEvidenceCollector(): void {
    if (this._paperEvidenceUnsubscribe) {
      this._paperEvidenceUnsubscribe();
      this._paperEvidenceUnsubscribe = null;
    }
  }
}
