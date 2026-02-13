import fs from "node:fs";
import path from "node:path";

import { RpcProvider } from "starknet";

import { loadConfig } from "../config/load.js";
import { ControllerExecutor } from "../chain/controllerExecutor.js";
import { Logger } from "../utils/logger.js";
import { loadSession, saveSession, type RunnerSession } from "../session/session.js";
import { normalizeStarknetAddress } from "../utils/starknet.js";
import { sleep } from "../utils/time.js";
import type { StarknetCall } from "../chain/vrf.js";

const STRK_TOKEN_MAINNET = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const STRK_DECIMALS = 18n;

type FundingStateV1 = {
  version: 1;
  updatedAt: string;
  topups: Record<
    string,
    {
      lastTopupAt: string;
      lastTxHash?: string;
      amountStrk: string;
    }
  >;
};

type ProfileSnapshot = {
  id: string;
  configFile: string;
  sessionFile: string;
  username?: string;
  address?: string;
  strk?: bigint;
};

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonPretty(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
}

function formatUnits(raw: bigint, decimals: bigint, fracDigits = 4) {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const base = 10n ** decimals;
  const whole = v / base;
  const frac = v % base;
  const fracStr = frac
    .toString()
    .padStart(Number(decimals), "0")
    .slice(0, Math.max(0, Math.min(18, fracDigits)));
  return `${neg ? "-" : ""}${whole.toString()}.${fracStr}`;
}

function uint256Calldata(amount: bigint): [string, string] {
  const mask = (1n << 128n) - 1n;
  const low = amount & mask;
  const high = amount >> 128n;
  return [`0x${low.toString(16)}`, `0x${high.toString(16)}`];
}

function normalizeHexAddress(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (!trimmed.startsWith("0x")) return trimmed;
  return "0x" + trimmed.slice(2).toLowerCase();
}

function mustAddress(value: string | null | undefined, label: string): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) throw new Error(`Invalid address for ${label}`);
  return v;
}

async function fetchStrkBalance(provider: RpcProvider, accountAddress: string): Promise<bigint> {
  const token = mustAddress(normalizeStarknetAddress(STRK_TOKEN_MAINNET), "STRK token");
  const account = mustAddress(normalizeStarknetAddress(accountAddress), "account");
  const entrypoints = ["balanceOf", "balance_of"] as const;
  let lastError: unknown = null;
  for (const entrypoint of entrypoints) {
    try {
      const res = await provider.callContract({
        contractAddress: token,
        entrypoint,
        calldata: [account]
      });
      const out = Array.isArray(res) ? res : [];
      if (out.length < 2) throw new Error("unexpected STRK balanceOf result");
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

function listProfileConfigs(): string[] {
  const configDirName = process.env.RUNNER_CONFIG_DIR || "config";
  const dir = path.resolve(process.cwd(), configDirName);
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  return entries
    .filter((f) => f !== "default.json" && f !== "local.json")
    .map((f) => path.join(configDirName, f))
    .sort();
}

function loadFundingState(stateFile: string): FundingStateV1 {
  if (!fs.existsSync(stateFile)) {
    return { version: 1, updatedAt: new Date().toISOString(), topups: {} };
  }
  try {
    const parsed = readJson(stateFile) as Partial<FundingStateV1>;
    if (parsed?.version !== 1 || !parsed.topups || typeof parsed.topups !== "object") {
      return { version: 1, updatedAt: new Date().toISOString(), topups: {} };
    }
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      topups: parsed.topups as FundingStateV1["topups"]
    };
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), topups: {} };
  }
}

function shouldTopUp(
  state: FundingStateV1,
  address: string,
  nowMs: number,
  cooldownMs: number
): boolean {
  const key = normalizeHexAddress(address);
  const record = state.topups[key];
  if (!record?.lastTopupAt) return true;
  const ts = Date.parse(record.lastTopupAt);
  if (!Number.isFinite(ts)) return true;
  return nowMs - ts >= cooldownMs;
}

function rememberTopUps(
  state: FundingStateV1,
  recipients: string[],
  amountStrk: bigint,
  txHash?: string
) {
  const now = new Date().toISOString();
  for (const addr of recipients) {
    const key = normalizeHexAddress(addr);
    state.topups[key] = {
      lastTopupAt: now,
      lastTxHash: txHash,
      amountStrk: amountStrk.toString()
    };
  }
  state.updatedAt = now;
}

