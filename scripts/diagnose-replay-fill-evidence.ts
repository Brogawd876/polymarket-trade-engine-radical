import { createReadStream } from "fs";
import { createInterface } from "readline";

type Counts = Record<string, number>;

type ReplayDiagnostics = {
  path: string;
  slug: string | null;
  totalEvents: number;
  firstTsMs: number | null;
  lastTsMs: number | null;
  typeCounts: Counts;
  strategyIds: Counts;
  decisionFeatureEvents: Counts;
  orderStatusCounts: Counts;
  rawOrderIntentCount: number;
  rawOrderCount: number;
  rawFillCount: number;
  rawBlockedDecisionCount: number;
  rawNoTradeOrHoldCount: number;
  decisionFeatureIntentCount: number;
  decisionFeatureFillCount: number;
  decisionFeatureBlockedCount: number;
  decisionFeatureNoTradeOrHoldCount: number;
  tokenIdPresenceCount: number;
  intentIdPresenceCount: number;
  orderIdPresenceCount: number;
  placementTimestampPresenceCount: number;
  slotStartCount: number;
  slotEndCount: number;
  eventsAfterFirstSlotEnd: number;
  conservativeEvidenceReason: string;
};

type L2Diagnostics = {
  path: string;
  totalEvents: number;
  firstTsMs: number | null;
  lastTsMs: number | null;
  eventTypeCounts: Counts;
  uniqueTokenIds: number;
  slugCounts: Counts;
  slugMatchesRequested: boolean | null;
  hasBookEvidence: boolean;
  hasTradeThroughEvidenceInput: boolean;
};

function usage(): never {
  console.error("Usage: bun scripts/diagnose-replay-fill-evidence.ts --replay <path> [--l2 <path>] [--slug <slug>] [--json]");
  process.exit(1);
}

function inc(counts: Counts, key: string | null | undefined) {
  const normalized = key || "unknown";
  counts[normalized] = (counts[normalized] ?? 0) + 1;
}

function numericTs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function noteTimestamp(diag: { firstTsMs: number | null; lastTsMs: number | null }, ts: number | null) {
  if (ts === null) return;
  if (diag.firstTsMs === null || ts < diag.firstTsMs) diag.firstTsMs = ts;
  if (diag.lastTsMs === null || ts > diag.lastTsMs) diag.lastTsMs = ts;
}

