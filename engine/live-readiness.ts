import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import * as path from "path";
import { createHash } from "crypto";
import { listStrategyVariants, resolveStrategySelection } from "./strategy/index.ts";
import type { StrategyLabBatch, StrategyLabBatchManager } from "./strategy-lab.ts";

export type ConfigFieldType = "number" | "string" | "boolean";

export type ConfigFieldSchema = {
  type: ConfigFieldType;
  label: string;
  description?: string;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  default?: unknown;
};

export type StrategyModule = {
  id: string;
  label: string;
  version: string;
  description: string;
  configSchema: Record<string, ConfigFieldSchema>;
  defaultConfig: Record<string, unknown>;
  paperEligible: boolean;
  liveEligible: boolean;
  requiredFeatures: string[];
  source: "built-in" | "custom";
  validationStatus: "valid" | "invalid" | "untested";
  validationErrors: string[];
};

export type PromotionStatus = "draft" | "replay_candidate" | "paper_candidate" | "tiny_live_candidate" | "retired";

export type LiveGuardConfig = {
  mode: "tiny-live";
  maxOrderNotionalUsd: number;
  maxOpenExposureUsd: number;
  maxSessionLossUsd: number;
  noTradeLastMs: number;
  maxFeedFreshnessMs: number;
  requirePositiveHoldout: boolean;
  requireApprovedPaperRecommendation: boolean;
};

export const ULTRA_TINY_LIVE_GUARD: LiveGuardConfig = {
  mode: "tiny-live",
  maxOrderNotionalUsd: 1,
  maxOpenExposureUsd: 5,
  maxSessionLossUsd: 5,
  noTradeLastMs: 5000,
  maxFeedFreshnessMs: 1000,
  requirePositiveHoldout: true,
  requireApprovedPaperRecommendation: true,
};

export type StrategyPreset = {
  id: string;
  moduleId: string;
  label: string;
  config: Record<string, unknown>;
  configHash: string;
  riskProfile: "simulation" | "paper" | "tiny-live";
  notes: string;
  promotionStatus: PromotionStatus;
  createdAtMs: number;
  updatedAtMs: number;
  lastValidation?: PromotionReport;
};

export type PaperSessionEvidence = {
  id: string;
  presetId: string;
  moduleId: string;
  label: string;
  configHash: string;
  strategyVersion: string;
  startedAtMs: number;
  endedAtMs: number;
  status: "completed" | "failed" | "canceled";
  pnl: number;
  fills: number;
  blocked: number;
  problems: number;
  decisionSnapshots: number;
  verdict: "win" | "loss" | "flat" | "no_trade" | "problem" | "canceled" | "failed";
  notes?: string;
};

export type StrategyPresetEvidence = {
  presetId: string;
  rows: PaperSessionEvidence[];
  summary: {
    totalSessions: number;
    cleanSessions: number;
    totalPnl: number;
    latestVerdict: PaperSessionEvidence["verdict"] | null;
    promotionReady: boolean;
  };
};

export type PromotionReport = {
  presetId: string;
  replayPassed: boolean;
  paperApproved: boolean;
  paperEvidencePassed?: boolean;
  tinyLiveEligible: boolean;
  reasons: string[];
  checkedAtMs: number;
};

export type StrategyModuleValidationRequest = {
  id?: string;
  label?: string;
  version?: string;
  sourceCode: string;
};

export type StrategyModuleValidationResult = {
  success: boolean;
  module?: StrategyModule;
  errors: string[];
};

export type ExperimentRequest = {
  name?: string;
  presetIds?: string[];
  variants?: string[];
  files: string[];
  holdoutFiles?: string[];
  parameterGrid?: Record<string, unknown[]>;
};

export type ExperimentState = "queued" | "running" | "completed" | "failed";

export type ExperimentResult = {
  id: string;
  name: string;
  state: ExperimentState;
  createdAtMs: number;
  updatedAtMs: number;
  request: ExperimentRequest;
  trainBatchId?: string;
  holdoutBatchId?: string;
  train?: StrategyLabBatch;
  holdout?: StrategyLabBatch;
  recommendation: PaperTuningRecommendation | null;
  error?: string;
};

export type PaperTuningRecommendation = {
  id: string;
  experimentId: string;
  presetId: string;
  moduleId: string;
  config: Record<string, unknown>;
  configHash: string;
  score: number;
  readyForPaper: boolean;
  applied: boolean;
  rationale: string[];
  createdAtMs: number;
};

