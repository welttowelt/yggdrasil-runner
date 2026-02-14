import fs from "node:fs";
import path from "node:path";

type ProfileConfigHint = {
  app?: { dataDir?: string };
  logging?: { eventsFile?: string; milestonesFile?: string };
  session?: { username?: string };
};

type LastAction = { type: string; reason?: string; atMs: number };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function safeParseJsonLine(line: string): any | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function toMs(ts: unknown): number | null {
  if (!isNonEmptyString(ts)) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

function parseMaybeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return undefined;
    try {
      const n = s.startsWith("0x") ? parseInt(s, 16) : parseInt(s, 10);
      if (Number.isFinite(n)) return n;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function readTail(filePath: string, maxBytes: number): string {
  if (!fs.existsSync(filePath)) return "";
  const stat = fs.statSync(filePath);
  const size = stat.size;
  const start = Math.max(0, size - Math.max(0, maxBytes));
  const toRead = size - start;
  if (toRead <= 0) return "";

  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(toRead);
    fs.readSync(fd, buf, 0, toRead, start);
    let text = buf.toString("utf8");
    // Drop partial first line if we started mid-file.
    if (start > 0) {
      const firstNl = text.indexOf("\n");
      if (firstNl >= 0) text = text.slice(firstNl + 1);
      else text = "";
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function tailJsonlObjects(filePath: string, maxBytes: number): any[] {
  const text = readTail(filePath, maxBytes);
  if (!text) return [];
  const out: any[] = [];
  for (const line of text.split("\n")) {
    const obj = safeParseJsonLine(line);
    if (obj) out.push(obj);
  }
  return out;
}

function fmtAge(ms: number | null, nowMs: number): string {
  if (ms == null) return "—";
  const age = Math.max(0, nowMs - ms);
  const s = Math.round(age / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

function resolveConfigDir(rootDir: string): string {
  const env = process.env.RUNNER_CONFIG_DIR;
  const candidates = [
    ...(env ? [env] : []),
    "config/_local",
    "config"
  ];
  for (const c of candidates) {
    const abs = path.resolve(rootDir, c);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return abs;
  }
  return path.resolve(rootDir, "config");
}

function loadProfiles(rootDir: string) {
  const configDir = resolveConfigDir(rootDir);
  const files = fs
    .readdirSync(configDir)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => f !== "default.json" && f !== "local.json")
    .sort();

  const profiles: Array<{
    id: string;
    configFile: string;
    username?: string;
    dataDir: string;
    eventsFile: string;
    milestonesFile: string;
    progressFile: string;
  }> = [];

  for (const file of files) {
    const abs = path.resolve(configDir, file);
    let parsed: ProfileConfigHint | null = null;
    try {
      parsed = JSON.parse(fs.readFileSync(abs, "utf8")) as ProfileConfigHint;
    } catch {
      parsed = null;
    }
    const id = path.basename(file, ".json");
    const dataDir = parsed?.app?.dataDir ?? `./data/${id}`;
    const eventsFile = parsed?.logging?.eventsFile ?? path.join(dataDir, "events.jsonl");
    const milestonesFile = parsed?.logging?.milestonesFile ?? path.join(dataDir, "milestones.jsonl");
    const progressFile = path.join(dataDir, "progress.json");
    const username = parsed?.session?.username && parsed.session.username.trim().length > 0 ? parsed.session.username.trim() : undefined;

    profiles.push({
      id,
      configFile: file,
      username,
      dataDir,
      eventsFile: path.resolve(rootDir, eventsFile),
      milestonesFile: path.resolve(rootDir, milestonesFile),
      progressFile: path.resolve(rootDir, progressFile)
    });
  }

  return profiles;
}

function readBestLevel(progressFile: string): number | null {
  if (!fs.existsSync(progressFile)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(progressFile, "utf8")) as any;
    const lvl = parseMaybeNumber(parsed?.best?.level);
    return lvl != null ? lvl : null;
  } catch {
    return null;
  }
}

async function main() {
  const rootDir = process.cwd();
  const nowMs = Date.now();
  const windowMinutes = parseMaybeNumber(process.env.WINDOW_MINUTES) ?? 60;
  const windowMs = Math.max(1, windowMinutes) * 60_000;
  const cutoffMs = nowMs - windowMs;
  const maxBytes = parseMaybeNumber(process.env.TAIL_BYTES) ?? 2_000_000;

  const profiles = loadProfiles(rootDir);
  const summaries = profiles.map((p) => {
    const events = tailJsonlObjects(p.eventsFile, maxBytes);
    const milestones = tailJsonlObjects(p.milestonesFile, maxBytes);

    let lastSeenMs: number | null = null;
    let lastAction: LastAction | null = null;
    const actionCounts: Record<string, number> = {};
    let stepErrors = 0;
    let timeouts = 0;
    let uiStalls = 0;
    let coachLevel: number | undefined;

    for (const obj of events) {
      const tsMs = toMs(obj?.ts);
      if (tsMs != null) {
        if (lastSeenMs == null || tsMs > lastSeenMs) lastSeenMs = tsMs;
      }
      if (tsMs == null || tsMs < cutoffMs) continue;

      const event = obj?.event;
      if (!isNonEmptyString(event)) continue;
      if (event.startsWith("action.")) {
        const kind = event.slice("action.".length);
        actionCounts[kind] = (actionCounts[kind] ?? 0) + 1;
        lastAction = {
          type: kind,
          reason: isNonEmptyString(obj?.reason) ? obj.reason : undefined,
          atMs: tsMs
        };
      }
      if (event === "chain.step_error") stepErrors += 1;
      if (event === "chain.action_timeout") timeouts += 1;
      if (event === "controller.ui_stall") uiStalls += 1;
      if (event === "coach.summary") {
        const lvl = parseMaybeNumber(obj?.data_level ?? obj?.level);
        if (lvl != null) coachLevel = lvl;
      }
    }

    let currentLevel: number | null = coachLevel ?? null;
    let bestLevel: number | null = readBestLevel(p.progressFile);
    let xpMin: number | null = null;
    let xpMax: number | null = null;

    for (const obj of milestones) {
      const tsMs = toMs(obj?.ts);
      if (tsMs != null) {
        if (lastSeenMs == null || tsMs > lastSeenMs) lastSeenMs = tsMs;
      }
      if (tsMs == null || tsMs < cutoffMs) continue;

      const milestone = obj?.milestone;
      if (!isNonEmptyString(milestone)) continue;
      if (milestone === "xp_gain" || milestone === "level_up" || milestone === "run_end") {
        const lvl = parseMaybeNumber(obj?.data_level ?? obj?.level);
        if (lvl != null) currentLevel = lvl;
        if (lvl != null && (bestLevel == null || lvl > bestLevel)) bestLevel = lvl;
      }
      if (milestone === "xp_gain") {
        const xp = parseMaybeNumber(obj?.xp);
        if (xp != null) {
          if (xpMin == null || xp < xpMin) xpMin = xp;
          if (xpMax == null || xp > xpMax) xpMax = xp;
        }
      }
    }

    const xpDelta = xpMin != null && xpMax != null && xpMax >= xpMin ? xpMax - xpMin : null;

    return {
      id: p.id,
      username: p.username,
      configFile: p.configFile,
      level: currentLevel,
      bestLevel,
      lastSeenMs,
      lastAction,
      actionCounts,
      xpDelta,
      stepErrors,
      timeouts,
      uiStalls
    };
  });

  summaries.sort((a, b) => {
    const al = a.level ?? -1;
    const bl = b.level ?? -1;
    if (bl !== al) return bl - al;
    const ab = a.bestLevel ?? -1;
    const bb = b.bestLevel ?? -1;
    if (bb !== ab) return bb - ab;
    const an = (a.username || a.id).toLowerCase();
    const bn = (b.username || b.id).toLowerCase();
    return an.localeCompare(bn);
  });

  console.log(`Window: last ${windowMinutes}m (tail=${maxBytes} bytes)`);
  for (const s of summaries) {
    const name = s.username || s.id;
    const lvl = s.level ?? "—";
    const best = s.bestLevel ?? "—";
    const seen = fmtAge(s.lastSeenMs, nowMs);
    const act = s.lastAction ? `${s.lastAction.type} (${fmtAge(s.lastAction.atMs, nowMs)} ago)` : "—";
    const xp = s.xpDelta != null ? `xpΔ${s.xpDelta}` : "xpΔ—";
    const errs = `err${s.stepErrors}/to${s.timeouts}/stall${s.uiStalls}`;
    const topActions = Object.entries(s.actionCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, v]) => `${k}:${v}`)
      .join(" ");

    console.log(`${name.padEnd(14)} lvl=${String(lvl).padEnd(3)} best=${String(best).padEnd(3)} seen=${seen.padEnd(4)} last=${act.padEnd(18)} ${xp.padEnd(8)} ${errs.padEnd(16)} ${topActions}`);
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("coach report failed", error);
  process.exitCode = 1;
});

