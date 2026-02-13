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

// Stable 32-bit FNV-1a hash for desynchronizing schedules across runner processes.
export function hashStringFNV1a(value: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function stableIntInRange(
  range: { min: number; max: number } | undefined,
  seed: string,
  fallback: number
) {
  if (!range || typeof range.min !== "number" || typeof range.max !== "number") {
    return fallback;
  }
  const lo = Math.ceil(Math.min(range.min, range.max));
  const hi = Math.floor(Math.max(range.min, range.max));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) {
    return fallback;
  }
  const span = hi - lo + 1;
  if (span <= 1) return lo;
  const h = hashStringFNV1a(seed);
  return lo + (h % span);
}
