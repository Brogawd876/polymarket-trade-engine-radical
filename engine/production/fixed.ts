export const ACCOUNTING_DECIMALS = 6;
export const ACCOUNTING_SCALE = 1_000_000n;

const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?$/;

/**
 * Parse an exchange/accounting value without passing through a binary float.
 * Values with more than six decimals are rejected rather than rounded.
 */
export function parseAtoms(value: string): bigint {
  const normalized = value.trim();
  const match = DECIMAL_PATTERN.exec(normalized);
  if (!match) throw new Error(`invalid fixed-point value: ${value}`);

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2]!);
  const fraction = match[3] ?? "";
  if (fraction.length > ACCOUNTING_DECIMALS) {
    throw new Error(
      `fixed-point precision exceeds ${ACCOUNTING_DECIMALS} decimals: ${value}`,
    );
  }
  const padded = fraction.padEnd(ACCOUNTING_DECIMALS, "0");
  return sign * (whole * ACCOUNTING_SCALE + BigInt(padded || "0"));
}
export function formatAtoms(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / ACCOUNTING_SCALE;
  const fraction = (absolute % ACCOUNTING_SCALE)
    .toString()
    .padStart(ACCOUNTING_DECIMALS, "0")
    .replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Multiply two six-decimal values and round half away from zero. */
export function multiplyAtoms(left: bigint, right: bigint): bigint {
  const product = left * right;
  const sign = product < 0n ? -1n : 1n;
  const absolute = product < 0n ? -product : product;
  const rounded = (absolute + ACCOUNTING_SCALE / 2n) / ACCOUNTING_SCALE;
  return sign * rounded;
}

export function minAtoms(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

export function assertNonNegativeAtoms(
  label: string,
  value: bigint,
): void {
  if (value < 0n) {
    throw new Error(`${label} must be non-negative, received ${formatAtoms(value)}`);
  }
}
