// Exact, non-negative decimal arithmetic on scaled BigInts. Money never passes through JS
// floats: 0.1 + 0.2 must be 0.3, and per-token prices like 0.00000125 must stay exact.

/** `units / 10^scale`, e.g. `{ units: 125n, scale: 8 }` is 0.00000125. */
export interface ScaledDecimal {
  readonly units: bigint;
  readonly scale: number;
}

const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/;

export class DecimalError extends Error {
  override name = 'DecimalError';
}

/** Parses a non-negative decimal string such as `"0.00000125"` or `"12"`. */
export function parseDecimal(value: string): ScaledDecimal {
  const match = DECIMAL_PATTERN.exec(value);
  if (match === null) {
    throw new DecimalError(`Expected a non-negative decimal string, got "${value}"`);
  }
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  return { units: BigInt(whole + fraction), scale: fraction.length };
}

/** A non-negative safe integer as a decimal with the given scale (e.g. milliseconds, scale 3). */
export function decimalFromInteger(value: number, scale = 0): ScaledDecimal {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DecimalError(`Expected a non-negative safe integer, got ${String(value)}`);
  }
  return { units: BigInt(value), scale };
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function alignScales(a: ScaledDecimal, b: ScaledDecimal): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [a.units * pow10(scale - a.scale), b.units * pow10(scale - b.scale), scale];
}

export function addDecimals(a: ScaledDecimal, b: ScaledDecimal): ScaledDecimal {
  const [x, y, scale] = alignScales(a, b);
  return { units: x + y, scale };
}

export function multiplyDecimals(a: ScaledDecimal, b: ScaledDecimal): ScaledDecimal {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

export function compareDecimals(a: ScaledDecimal, b: ScaledDecimal): -1 | 0 | 1 {
  const [x, y] = alignScales(a, b);
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

/**
 * Formats with exactly `scale` fraction digits, rounding **up** (toward +infinity) when digits
 * are dropped. Rounding up is deliberate for costs: the ledger may over-report spend by at most
 * one unit in the last place, but never under-reports it against a budget cap.
 */
export function formatDecimalCeil(value: ScaledDecimal, scale: number): string {
  let units: bigint;
  if (value.scale <= scale) {
    units = value.units * pow10(scale - value.scale);
  } else {
    const divisor = pow10(value.scale - scale);
    units = value.units / divisor;
    if (value.units % divisor !== 0n) units += 1n;
  }
  if (scale === 0) return units.toString();
  const digits = units.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** Compares two non-negative decimal strings exactly. */
export function compareDecimalStrings(a: string, b: string): -1 | 0 | 1 {
  return compareDecimals(parseDecimal(a), parseDecimal(b));
}