export type TinyLiveUnlockRequest = {
  presetId: string;
  operatorAck?: boolean;
};

export type TinyLiveUnlockResult = {
  success: boolean;
  presetId: string;
  guard: LiveGuardConfig;
  report: PromotionReport;
  error?: string;
};

const DATA_DIR = "state";
const PRESET_FILE = path.join(DATA_DIR, "strategy-presets.json");
const EVIDENCE_FILE = path.join(DATA_DIR, "strategy-paper-evidence.json");
const CUSTOM_MODULE_DIR = path.join("engine", "strategy", "custom");

const DEFAULT_CONFIG_SCHEMA: Record<string, ConfigFieldSchema> = {
  entryWindowSec: { type: "number", label: "Entry window sec", min: 1, max: 300, step: 1 },
  certaintyPrice: { type: "number", label: "Certainty price", min: 0.01, max: 0.99, step: 0.01 },
  minGapSafety: { type: "number", label: "Minimum gap safety", min: 0, max: 500, step: 1 },
  maxDivergence: { type: "number", label: "Maximum feed divergence", min: 0, max: 500, step: 1 },
  minLiquidity: { type: "number", label: "Minimum liquidity", min: 0, max: 1000, step: 1 },
  shares: { type: "number", label: "Shares", min: 0.01, max: 25, step: 0.01 },
};

export function stableConfigHash(config: Record<string, unknown>): string {
  const ordered = Object.keys(config).sort().reduce<Record<string, unknown>>((acc, key) => {
    acc[key] = config[key];
    return acc;
  }, {});
  return createHash("sha256").update(JSON.stringify(ordered)).digest("hex").slice(0, 12);
}

function builtInModules(): StrategyModule[] {
  return listStrategyVariants().map((variant) => ({
    id: variant.id,
    label: variant.label,
    version: "1.0.0",
    description: variant.description,
    configSchema: { ...DEFAULT_CONFIG_SCHEMA },
    defaultConfig: { ...variant.config },
    paperEligible: variant.paperEligible,
    liveEligible: false,
    requiredFeatures: ["market", "venue", "risk", "telemetry"],
    source: "built-in",
    validationStatus: "valid",
    validationErrors: [],
  }));
}

