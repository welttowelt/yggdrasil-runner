import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RpcProvider } from "starknet";
import type { Request, Response } from "express";

type ProfileConfigHint = {
  app?: { dataDir?: string };
  logging?: { eventsFile?: string; milestonesFile?: string };
  session?: { file?: string; username?: string };
  chain?: { rpcReadUrl?: string };
};

type SessionStatusKind = "active" | "idle" | "short_break" | "sleep_break" | "stalled" | "unknown";
type SessionTone = "good" | "warn" | "sleep" | "bad" | "muted";

type SessionSummary = {
  id: string;
  configFile: string;
  username?: string;
  address?: string;
  adventurerId?: number;
  playUrl?: string;
  level?: number;
  bestLevel?: number;
  lastAction?: { type: string; at: string; reason?: string };
  coach?: { at: string; hpPct?: number; gold?: number; xp?: number; actionCount?: number };
  runsStarted: number;
  runsEnded: number;
  strk?: { value: string; fetchedAt: string };
  lastSeen?: string;
  status: { kind: SessionStatusKind; label: string; tone: SessionTone };
  notes?: string;
};

type BreakState = {
  kind: "short" | "sleep";
  startMs: number;
  durationMs: number;
  untilMs: number;
};

const STRK_TOKEN_MAINNET = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const STRK_DECIMALS = 18;

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

function formatUnits(value: bigint, decimals: number, precision = 4): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;
  if (precision <= 0) return whole.toString();
  const fracScaled = (frac * 10n ** BigInt(precision)) / base;
  const fracStr = fracScaled.toString().padStart(precision, "0").replace(/0+$/, "");
  return fracStr.length ? `${whole}.${fracStr}` : whole.toString();
}

function normalizeHexAddress(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (!trimmed.startsWith("0x")) return trimmed;
  return "0x" + trimmed.slice(2).toLowerCase();
}

function isPlaceholderControllerAddress(address: string | undefined): boolean {
  if (!address) return true;
  const a = address.trim();
  if (!a) return true;
  if (a === "controller") return true;
  const norm = normalizeHexAddress(a);
  return norm === "0x0" || norm === "0x00" || norm === "0x";
}

class JsonlTailer {
  private filePath: string;
  private offset = 0;
  private remainder = "";
  private lastSize = 0;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  readNewObjects(): any[] {
    if (!fs.existsSync(this.filePath)) return [];
    const stat = fs.statSync(this.filePath);
    const size = stat.size;
    if (size < this.offset) {
      // File rotated/truncated.
      this.offset = 0;
      this.remainder = "";
    }
    if (size === this.offset && size === this.lastSize) return [];

    const toRead = size - this.offset;
    if (toRead <= 0) {
      this.lastSize = size;
      return [];
    }
    const fd = fs.openSync(this.filePath, "r");
    try {
      const buf = Buffer.alloc(toRead);
      fs.readSync(fd, buf, 0, toRead, this.offset);
      this.offset += toRead;
      this.lastSize = size;
      const text = this.remainder + buf.toString("utf8");
      const lines = text.split("\n");
      this.remainder = lines.pop() ?? "";
      const out: any[] = [];
      for (const line of lines) {
        const obj = safeParseJsonLine(line);
        if (obj) out.push(obj);
      }
      return out;
    } finally {
      fs.closeSync(fd);
    }
  }
}

const providerCache = new Map<string, RpcProvider>();
function getProvider(nodeUrl: string): RpcProvider {
  const existing = providerCache.get(nodeUrl);
  if (existing) return existing;
  const provider = new RpcProvider({ nodeUrl });
  providerCache.set(nodeUrl, provider);
  return provider;
}

async function fetchErc20Balance(
  provider: RpcProvider,
  tokenAddress: string,
  accountAddress: string
): Promise<bigint> {
  const normToken = normalizeHexAddress(tokenAddress);
  const normAccount = normalizeHexAddress(accountAddress);
  const entrypoints = ["balanceOf", "balance_of"];
  let lastError: unknown = null;
  for (const name of entrypoints) {
    try {
      const res = await provider.callContract({
        contractAddress: normToken,
        entrypoint: name,
        calldata: [normAccount]
      });
      const out = res ?? [];
      if (!Array.isArray(out) || out.length < 2) {
        throw new Error(`unexpected balanceOf result length: ${Array.isArray(out) ? out.length : typeof out}`);
      }
      const low = BigInt(out[0]);
      const high = BigInt(out[1]);
      return low + (high << 128n);
    } catch (error) {
      lastError = error;
      continue;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "balance fetch failed"));
}

