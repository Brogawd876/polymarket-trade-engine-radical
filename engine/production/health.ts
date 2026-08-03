export type DependencyHealthStatus =
  | "HEALTHY"
  | "DEGRADED"
  | "BLOCKED"
  | "UNKNOWN";

export type DependencyHealth = {
  status: DependencyHealthStatus;
  checkedAtMs: number;
  detail: string;
};

export const REQUIRED_TRADING_DEPENDENCIES = [
  "engine",
  "eventJournal",
  "resolutionSource",
  "predictiveSources",
  "venueBook",
  "userChannel",
  "restApi",
  "clock",
  "modelRegistry",
  "reconciliation",
  "killSwitch",
] as const;

export type TradingDependencyName =
  (typeof REQUIRED_TRADING_DEPENDENCIES)[number];

export type ProductionHealthReport = {
  schemaVersion: 1;
  checkedAtMs: number;
  controlPlane: "HEALTHY";
  tradingReadiness: "READY" | "BLOCKED";
  dependencies: Record<TradingDependencyName, DependencyHealth>;
  blockReasons: string[];
};

export function buildBlockedHealthReport(input: {
  checkedAtMs?: number;
  engineRunning: boolean;
  evidenceHealthy: boolean;
  completionProven: boolean;
  blockReason?: string | null;
}): ProductionHealthReport {
  const now = input.checkedAtMs ?? Date.now();
  const unknown = (detail: string): DependencyHealth => ({
    status: "UNKNOWN",
    checkedAtMs: now,
    detail,
  });
  const dependencies: Record<TradingDependencyName, DependencyHealth> = {
    engine: {
      status:
        input.engineRunning && input.evidenceHealthy ? "HEALTHY" : "BLOCKED",
      checkedAtMs: now,
      detail: input.engineRunning
        ? input.evidenceHealthy
          ? "engine running; aggregate evidence channel healthy"
          : "engine reports an evidence failure"
        : "no trading engine session is running",
    },
    eventJournal: unknown(
      "authoritative production journal health is not connected to this legacy session",
    ),
    resolutionSource: unknown(
      "resolution-source health is not independently reported",
    ),
    predictiveSources: unknown(
      "predictive-source health is not independently reported",
    ),
    venueBook: unknown("venue-book freshness is not independently reported"),
    userChannel: unknown(
      "authenticated user-channel health is not independently reported",
    ),
    restApi: unknown("exchange REST health is not independently reported"),
    clock: unknown("clock drift is not independently reported"),
    modelRegistry: unknown(
      "approved production model registry is not connected to this legacy session",
    ),
    reconciliation: unknown(
      "wallet/ledger reconciliation is not independently reported",
    ),
    killSwitch: unknown(
      "production risk kill-switch state is not connected to this legacy session",
    ),
  };
  const blockReasons = [
    input.blockReason,
    ...Object.entries(dependencies)
      .filter(([, dependency]) => dependency.status !== "HEALTHY")
      .map(
        ([name, dependency]) =>
          `${name}: ${dependency.status.toLowerCase()} (${dependency.detail})`,
      ),
  ].filter((reason): reason is string => Boolean(reason));
  if (input.completionProven && input.engineRunning) {
    blockReasons.push(
      "session completion is proven; a completed session is not trading-ready",
    );
  }
  return {
    schemaVersion: 1,
    checkedAtMs: now,
    controlPlane: "HEALTHY",
    tradingReadiness: "BLOCKED",
    dependencies,
    blockReasons,
  };
}

export function validateHealthReport(
  report: ProductionHealthReport,
): ProductionHealthReport {
  for (const dependency of REQUIRED_TRADING_DEPENDENCIES) {
    if (!report.dependencies[dependency]) {
      throw new Error(`health report missing dependency ${dependency}`);
    }
  }
  const nonHealthy = Object.entries(report.dependencies).filter(
    ([, value]) => value.status !== "HEALTHY",
  );
  if (report.tradingReadiness === "READY" && nonHealthy.length > 0) {
    throw new Error(
      `trading cannot be READY with unhealthy dependencies: ${nonHealthy
        .map(([name]) => name)
        .join(", ")}`,
    );
  }
  return structuredClone(report);
}