async function diagnoseReplay(path: string, slug: string | null): Promise<ReplayDiagnostics> {
  const diag: ReplayDiagnostics = {
    path,
    slug,
    totalEvents: 0,
    firstTsMs: null,
    lastTsMs: null,
    typeCounts: {},
    strategyIds: {},
    decisionFeatureEvents: {},
    orderStatusCounts: {},
    rawOrderIntentCount: 0,
    rawOrderCount: 0,
    rawFillCount: 0,
    rawBlockedDecisionCount: 0,
    rawNoTradeOrHoldCount: 0,
    decisionFeatureIntentCount: 0,
    decisionFeatureFillCount: 0,
    decisionFeatureBlockedCount: 0,
    decisionFeatureNoTradeOrHoldCount: 0,
    tokenIdPresenceCount: 0,
    intentIdPresenceCount: 0,
    orderIdPresenceCount: 0,
    placementTimestampPresenceCount: 0,
    slotStartCount: 0,
    slotEndCount: 0,
    eventsAfterFirstSlotEnd: 0,
    conservativeEvidenceReason: "unknown",
  };

  let sawFirstSlotEnd = false;

  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      inc(diag.typeCounts, "parse_error");
      continue;
    }

    diag.totalEvents++;
    const ts = numericTs(event.ts);
    noteTimestamp(diag, ts);
    inc(diag.typeCounts, event.type);

    if (sawFirstSlotEnd) diag.eventsAfterFirstSlotEnd++;
    if (event.type === "slot" && event.action === "start") diag.slotStartCount++;
    if (event.type === "slot" && event.action === "end") {
      diag.slotEndCount++;
      sawFirstSlotEnd = true;
    }

    if (event.type === "order") {
      diag.rawOrderCount++;
      inc(diag.orderStatusCounts, event.status);
      if (event.status === "filled" || event.status === "partial_filled") diag.rawFillCount++;
      if (event.orderId) diag.orderIdPresenceCount++;
      if (event.intentId) diag.intentIdPresenceCount++;
      if (event.tokenId) diag.tokenIdPresenceCount++;
      if (event.createdAtMs || event.placedTsMs) diag.placementTimestampPresenceCount++;
    }

    if (event.type === "ORDER_INTENT") {
      diag.rawOrderIntentCount++;
      const intent = event.payload?.intent;
      if (intent?.tokenId) diag.tokenIdPresenceCount++;
      if (intent?.id) diag.intentIdPresenceCount++;
      if (intent?.createdAtMs) diag.placementTimestampPresenceCount++;
    }

    if (event.type === "ORDER_LIFECYCLE") {
      const payload = event.payload ?? {};
      inc(diag.orderStatusCounts, payload.status);
      if (payload.status === "filled" || payload.status === "partial_filled") diag.rawFillCount++;
      if (payload.orderId) diag.orderIdPresenceCount++;
      if (payload.intentId) diag.intentIdPresenceCount++;
      if (payload.tokenId) diag.tokenIdPresenceCount++;
    }

    if (event.type === "RISK_DECISION" && event.payload?.approved === false) {
      diag.rawBlockedDecisionCount++;
    }

    const snapshot = event.snapshot;
    if (event.type === "decision_feature" && snapshot) {
      inc(diag.decisionFeatureEvents, snapshot.event);
      inc(diag.strategyIds, snapshot.strategy?.id);
      if (snapshot.intent) {
        diag.decisionFeatureIntentCount++;
        if (snapshot.intent.id) diag.intentIdPresenceCount++;
        if (snapshot.intent.tokenId) diag.tokenIdPresenceCount++;
        if (snapshot.intent.createdAtMs) diag.placementTimestampPresenceCount++;
      }
      if (snapshot.outcome?.orderId) diag.orderIdPresenceCount++;
      if (snapshot.event === "filled") diag.decisionFeatureFillCount++;
      if (snapshot.event === "blocked" || snapshot.risk?.approved === false) diag.decisionFeatureBlockedCount++;
      if (snapshot.event === "no_trade" || snapshot.event === "hold") diag.decisionFeatureNoTradeOrHoldCount++;
    }

    if (event.type === "info") {
      const msg = String(event.msg ?? "").toLowerCase();
      if (msg.includes("no trade") || msg.includes("hold")) diag.rawNoTradeOrHoldCount++;
      if (msg.includes("blocked")) diag.rawBlockedDecisionCount++;
    }
  }

  if (diag.rawFillCount === 0 && diag.decisionFeatureFillCount === 0) {
    diag.conservativeEvidenceReason = "no_replay_fill_events";
  } else if (diag.tokenIdPresenceCount === 0) {
    diag.conservativeEvidenceReason = "fills_or_intents_lack_token_id_mapping";
  } else if (diag.placementTimestampPresenceCount === 0) {
    diag.conservativeEvidenceReason = "fills_or_intents_lack_placement_timestamp";
  } else {
    diag.conservativeEvidenceReason = "replay_contains_candidate_fill_mapping_fields";
  }

  return diag;
}

async function diagnoseL2(path: string, slug: string | null): Promise<L2Diagnostics> {
  const diag: L2Diagnostics = {
    path,
    totalEvents: 0,
    firstTsMs: null,
    lastTsMs: null,
    eventTypeCounts: {},
    uniqueTokenIds: 0,
    slugCounts: {},
    slugMatchesRequested: slug ? true : null,
    hasBookEvidence: false,
    hasTradeThroughEvidenceInput: false,
  };
  const tokenIds = new Set<string>();

  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      inc(diag.eventTypeCounts, "parse_error");
      continue;
    }

    diag.totalEvents++;
    inc(diag.eventTypeCounts, event.eventType);
    noteTimestamp(diag, numericTs(event.receivedTsMs) ?? numericTs(event.processedTsMs));
    inc(diag.slugCounts, event.slug);
    if (slug && event.slug && event.slug !== slug) diag.slugMatchesRequested = false;
    const tokenId = event.payload?.tokenId;
    if (typeof tokenId === "string" && tokenId.length > 0) tokenIds.add(tokenId);
  }

  diag.uniqueTokenIds = tokenIds.size;
  diag.hasBookEvidence =
    (diag.eventTypeCounts.market_book_snapshot ?? 0) + (diag.eventTypeCounts.market_book_delta ?? 0) > 0;
  diag.hasTradeThroughEvidenceInput = (diag.eventTypeCounts.market_trade ?? 0) > 0;
  return diag;
}

