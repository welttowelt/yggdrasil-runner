export function parseNumber(input: string | null | undefined): number | null {
  if (!input) return null;
  const cleaned = input.replace(/[^0-9.-]/g, "");
  if (cleaned.length === 0) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
