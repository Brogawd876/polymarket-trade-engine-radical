export type Tz = "local" | "ET" | "UTC";

export type DataSource =
  | { kind: "default" }
  | { kind: "custom"; name: string; files: File[] };

const TZ_NAME: Record<Tz, string | undefined> = {
  local: undefined, // browser local
  ET: "America/New_York",
  UTC: "UTC",
};

const TZ_LABEL: Record<Tz, string> = {
  local: "Local",
  ET: "ET",
  UTC: "UTC",
};

export function tzLabel(tz: Tz): string {
  return TZ_LABEL[tz];
}

// Pull year/month/day/hour values for a timestamp in the target tz.
export function getZonedParts(
  ms: number,
  tz: Tz,
): { y: number; mo: number; d: number; h: number } {
  if (tz === "UTC") {
    const d = new Date(ms);
    return {
      y: d.getUTCFullYear(),
      mo: d.getUTCMonth(),
      d: d.getUTCDate(),
      h: d.getUTCHours(),
    };
  }
  if (tz === "local") {
    const d = new Date(ms);
    return {
      y: d.getFullYear(),
      mo: d.getMonth(),
      d: d.getDate(),
      h: d.getHours(),
    };
  }
  // ET (or any future Intl-based tz) â€” reuse a cached formatter; constructing
  // Intl.DateTimeFormat is expensive and bin-filling calls this thousands of times.
  const parts = partsFmt(tz).formatToParts(ms);
  let y = 0,
    mo = 0,
    d = 0,
    h = 0;
  for (const p of parts) {
    if (p.type === "year") y = +p.value;
    else if (p.type === "month") mo = +p.value - 1;
    else if (p.type === "day") d = +p.value;
    else if (p.type === "hour") h = +p.value % 24;
  }
  return { y, mo, d, h };
}

// Cache `Intl.DateTimeFormat` instances per tz.
const partsFmtCache = new Map<Tz, Intl.DateTimeFormat>();
function partsFmt(tz: Tz): Intl.DateTimeFormat {
  let f = partsFmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ_NAME[tz],
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    });
    partsFmtCache.set(tz, f);
  }
  return f;
}

export function formatDateTime(ms: number, tz: Tz): string {
  return (
    new Date(ms).toLocaleString("en-US", {
      timeZone: TZ_NAME[tz],
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }) + (tz !== "local" ? ` ${TZ_LABEL[tz]}` : "")
  );
}