class SessionMonitor {
  private id: string;
  private configFile: string;
  private rpcReadUrl: string;
  private eventsTailer: JsonlTailer;
  private milestonesTailer: JsonlTailer;
  private sessionFile: string;
  private configuredUsername?: string;

  private username?: string;
  private address?: string;
  private adventurerId?: number;
  private playUrl?: string;
  private level?: number;
  private bestLevel?: number;
  private adventurerIdsSeen = new Set<number>();
  private runsEnded = 0;
  private lastSeenMs: number | null = null;
  private lastError: string | null = null;
  private lastErrorAtMs: number | null = null;
  private breakState: BreakState | null = null;
  private lastAction: { type: string; reason?: string; tsMs: number } | null = null;
  private coachSnapshot: { tsMs: number; hpPct?: number; gold?: number; xp?: number; actionCount?: number } | null = null;
  private strkCache: { value: string; fetchedAtMs: number } | null = null;
  private lastIdentityReadAtMs = 0;

  constructor(opts: {
    id: string;
    configFile: string;
    rpcReadUrl: string;
    eventsFile: string;
    milestonesFile: string;
    sessionFile: string;
    configuredUsername?: string;
  }) {
    this.id = opts.id;
    this.configFile = opts.configFile;
    this.rpcReadUrl = opts.rpcReadUrl;
    this.eventsTailer = new JsonlTailer(opts.eventsFile);
    this.milestonesTailer = new JsonlTailer(opts.milestonesFile);
    this.sessionFile = opts.sessionFile;
    this.configuredUsername = opts.configuredUsername;
    if (isNonEmptyString(this.configuredUsername) && !isNonEmptyString(this.username)) {
      this.username = this.configuredUsername;
    }
  }

  private touch(tsMs: number | null) {
    if (tsMs == null) return;
    if (this.lastSeenMs == null || tsMs > this.lastSeenMs) {
      this.lastSeenMs = tsMs;
    }
  }

  private maybeReadIdentity(nowMs: number) {
    if (nowMs - this.lastIdentityReadAtMs < 5000) return;
    this.lastIdentityReadAtMs = nowMs;
    if (!fs.existsSync(this.sessionFile)) return;
    try {
      const raw = fs.readFileSync(this.sessionFile, "utf8");
      const parsed = JSON.parse(raw) as any;
      if (isNonEmptyString(parsed?.username)) {
        this.username = parsed.username;
      }
      if (isNonEmptyString(parsed?.address)) {
        this.address = parsed.address;
      }
      if (typeof parsed?.adventurerId === "number") {
        this.adventurerId = parsed.adventurerId;
      }
      if (isNonEmptyString(parsed?.playUrl)) {
        this.playUrl = parsed.playUrl;
      }
    } catch {
      // ignore
    }
  }

  private processEvent(obj: any) {
    const tsMs = toMs(obj?.ts);
    this.touch(tsMs);
    const event = obj?.event;
    if (!isNonEmptyString(event)) return;

    if (event.startsWith("action.")) {
      const kind = event.slice("action.".length);
      const reason = isNonEmptyString(obj?.reason) ? obj.reason : undefined;
      this.lastAction = { type: kind, reason, tsMs: tsMs ?? Date.now() };
    }

    if (event === "chain.state_sync_ok" || event === "chain.recovered") {
      // Clear transient errors (for example flaky reads) once we see forward progress.
      this.lastError = null;
      this.lastErrorAtMs = null;
    }

    if (event === "coach.summary") {
      const hpPct = typeof obj?.hpPct === "number" && Number.isFinite(obj.hpPct) ? obj.hpPct : undefined;
      const gold = parseMaybeNumber(obj?.gold);
      const xp = parseMaybeNumber(obj?.xp);
      const actionCount = parseMaybeNumber(obj?.actionCount);
      this.coachSnapshot = { tsMs: tsMs ?? Date.now(), hpPct, gold, xp, actionCount };

      // `coach.summary` uses reserved key `level` which gets renamed by Logger => `data_level`.
      const lvl = parseMaybeNumber(obj?.data_level ?? obj?.level);
      if (lvl != null) {
        this.level = lvl;
        if (this.bestLevel == null || lvl > this.bestLevel) {
          this.bestLevel = lvl;
        }
      }
    }

    if (event === "chain.start") {
      const adv = parseMaybeNumber(obj?.adventurerId);
      if (adv != null) {
        this.adventurerId = adv;
        this.adventurerIdsSeen.add(adv);
      }
      if (isNonEmptyString(obj?.address)) this.address = obj.address;
    }

    if (event === "session.sync_adventurer") {
      const adv = parseMaybeNumber(obj?.to);
      if (adv != null) {
        this.adventurerId = adv;
        this.adventurerIdsSeen.add(adv);
      }
      if (isNonEmptyString(obj?.playUrl)) this.playUrl = obj.playUrl;
    }

    if (event === "pacing.break_start") {
      const kind = obj?.kind === "sleep" ? "sleep" : "short";
      const durationMs = parseMaybeNumber(obj?.durationMs) ?? 0;
      const startMs = tsMs ?? Date.now();
      const untilMs = startMs + Math.max(0, durationMs);
      this.breakState = { kind, startMs, durationMs, untilMs };
    }

    if (event === "pacing.break_end") {
      this.breakState = null;
    }

    if (event === "chain.step_error") {
      const err = isNonEmptyString(obj?.error) ? obj.error : null;
      if (err) {
        this.lastError = err;
        this.lastErrorAtMs = tsMs ?? Date.now();
      }
    }
  }