async function takeSnapshot(provider: RpcProvider, configFiles: string[]): Promise<ProfileSnapshot[]> {
  const out: ProfileSnapshot[] = [];
  for (const configFile of configFiles) {
    const id = path.basename(configFile, ".json");
    let sessionFile = `./data/${id}/session.json`;
    let username: string | undefined;
    try {
      const cfg = readJson(path.resolve(process.cwd(), configFile));
      if (typeof cfg?.session?.file === "string") sessionFile = cfg.session.file;
      if (typeof cfg?.session?.username === "string") username = cfg.session.username;
    } catch {
      // ignore broken config; skip it
      continue;
    }

    const sessionPath = path.resolve(process.cwd(), sessionFile);
    let address: string | undefined;
    if (fs.existsSync(sessionPath)) {
      try {
        const sess = readJson(sessionPath);
        const a = typeof sess?.address === "string" ? sess.address.trim() : "";
        if (a && a !== "controller") address = a;
      } catch {
        // ignore
      }
    }

    const snap: ProfileSnapshot = { id, configFile, sessionFile, username, address };
    if (address) {
      try {
        snap.strk = await fetchStrkBalance(provider, address);
      } catch {
        // Keep snapshot but without balance; RPC hiccups should not crash the daemon.
      }
    }
    out.push(snap);
  }
  return out;
}

function pickFunder(
  snaps: ProfileSnapshot[],
  minUnits: bigint,
  forceConfigFile?: string
): ProfileSnapshot | null {
  if (forceConfigFile) {
    const id = path.basename(forceConfigFile, ".json");
    const match = snaps.find((s) => s.id === id);
    return match ?? null;
  }
  const candidates = snaps
    .filter((s) => typeof s.strk === "bigint" && s.strk > minUnits && !!s.address)
    .sort((a, b) => {
      const av = a.strk ?? 0n;
      const bv = b.strk ?? 0n;
      if (bv > av) return 1;
      if (bv < av) return -1;
      return 0;
    });
  return candidates[0] ?? null;
}

