import fs from "node:fs";
import path from "node:path";

export type BestSnapshotV1 = {
  ts: string;
  adventurerId: number;
  level: number;
  xp: number;
  actionCount: number;
};

export type RunRecordV1 = {
  adventurerId: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  endLevel: number;
  endXp: number;
  endActionCount: number;
  maxLevel: number;
  maxXp: number;
};

export type ProgressStateV1 = {
  version: 1;
  targetLevel: number;
  updatedAt: string;
  best: BestSnapshotV1 | null;
  runs: RunRecordV1[];
};

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonPretty(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

export function progressFilePath(dataDir: string): string {
  return path.resolve(process.cwd(), dataDir, "progress.json");
}

export function loadProgress(filePath: string, targetLevel: number): ProgressStateV1 {
  const base: ProgressStateV1 = {
    version: 1,
    targetLevel: Number.isFinite(targetLevel) ? targetLevel : 50,
    updatedAt: new Date().toISOString(),
    best: null,
    runs: []
  };

  if (!fs.existsSync(filePath)) return base;
  try {
    const parsed = readJson(filePath) as Partial<ProgressStateV1>;
    if (parsed?.version !== 1) return base;
    const best = parsed.best && typeof parsed.best === "object" ? (parsed.best as BestSnapshotV1) : null;
    const runs = Array.isArray(parsed.runs) ? (parsed.runs as RunRecordV1[]) : [];
    return {
      ...base,
      targetLevel: typeof parsed.targetLevel === "number" ? parsed.targetLevel : base.targetLevel,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : base.updatedAt,
      best: best ?? null,
      runs
    };
  } catch {
    return base;
  }
}

export function saveProgress(filePath: string, state: ProgressStateV1) {
  writeJsonPretty(filePath, { ...state, updatedAt: new Date().toISOString() });
}

export function maybeUpdateBest(state: ProgressStateV1, sample: BestSnapshotV1): boolean {
  const current = state.best;
  const shouldUpdate =
    !current ||
    sample.level > current.level ||
    (sample.level === current.level && sample.xp > current.xp) ||
    (sample.level === current.level && sample.xp === current.xp && sample.actionCount > current.actionCount);

  if (!shouldUpdate) return false;
  state.best = sample;
  return true;
}

export function appendRun(state: ProgressStateV1, run: RunRecordV1, maxRuns = 120) {
  state.runs.push(run);
  if (state.runs.length > maxRuns) {
    state.runs = state.runs.slice(state.runs.length - maxRuns);
  }
}

