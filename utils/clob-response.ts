export function responseError(resp: unknown): string | null {
  if (!resp) return "empty response";
  if (typeof resp !== "object") return null;

  const record = resp as Record<string, unknown>;
  if (typeof record.status === "number" && record.status >= 400) {
    return JSON.stringify(resp);
  }
  if (record.error) return JSON.stringify(resp);
  if (record.success === false || record.errorMsg) {
    return record.errorMsg ? String(record.errorMsg) : JSON.stringify(resp);
  }
  return null;
}

export function extractOrderId(resp: unknown): string | null {
  if (!resp || typeof resp !== "object") return null;
  const record = resp as Record<string, unknown>;
  const id = record.orderID ?? record.orderId ?? record.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