async function fundOnce(opts: {
  thresholdStrk: bigint;
  topupAmountStrk: bigint;
  funderMinStrk: bigint;
  cooldownMs: number;
  forceFunderConfig?: string;
  dryRun: boolean;
}) {
  const stateDir = path.resolve(process.cwd(), "data", "autofund");
  const stateFile = path.join(stateDir, "state.json");
  const eventsFile = path.join(stateDir, "events.jsonl");
  const milestonesFile = path.join(stateDir, "milestones.jsonl");
  const logger = new Logger(eventsFile, milestonesFile);

  const baseCfg = loadConfig();
  const provider = new RpcProvider({ nodeUrl: baseCfg.chain.rpcReadUrl });

  const configFiles = listProfileConfigs();
  const snaps = await takeSnapshot(provider, configFiles);

  const thresholdUnits = opts.thresholdStrk * 10n ** STRK_DECIMALS;
  const funderMinUnits = opts.funderMinStrk * 10n ** STRK_DECIMALS;

  const fundingState = loadFundingState(stateFile);
  const nowMs = Date.now();

  const low = snaps
    .filter((s) => typeof s.strk === "bigint" && s.strk < thresholdUnits && !!s.address)
    .filter((s) => shouldTopUp(fundingState, s.address!, nowMs, opts.cooldownMs))
    .sort((a, b) => {
      const av = a.strk ?? 0n;
      const bv = b.strk ?? 0n;
      if (av > bv) return 1;
      if (av < bv) return -1;
      return 0;
    });

  if (low.length === 0) {
    logger.log("info", "autofund.tick", { lowCount: 0, thresholdStrk: opts.thresholdStrk.toString() });
    writeJsonPretty(stateFile, fundingState);
    return;
  }

  const funder = pickFunder(snaps, funderMinUnits, opts.forceFunderConfig);
  if (!funder || !funder.address) {
    logger.log("warn", "autofund.no_funder", {
      lowCount: low.length,
      funderMinStrk: opts.funderMinStrk.toString()
    });
    writeJsonPretty(stateFile, fundingState);
    return;
  }

  if ((funder.strk ?? 0n) <= funderMinUnits) {
    logger.log("warn", "autofund.funder_below_min", {
      funder: funder.id,
      funderStrk: typeof funder.strk === "bigint" ? formatUnits(funder.strk, STRK_DECIMALS, 4) : "unknown",
      funderMinStrk: opts.funderMinStrk.toString()
    });
    writeJsonPretty(stateFile, fundingState);
    return;
  }

  const amountUnits = opts.topupAmountStrk * 10n ** STRK_DECIMALS;
  const [lowU, highU] = uint256Calldata(amountUnits);
  const calls: StarknetCall[] = low.map((r) => ({
    contractAddress: mustAddress(normalizeStarknetAddress(STRK_TOKEN_MAINNET), "STRK token"),
    entrypoint: "transfer",
    calldata: [mustAddress(normalizeStarknetAddress(r.address!), `recipient:${r.id}`), lowU, highU]
  }));

  const total = amountUnits * BigInt(calls.length);
  const funderBal = funder.strk ?? 0n;
  if (funderBal < total + 1n) {
    logger.log("warn", "autofund.insufficient_funds", {
      funder: funder.id,
      funderStrk: formatUnits(funderBal, STRK_DECIMALS, 4),
      totalStrk: formatUnits(total, STRK_DECIMALS, 4),
      recipients: low.map((r) => ({ id: r.id, strk: r.strk ? formatUnits(r.strk, STRK_DECIMALS, 4) : "?" }))
    });
    writeJsonPretty(stateFile, fundingState);
    return;
  }

  logger.log("info", "autofund.plan", {
    funder: funder.id,
    funderAddress: normalizeHexAddress(funder.address),
    funderStrk: formatUnits(funderBal, STRK_DECIMALS, 4),
    thresholdStrk: opts.thresholdStrk.toString(),
    topupAmountStrk: opts.topupAmountStrk.toString(),
    recipients: low.map((r) => ({
      id: r.id,
      username: r.username,
      address: normalizeHexAddress(r.address!),
      strk: r.strk ? formatUnits(r.strk, STRK_DECIMALS, 4) : "?"
    }))
  });

  if (opts.dryRun) {
    logger.log("warn", "autofund.dry_run", { recipients: low.length });
    writeJsonPretty(stateFile, fundingState);
    return;
  }

  const prev = process.env.RUNNER_CONFIG;
  process.env.RUNNER_CONFIG = funder.configFile;
  const funderCfg = loadConfig();

  let funderSession: RunnerSession | null = loadSession(funderCfg);
  if (!funderSession) {
    funderSession = { address: "controller", username: funderCfg.session.username, createdAt: new Date().toISOString() };
    saveSession(funderCfg, funderSession);
  }

  const executor = new ControllerExecutor(funderCfg, logger);
  let txHash: string | undefined;
  try {
    await executor.start(funderSession, { mode: "root" });
    const tx = await executor.executeCalls("autofund_strk", calls);
    txHash = tx.transaction_hash;
    if (txHash) {
      logger.log("info", "autofund.tx_submitted", { txHash });
      await provider.waitForTransaction(txHash);
      logger.log("info", "autofund.tx_confirmed", { txHash });
    } else {
      logger.log("warn", "autofund.tx_missing_hash", {});
    }
  } finally {
    await executor.stop().catch(() => undefined);
    process.env.RUNNER_CONFIG = prev;
  }

  rememberTopUps(
    fundingState,
    low.map((r) => r.address!).filter(Boolean),
    opts.topupAmountStrk,
    txHash
  );
  writeJsonPretty(stateFile, fundingState);
}

async function main() {
  process.env.RUNNER_HEADLESS = process.env.RUNNER_HEADLESS || "1";

  const thresholdStrk = BigInt(process.env.TOPUP_THRESHOLD_STRK || "100");
  const topupAmountStrk = BigInt(process.env.TOPUP_AMOUNT_STRK || "500");
  const funderMinStrk = BigInt(process.env.FUNDER_MIN_STRK || "2000");
  const cooldownMs = Number(process.env.TOPUP_COOLDOWN_MS || String(6 * 60 * 60 * 1000));
  const intervalMs = Number(process.env.AUTOFUND_INTERVAL_MS || String(5 * 60 * 1000));
  const dryRun = (process.env.DRY_RUN || "").trim() === "1";
  const once = (process.env.ONCE || "").trim() === "1";
  const forceFunderConfig = (process.env.FUNDER_CONFIG || "").trim() || undefined;

  while (true) {
    await fundOnce({
      thresholdStrk,
      topupAmountStrk,
      funderMinStrk,
      cooldownMs,
      forceFunderConfig,
      dryRun
    }).catch((error) => {
      // Keep daemon alive; transient failures are expected on mainnet.
      // eslint-disable-next-line no-console
      console.error("autofundStrk tick failed:", String(error));
    });

    if (once) break;
    await sleep(Math.max(5_000, intervalMs));
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("autofundStrk failed:", error);
  process.exit(1);
});
