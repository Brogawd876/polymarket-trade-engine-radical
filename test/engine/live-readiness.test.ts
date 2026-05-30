import { describe, expect, test } from "bun:test";
import { LiveReadinessManager, stableConfigHash, type ExperimentRequest } from "../../engine/live-readiness.ts";
import type { StrategyLabBatch } from "../../engine/strategy-lab.ts";
import { mkdtemp } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

function completedBatch(id: string, strategy = "simulation"): StrategyLabBatch {
  return {
    id,
    state: "completed",
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    progress: { totalRuns: 1, completedRuns: 1 },
    runs: [],
    summary: {
      totalRuns: 1,
      completed: 1,
      failed: 0,
      canceled: 0,
      winRate: 1,
      totalPnl: 1,
      avgPnl: 1,
      bestPnl: 1,
      worstPnl: 1,
      blocked: 0,
      problems: 0,
      byStrategy: [],
      recommendation: {
        strategy,
        label: strategy,
        score: 20,
        readyForPaper: true,
        rationale: ["Test recommendation."],
      },
    },
  };
}

class FakeStrategyLab {
  batches = new Map<string, StrategyLabBatch>();

  async createBatch(_request: { variants?: string[]; files: string[] }) {
    const batch = completedBatch(`batch-${this.batches.size + 1}`);
    this.batches.set(batch.id, batch);
    return batch;
  }

  getBatch(id: string) {
    return this.batches.get(id) ?? null;
  }
}

describe("LiveReadinessManager", () => {
  async function tempManager() {
    const dir = await mkdtemp(join(tmpdir(), "live-readiness-"));
    return new LiveReadinessManager(new FakeStrategyLab() as any, {
      presetFile: join(dir, "presets.json"),
      evidenceFile: join(dir, "evidence.json"),
    });
  }

  test("lists built-in strategy modules with live disabled by default", async () => {
    const manager = new LiveReadinessManager(new FakeStrategyLab() as any);
    const modules = await manager.listModules();
    expect(modules.some(module => module.id === "simulation")).toBe(true);
    expect(modules.every(module => module.liveEligible === false)).toBe(true);
  });

  test("rejects unsafe custom strategy module validation", async () => {
    const manager = new LiveReadinessManager(new FakeStrategyLab() as any);
    const result = await manager.validateModule({
      id: "unsafe",
      sourceCode: "export const module = { evaluate() { return process.env.SECRET; } };",
    });
    expect(result.success).toBe(false);
    expect(result.errors.join(" ")).toMatch(/process\.env/);
  });

  test("creates an experiment recommendation from completed train and holdout batches", async () => {
    const manager = new LiveReadinessManager(new FakeStrategyLab() as any);
    const request: ExperimentRequest = {
      variants: ["simulation"],
      files: ["logs/train.log"],
      holdoutFiles: ["logs/holdout.log"],
    };
    const experiment = await manager.createExperiment(request);

    for (let attempt = 0; attempt < 20; attempt++) {
      const current = manager.getExperiment(experiment.id);
      if (current?.state === "completed") {
        expect(current.recommendation?.readyForPaper).toBe(true);
        expect(current.recommendation?.rationale.some(item => item.includes("holdout"))).toBe(true);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error("Timed out waiting for fake experiment");
  });

  test("paper evidence records rows and gates promotion", async () => {
    const manager = await tempManager();
    const before = await manager.promotePaperCandidate("simulation");
    expect(before.success).toBe(false);
    expect(before.report.reasons.join(" ")).toMatch(/paper evidence/);

    await manager.recordPaperEvidence({
      presetId: "simulation",
      moduleId: "simulation",
      label: "simulation",
      configHash: stableConfigHash({}),
      strategyVersion: "1.0.0",
      startedAtMs: Date.now() - 1000,
      status: "completed",
      pnl: 0.25,
      fills: 1,
      blocked: 0,
      problems: 0,
      decisionSnapshots: 2,
    });

    const evidence = await manager.getPresetEvidence("simulation");
    expect(evidence.summary.cleanSessions).toBe(1);

    const after = await manager.promotePaperCandidate("simulation");
    expect(after.success).toBe(true);
    expect(after.preset?.promotionStatus).toBe("tiny_live_candidate");
  });

  test("failed paper evidence is row-level and does not satisfy promotion", async () => {
    const manager = await tempManager();
    await manager.recordPaperEvidence({
      presetId: "simulation",
      moduleId: "simulation",
      label: "simulation",
      configHash: stableConfigHash({}),
      strategyVersion: "1.0.0",
      startedAtMs: Date.now() - 1000,
      status: "failed",
      pnl: -1,
      fills: 0,
      blocked: 0,
      problems: 1,
      decisionSnapshots: 1,
    });
    const evidence = await manager.getPresetEvidence("simulation");
    expect(evidence.rows[0]?.verdict).toBe("failed");
    expect(evidence.summary.promotionReady).toBe(false);
  });

  test("tiny-live promotion requires a paper candidate and paper approval", async () => {
    const manager = new LiveReadinessManager(new FakeStrategyLab() as any);
    const report = await manager.evaluatePromotion({
      id: "draft",
      moduleId: "simulation",
      label: "Draft",
      config: {},
      configHash: stableConfigHash({}),
      riskProfile: "simulation",
      notes: "",
      promotionStatus: "draft",
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });

    expect(report.tinyLiveEligible).toBe(false);
    expect(report.reasons.length).toBeGreaterThan(0);
  });
});
