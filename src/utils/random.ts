export function randomIntInclusive(minInclusive: number, maxInclusive: number) {
  const lo = Math.ceil(Math.min(minInclusive, maxInclusive));
  const hi = Math.floor(Math.max(minInclusive, maxInclusive));
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    throw new Error(`Invalid random range: ${minInclusive}..${maxInclusive}`);
  }
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

export function sampleRangeMs(range: { min: number; max: number } | undefined, fallbackMs: number) {
  if (!range || typeof range.min !== "number" || typeof range.max !== "number") {
    return fallbackMs;
  }
  return randomIntInclusive(range.min, range.max);
}