  private processMilestone(obj: any) {
    const tsMs = toMs(obj?.ts);
    this.touch(tsMs);
    const milestone = obj?.milestone;
    if (!isNonEmptyString(milestone)) return;

    if (milestone === "xp_gain") {
      const lvl = parseMaybeNumber(obj?.data_level ?? obj?.level);
      if (lvl != null) {
        this.level = lvl;
        if (this.bestLevel == null || lvl > this.bestLevel) {
          this.bestLevel = lvl;
        }
      }
    }

    if (milestone === "run_end") {
      this.runsEnded += 1;
      const lvl = parseMaybeNumber(obj?.data_level ?? obj?.level);
      if (lvl != null) {
        this.level = lvl;
        if (this.bestLevel == null || lvl > this.bestLevel) {
          this.bestLevel = lvl;
        }
      }
    }
  }

  private computeStatus(nowMs: number): { kind: SessionStatusKind; label: string; tone: SessionTone } {
    if (this.breakState && nowMs < this.breakState.untilMs) {
      const remainingMs = this.breakState.untilMs - nowMs;
      const mins = Math.max(0, Math.round(remainingMs / 60000));
      const label = this.breakState.kind === "sleep" ? `SLEEP ~${mins}m` : `BREAK ~${mins}m`;
      return {
        kind: this.breakState.kind === "sleep" ? "sleep_break" : "short_break",
        label,
        tone: this.breakState.kind === "sleep" ? "sleep" : "warn"
      };
    }

    if (!this.lastSeenMs) {
      return { kind: "unknown", label: "NO DATA", tone: "muted" };
    }
    const ageMs = nowMs - this.lastSeenMs;
    if (ageMs <= 45_000) {
      return { kind: "active", label: "ACTIVE", tone: "good" };
    }
    if (ageMs <= 5 * 60_000) {
      const mins = Math.max(1, Math.round(ageMs / 60000));
      return { kind: "idle", label: `IDLE ${mins}m`, tone: "warn" };
    }
    const mins = Math.max(5, Math.round(ageMs / 60000));
    return { kind: "stalled", label: `STALE ${mins}m`, tone: "bad" };
  }

  private async maybeUpdateStrkBalance(nowMs: number) {
    if (isPlaceholderControllerAddress(this.address)) return;
    const cacheTtlMs = 60_000;
    if (this.strkCache && nowMs - this.strkCache.fetchedAtMs < cacheTtlMs) return;

    try {
      const provider = getProvider(this.rpcReadUrl);
      const raw = await fetchErc20Balance(provider, STRK_TOKEN_MAINNET, this.address!);
      const value = formatUnits(raw, STRK_DECIMALS, 4);
      this.strkCache = { value, fetchedAtMs: nowMs };
    } catch (error) {
      // Keep previous value if any; add a note for visibility.
      if (!this.lastError) {
        this.lastError = `balance_error: ${String(error)}`;
        this.lastErrorAtMs = nowMs;
      }
    }
  }

