// Prices come from the freelancer's rate: the model estimates hours, this file does the arithmetic.

const PRICE_STEP_CENTS = 1000; // round change order prices up to the next $10

// Hours are counted in hundredths so the math stays in integers: 33.2 h × $75 must be $2,490, not $2,500.
function toCentiHours(hours: number): number {
  return Math.round(hours * 100);
}

export function priceForHours(hours: number, hourlyRateCents: number): number {
  if (!(hours > 0) || !(hourlyRateCents > 0)) return 0;
  const centsTimes100 = toCentiHours(hours) * Math.round(hourlyRateCents);
  return Math.ceil(centsTimes100 / (PRICE_STEP_CENTS * 100)) * PRICE_STEP_CENTS;
}

export function extraDaysForHours(hours: number, hoursPerDay: number): number {
  if (!(hours > 0) || !(hoursPerDay > 0)) return 0;
  return Math.ceil(toCentiHours(hours) / toCentiHours(hoursPerDay));
}

export function sumCents(amounts: readonly number[]): number {
  return amounts.reduce((sum, n) => sum + n, 0);
}

const wholeUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const exactUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

// Whole dollars read cleaner; cents are shown only when there are some.
export function formatUsd(cents: number): string {
  return (cents % 100 === 0 ? wholeUsd : exactUsd).format(cents / 100);
}

// PayPal amounts are decimal strings with two places, e.g. "650.00".
export function toPayPalValue(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new RangeError(`invalid amount in cents: ${cents}`);
  return (cents / 100).toFixed(2);
}
