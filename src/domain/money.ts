import Decimal from 'decimal.js';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export function D(value: string | number | Decimal): Decimal {
  if (value instanceof Decimal) return value;
  if (value === '' || value === null || value === undefined) return new Decimal(0);
  return new Decimal(value);
}

export function toFixedMoney(value: string | number | Decimal, decimals = 2): string {
  return D(value).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toFixed(decimals);
}

export function toFloorMoney(value: string | number | Decimal, decimals = 2): Decimal {
  return D(value).toDecimalPlaces(decimals, Decimal.ROUND_DOWN);
}

export function applyRoundingStep(value: Decimal, step: string | number | null | undefined, decimals = 2): Decimal {
  if (!step) return value.toDecimalPlaces(decimals, Decimal.ROUND_DOWN);
  const stepD = D(step);
  if (stepD.lte(0)) return value.toDecimalPlaces(decimals, Decimal.ROUND_DOWN);
  return value.div(stepD).floor().mul(stepD).toDecimalPlaces(decimals, Decimal.ROUND_DOWN);
}

export function sumMoney(values: Array<string | number | Decimal>): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(D(v)), new Decimal(0));
}

export function formatCurrency(value: string | number | Decimal, currency = 'SAR'): string {
  const num = Number(toFixedMoney(value, 2));
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
  return `${formatted} ${currency}`;
}