function validateConfig(module: StrategyModule, config: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [key, schema] of Object.entries(module.configSchema)) {
    const value = config[key];
    if (value == null) {
      if (schema.required) errors.push(`${key} is required`);
      continue;
    }
    if (schema.type === "number") {
      if (typeof value !== "number" || Number.isNaN(value)) errors.push(`${key} must be a number`);
      if (typeof value === "number" && schema.min != null && value < schema.min) errors.push(`${key} is below minimum ${schema.min}`);
      if (typeof value === "number" && schema.max != null && value > schema.max) errors.push(`${key} is above maximum ${schema.max}`);
    }
    if (schema.type === "string" && typeof value !== "string") errors.push(`${key} must be a string`);
    if (schema.type === "boolean" && typeof value !== "boolean") errors.push(`${key} must be a boolean`);
  }
  return errors;
}

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export class LiveReadinessManager {
  private experiments = new Map<string, ExperimentResult>();
  private recommendations = new Map<string, PaperTuningRecommendation>();
  private tinyLiveUnlocks = new Map<string, PromotionReport>();
  private readonly presetFile: string;
  private readonly evidenceFile: string;

  constructor(private readonly strategyLab: StrategyLabBatchManager, opts: { presetFile?: string; evidenceFile?: string } = {}) {
    this.presetFile = opts.presetFile ?? PRESET_FILE;
    this.evidenceFile = opts.evidenceFile ?? EVIDENCE_FILE;
  }

  async listModules(): Promise<StrategyModule[]> {
    const custom = await this.listCustomModules();
    return [...builtInModules(), ...custom].sort((a, b) => a.id.localeCompare(b.id));
  }

  async validateModule(request: StrategyModuleValidationRequest): Promise<StrategyModuleValidationResult> {
    const errors: string[] = [];
    const id = (request.id || request.label || "custom-strategy").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
    if (!id) errors.push("Module id is required");
    if (!request.sourceCode?.trim()) errors.push("Source code is required");
    if (!request.sourceCode.includes("export")) errors.push("Source code must export a strategy module");
    if (!request.sourceCode.includes("evaluate")) errors.push("Source code must include an evaluate function");
    if (/\bprocess\.env\b|\bBun\.spawn\b|\bchild_process\b|\bfs\b/.test(request.sourceCode ?? "")) {
      errors.push("Custom strategy source cannot access filesystem, child processes, or process.env");
    }

    const module: StrategyModule = {
      id,
      label: request.label || id,
      version: request.version || "0.1.0",
      description: "Custom strategy module pending replay validation.",
      configSchema: {},
      defaultConfig: {},
      paperEligible: false,
      liveEligible: false,
      requiredFeatures: ["market", "venue", "risk"],
      source: "custom",
      validationStatus: errors.length === 0 ? "valid" : "invalid",
      validationErrors: errors,
    };

    if (errors.length === 0) {
      await mkdir(CUSTOM_MODULE_DIR, { recursive: true });
      await writeFile(path.join(CUSTOM_MODULE_DIR, `${id}.ts`), request.sourceCode);
    }

    return { success: errors.length === 0, module, errors };
  }

  async listPresets(): Promise<StrategyPreset[]> {
    const saved = await readJsonFile<StrategyPreset[]>(this.presetFile, []);
    if (saved.length > 0) return saved;
    const now = Date.now();
    return builtInModules().map((module) => ({
      id: module.id,
      moduleId: module.id,
      label: module.label,
      config: { ...module.defaultConfig },
      configHash: stableConfigHash(module.defaultConfig),
      riskProfile: module.paperEligible ? "paper" : "simulation",
      notes: module.description,
      promotionStatus: module.paperEligible ? "paper_candidate" : "replay_candidate",
      createdAtMs: now,
      updatedAtMs: now,
    }));
  }

  async savePreset(input: Partial<StrategyPreset> & { moduleId: string; label?: string; config?: Record<string, unknown> }): Promise<StrategyPreset> {
    const modules = await this.listModules();
    const module = modules.find(item => item.id === input.moduleId);
    if (!module) throw new Error(`Unknown strategy module: ${input.moduleId}`);
    const config = { ...module.defaultConfig, ...(input.config ?? {}) };
    const errors = validateConfig(module, config);
    if (errors.length > 0) throw new Error(errors.join("; "));

    const presets = await this.listPresets();
    const now = Date.now();
    const id = input.id || `${input.moduleId}-${stableConfigHash(config)}`;
    const existing = presets.find(item => item.id === id);
    const preset: StrategyPreset = {
      id,
      moduleId: input.moduleId,
      label: input.label || existing?.label || module.label,
      config,
      configHash: stableConfigHash(config),
      riskProfile: input.riskProfile ?? existing?.riskProfile ?? "simulation",
      notes: input.notes ?? existing?.notes ?? "",
      promotionStatus: input.promotionStatus ?? existing?.promotionStatus ?? "draft",
      createdAtMs: existing?.createdAtMs ?? now,
      updatedAtMs: now,
      lastValidation: input.lastValidation ?? existing?.lastValidation,
    };

    const next = [...presets.filter(item => item.id !== id), preset].sort((a, b) => a.id.localeCompare(b.id));
    await writeJsonFile(this.presetFile, next);
    return preset;
  }

  async listEvidence(presetId?: string): Promise<PaperSessionEvidence[]> {
    const rows = await readJsonFile<PaperSessionEvidence[]>(this.evidenceFile, []);
    const filtered = presetId ? rows.filter(row => row.presetId === presetId) : rows;
    return filtered.sort((a, b) => b.startedAtMs - a.startedAtMs);
  }

  async getPresetEvidence(presetId: string): Promise<StrategyPresetEvidence> {
    const rows = await this.listEvidence(presetId);
    const cleanSessions = rows.filter(row => this.isCleanPaperEvidence(row)).length;
    const totalPnl = parseFloat(rows.reduce((sum, row) => sum + row.pnl, 0).toFixed(4));
    return {
      presetId,
      rows,
      summary: {
        totalSessions: rows.length,
        cleanSessions,
        totalPnl,
        latestVerdict: rows[0]?.verdict ?? null,
        promotionReady: cleanSessions > 0,
      },
    };
  }

  async recordPaperEvidence(input: Omit<PaperSessionEvidence, "id" | "endedAtMs" | "verdict"> & { id?: string; endedAtMs?: number; verdict?: PaperSessionEvidence["verdict"] }): Promise<PaperSessionEvidence> {
    const evidence: PaperSessionEvidence = {
      ...input,
      id: input.id ?? crypto.randomUUID(),
      endedAtMs: input.endedAtMs ?? Date.now(),
      pnl: parseFloat(input.pnl.toFixed(4)),
      verdict: input.verdict ?? this.deriveEvidenceVerdict(input),
    };
    const rows = await readJsonFile<PaperSessionEvidence[]>(this.evidenceFile, []);
    const next = [evidence, ...rows.filter(row => row.id !== evidence.id)].slice(0, 500);
    await writeJsonFile(this.evidenceFile, next);
    return evidence;
  }

  async promotePaperCandidate(presetId: string): Promise<{ success: boolean; preset?: StrategyPreset; report: PromotionReport; error?: string }> {
    const presets = await this.listPresets();
    const preset = presets.find(item => item.id === presetId);
    if (!preset) throw new Error("Preset not found");
    const report = await this.evaluatePromotion(preset);
    if (!report.tinyLiveEligible) {
      return { success: false, report, error: report.reasons.join("; ") };
    }
    const promoted = await this.savePreset({ ...preset, promotionStatus: "tiny_live_candidate", lastValidation: report });
    return { success: true, preset: promoted, report };
  }

  async createExperiment(request: ExperimentRequest): Promise<ExperimentResult> {
    const id = crypto.randomUUID();
    const experiment: ExperimentResult = {
      id,
      name: request.name || "Strategy experiment",
      state: "queued",
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      request,
      recommendation: null,
    };
    this.experiments.set(id, experiment);
    setTimeout(() => void this.runExperiment(id), 0);
    return structuredClone(experiment);
  }

  getExperiment(id: string): ExperimentResult | null {
    const experiment = this.experiments.get(id);
    return experiment ? structuredClone(experiment) : null;
  }

  async applyRecommendation(id: string): Promise<StrategyPreset> {
    const recommendation = this.recommendations.get(id);
    if (!recommendation) throw new Error("Recommendation not found");
    if (!recommendation.readyForPaper) throw new Error("Recommendation is not ready for paper");
    const preset = await this.savePreset({
      id: recommendation.presetId,
      moduleId: recommendation.moduleId,
      config: recommendation.config,
      riskProfile: "paper",
      promotionStatus: "paper_candidate",
      notes: `Applied from experiment ${recommendation.experimentId}`,
    });
    recommendation.applied = true;
    return preset;
  }

  async unlockTinyLive(request: TinyLiveUnlockRequest): Promise<TinyLiveUnlockResult> {
    const presets = await this.listPresets();
    const preset = presets.find(item => item.id === request.presetId);
    if (!preset) throw new Error("Preset not found");
    const report = await this.evaluatePromotion(preset);
    if (!request.operatorAck) report.reasons.push("operator acknowledgement is required");
    const success = report.tinyLiveEligible && request.operatorAck === true;
    if (success) {
      this.tinyLiveUnlocks.set(preset.id, report);
      await this.savePreset({ ...preset, riskProfile: "tiny-live", promotionStatus: "tiny_live_candidate", lastValidation: report });
    }
    return { success, presetId: preset.id, guard: ULTRA_TINY_LIVE_GUARD, report, error: success ? undefined : report.reasons.join("; ") };
  }

  async evaluatePromotion(preset: StrategyPreset): Promise<PromotionReport> {
    const reasons: string[] = [];
    if (preset.promotionStatus !== "tiny_live_candidate" && preset.promotionStatus !== "paper_candidate") {
      reasons.push("preset is not a paper or tiny-live candidate");
    }
    const replayPassed = preset.lastValidation?.replayPassed === true || preset.promotionStatus === "paper_candidate" || preset.promotionStatus === "tiny_live_candidate";
    const paperApproved = preset.riskProfile === "paper" || preset.riskProfile === "tiny-live";
    const evidence = await this.getPresetEvidence(preset.id);
    const paperEvidencePassed = evidence.summary.cleanSessions > 0;
    if (!replayPassed) reasons.push("positive replay holdout is required");
    if (!paperApproved) reasons.push("approved paper recommendation is required");
    if (!paperEvidencePassed) reasons.push("at least one clean paper evidence row is required");
    return {
      presetId: preset.id,
      replayPassed,
      paperApproved,
      paperEvidencePassed,
      tinyLiveEligible: replayPassed && paperApproved && paperEvidencePassed && reasons.length === 0,
      reasons,
      checkedAtMs: Date.now(),
    };
  }

  private isCleanPaperEvidence(row: PaperSessionEvidence): boolean {
    return row.status === "completed" && row.problems === 0 && row.fills > 0 && row.decisionSnapshots > 0 && row.pnl >= 0;
  }

  private deriveEvidenceVerdict(row: Omit<PaperSessionEvidence, "id" | "endedAtMs" | "verdict">): PaperSessionEvidence["verdict"] {
    if (row.status === "failed") return "failed";
    if (row.status === "canceled") return "canceled";
    if (row.problems > 0) return "problem";
    if (row.fills === 0) return "no_trade";
    if (row.pnl > 0) return "win";
    if (row.pnl < 0) return "loss";
    return "flat";
  }

  private async listCustomModules(): Promise<StrategyModule[]> {
    try {
      const files = (await readdir(CUSTOM_MODULE_DIR)).filter(file => file.endsWith(".ts"));
      return files.map((file) => {
        const id = path.basename(file, ".ts");
        return {
          id,
          label: id,
          version: "0.1.0",
          description: "Custom strategy module saved locally. Replay validation required before paper use.",
          configSchema: {},
          defaultConfig: {},
          paperEligible: false,
          liveEligible: false,
          requiredFeatures: ["market", "venue", "risk"],
          source: "custom",
          validationStatus: "untested",
          validationErrors: [],
        };
      });
    } catch {
      return [];
    }
  }

  private async runExperiment(id: string): Promise<void> {
    const experiment = this.experiments.get(id);
    if (!experiment) return;
    experiment.state = "running";
    experiment.updatedAtMs = Date.now();
    try {
      const variants = await this.resolveExperimentVariants(experiment.request);
      const train = await this.strategyLab.createBatch({ variants, files: experiment.request.files });
      experiment.trainBatchId = train.id;
      experiment.updatedAtMs = Date.now();
      const trainResult = await this.waitForBatch(train.id);
      experiment.train = trainResult;

      if ((experiment.request.holdoutFiles ?? []).length > 0) {
        const holdout = await this.strategyLab.createBatch({ variants, files: experiment.request.holdoutFiles! });
        experiment.holdoutBatchId = holdout.id;
        experiment.updatedAtMs = Date.now();
        experiment.holdout = await this.waitForBatch(holdout.id);
      }

      experiment.recommendation = await this.createRecommendation(experiment);
      experiment.state = "completed";
      experiment.updatedAtMs = Date.now();
    } catch (error) {
      experiment.state = "failed";
      experiment.error = error instanceof Error ? error.message : String(error);
      experiment.updatedAtMs = Date.now();
    }
  }

  private async resolveExperimentVariants(request: ExperimentRequest): Promise<string[]> {
    const variants = [...new Set(request.variants ?? [])];
    if (request.presetIds?.length) {
      const presets = await this.listPresets();
      for (const presetId of request.presetIds) {
        const preset = presets.find(item => item.id === presetId);
        if (!preset) throw new Error(`Unknown preset: ${presetId}`);
        resolveStrategySelection(preset.moduleId);
        variants.push(preset.moduleId);
      }
    }
    if (variants.length === 0) variants.push("simulation");
    return [...new Set(variants)];
  }

  private async waitForBatch(batchId: string): Promise<StrategyLabBatch> {
    while (true) {
      const batch = this.strategyLab.getBatch(batchId);
      if (!batch) throw new Error("Experiment batch disappeared");
      if (!["queued", "running"].includes(batch.state)) return batch;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  private async createRecommendation(experiment: ExperimentResult): Promise<PaperTuningRecommendation | null> {
    const source = experiment.holdout ?? experiment.train;
    const winner = source?.summary.recommendation;
    if (!source || !winner) return null;
    const presets = await this.listPresets();
    const preset = presets.find(item => item.moduleId === winner.strategy || item.id === winner.strategy);
    const moduleId = preset?.moduleId ?? winner.strategy;
    const config = preset?.config ?? resolveStrategySelection(moduleId).config;
    const rationale = [
      ...winner.rationale,
      experiment.holdout ? "Recommendation is based on holdout results." : "Recommendation is based on training fixtures only.",
    ];
    const recommendation: PaperTuningRecommendation = {
      id: crypto.randomUUID(),
      experimentId: experiment.id,
      presetId: preset?.id ?? moduleId,
      moduleId,
      config,
      configHash: stableConfigHash(config),
      score: winner.score,
      readyForPaper: winner.readyForPaper && source.summary.totalPnl > 0 && source.summary.problems === 0,
      applied: false,
      rationale,
      createdAtMs: Date.now(),
    };
    this.recommendations.set(recommendation.id, recommendation);
    return recommendation;
  }
}