  async refresh(nowMs: number) {
    this.maybeReadIdentity(nowMs);

    for (const obj of this.eventsTailer.readNewObjects()) {
      this.processEvent(obj);
    }
    for (const obj of this.milestonesTailer.readNewObjects()) {
      this.processMilestone(obj);
    }

    await this.maybeUpdateStrkBalance(nowMs);
  }

  snapshot(nowMs: number): SessionSummary {
    const status = this.computeStatus(nowMs);
    const lastSeen = this.lastSeenMs ? new Date(this.lastSeenMs).toISOString() : undefined;
    const address = isNonEmptyString(this.address) ? this.address : undefined;
    const username = isNonEmptyString(this.username) ? this.username : undefined;
    const notesMaxAgeMs = 2 * 60_000;
    const notesAgeMs = this.lastErrorAtMs != null ? nowMs - this.lastErrorAtMs : null;
    const notes =
      this.lastError && (notesAgeMs == null || notesAgeMs <= notesMaxAgeMs) ? this.lastError : undefined;

    return {
      id: this.id,
      configFile: this.configFile,
      username,
      address,
      adventurerId: this.adventurerId,
      playUrl: this.playUrl,
      level: this.level,
      bestLevel: this.bestLevel,
      lastAction: this.lastAction
        ? {
            type: this.lastAction.type,
            at: new Date(this.lastAction.tsMs).toISOString(),
            reason: this.lastAction.reason
          }
        : undefined,
      coach: this.coachSnapshot
        ? {
            at: new Date(this.coachSnapshot.tsMs).toISOString(),
            hpPct: this.coachSnapshot.hpPct,
            gold: this.coachSnapshot.gold,
            xp: this.coachSnapshot.xp,
            actionCount: this.coachSnapshot.actionCount
          }
        : undefined,
      runsStarted: this.adventurerIdsSeen.size,
      runsEnded: this.runsEnded,
      strk: this.strkCache
        ? {
            value: this.strkCache.value,
            fetchedAt: new Date(this.strkCache.fetchedAtMs).toISOString()
          }
        : undefined,
      lastSeen,
      status,
      notes
    };
  }
}

function loadProfileConfigs(rootDir: string): Array<{
  id: string;
  configFile: string;
  rpcReadUrl: string;
  eventsFile: string;
  milestonesFile: string;
  sessionFile: string;
  configuredUsername?: string;
}> {
  const configDirName = process.env.RUNNER_CONFIG_DIR || "config";
  const configDir = path.resolve(rootDir, configDirName);
  if (!fs.existsSync(configDir)) return [];
  const files = fs
    .readdirSync(configDir)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => f !== "default.json" && f !== "local.json")
    .sort();

  const out: Array<{
    id: string;
    configFile: string;
    rpcReadUrl: string;
    eventsFile: string;
    milestonesFile: string;
    sessionFile: string;
    configuredUsername?: string;
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
    const sessionFile = parsed?.session?.file ?? path.join(dataDir, "session.json");
    const configuredUsername =
      parsed?.session?.username && parsed.session.username.trim().length > 0 ? parsed.session.username.trim() : undefined;
    const rpcReadUrl =
      parsed?.chain?.rpcReadUrl ?? "https://api.cartridge.gg/x/starknet/mainnet/rpc/v0_9";

    out.push({
      id,
      configFile: file,
      rpcReadUrl,
      eventsFile: path.resolve(rootDir, eventsFile),
      milestonesFile: path.resolve(rootDir, milestonesFile),
      sessionFile: path.resolve(rootDir, sessionFile),
      configuredUsername
    });
  }
  return out;
}

async function main() {
  const rootDir = process.cwd();
  const profiles = loadProfileConfigs(rootDir);
  const monitors = profiles.map((p) => new SessionMonitor(p));

  const app = express();
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.resolve(moduleDir, "public");
  app.use(express.static(publicDir));

  app.get("/api/sessions", async (_req: Request, res: Response) => {
    const nowMs = Date.now();
    await Promise.all(monitors.map((m) => m.refresh(nowMs)));
    const sessions = monitors.map((m) => m.snapshot(nowMs));
    res.json({
      updatedAt: new Date(nowMs).toISOString(),
      sessions
    });
  });

  const port = Number(process.env.DASHBOARD_PORT || "3199");
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Dashboard: http://localhost:${port}`);
  });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Dashboard failed to start", error);
  process.exitCode = 1;
});