function formatReport(replay: ReplayDiagnostics, l2: L2Diagnostics | null): string {
  const lines = [
    `Replay: ${replay.path}`,
    `Slug: ${replay.slug ?? "unknown"}`,
    `Replay events: ${replay.totalEvents}`,
    `Replay first/last ts: ${replay.firstTsMs ?? "n/a"} / ${replay.lastTsMs ?? "n/a"}`,
    `Replay type counts: ${JSON.stringify(replay.typeCounts)}`,
    `Strategy IDs: ${JSON.stringify(replay.strategyIds)}`,
    `Decision feature events: ${JSON.stringify(replay.decisionFeatureEvents)}`,
    `Order status counts: ${JSON.stringify(replay.orderStatusCounts)}`,
    `Raw order intents: ${replay.rawOrderIntentCount}`,
    `Raw orders: ${replay.rawOrderCount}`,
    `Raw fills: ${replay.rawFillCount}`,
    `Decision-feature intents: ${replay.decisionFeatureIntentCount}`,
    `Decision-feature fills: ${replay.decisionFeatureFillCount}`,
    `Blocked decisions: ${replay.rawBlockedDecisionCount + replay.decisionFeatureBlockedCount}`,
    `No-trade/hold markers: ${replay.rawNoTradeOrHoldCount + replay.decisionFeatureNoTradeOrHoldCount}`,
    `tokenId presence count: ${replay.tokenIdPresenceCount}`,
    `intentId presence count: ${replay.intentIdPresenceCount}`,
    `orderId presence count: ${replay.orderIdPresenceCount}`,
    `placement timestamp presence count: ${replay.placementTimestampPresenceCount}`,
    `Slot starts/ends: ${replay.slotStartCount} / ${replay.slotEndCount}`,
    `Events after first slot end: ${replay.eventsAfterFirstSlotEnd}`,
    `Conservative evidence reason: ${replay.conservativeEvidenceReason}`,
  ];

  if (l2) {
    lines.push(
      "",
      `Raw L2: ${l2.path}`,
      `Raw L2 events: ${l2.totalEvents}`,
      `Raw L2 first/last ts: ${l2.firstTsMs ?? "n/a"} / ${l2.lastTsMs ?? "n/a"}`,
      `Raw L2 event type counts: ${JSON.stringify(l2.eventTypeCounts)}`,
      `Raw L2 unique tokenIds: ${l2.uniqueTokenIds}`,
      `Raw L2 slug counts: ${JSON.stringify(l2.slugCounts)}`,
      `Raw L2 slug matches requested: ${l2.slugMatchesRequested ?? "n/a"}`,
      `Book evidence available: ${l2.hasBookEvidence}`,
      `Trade-through evidence input available: ${l2.hasTradeThroughEvidenceInput}`,
    );
  }

  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  let replayPath = "";
  let l2Path: string | null = null;
  let slug: string | null = null;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--replay") replayPath = args[++i] ?? "";
    else if (arg === "--l2") l2Path = args[++i] ?? "";
    else if (arg === "--slug") slug = args[++i] ?? "";
    else if (arg === "--json") json = true;
  }

  if (!replayPath) usage();

  const replay = await diagnoseReplay(replayPath, slug);
  const l2 = l2Path ? await diagnoseL2(l2Path, slug) : null;
  if (json) {
    console.log(JSON.stringify({ replay, l2 }, null, 2));
  } else {
    console.log(formatReport(replay, l2));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
