import fs from "node:fs";
import path from "node:path";

import { RpcProvider } from "starknet";

import { loadConfig } from "../config/load.js";
import { ControllerExecutor } from "../chain/controllerExecutor.js";
import { Logger } from "../utils/logger.js";
import { loadSession, saveSession, type RunnerSession } from "../session/session.js";
import { normalizeStarknetAddress } from "../utils/starknet.js";
import type { StarknetCall } from "../chain/vrf.js";

const STRK_TOKEN_MAINNET = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const STRK_DECIMALS = 18n;

type NewProfile = { id: string; username: string };

function mustAddress(value: string | null, label: string): string {
  if (!value) throw new Error(`Invalid address for ${label}`);
  return value;
}

function slugId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 32);
}

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

function makeNewProfiles(count: number): NewProfile[] {
  // Human-style names only: no digits, no obvious "bot suffixes".
  // We rely on a large enough combination space to avoid collisions; if a candidate is taken, the
  // provisioning flow should be re-run with a different batch.
  const firstNames = [
    "Ellen",
    "Rick",
    "Sarah",
    "Dana",
    "Cooper",
    "Clarice",
    "Malcolm",
    "Trinity",
    "Morpheus",
    "Neo",
    "Leia",
    "Ripley",
    "Deckard",
    "Furiosa",
    "Max",
    "Logan",
    "Kaylee",
    "Simon",
    "River",
    "Inara"
  ];

  const lastNames = [
    "Carter",
    "Hayes",
    "Mercer",
    "Reed",
    "Walsh",
    "Miller",
    "Stone",
    "Bishop",
    "Holloway",
    "Nolan",
    "Vance",
    "Monroe",
    "Wright",
    "Sutton",
    "Harris",
    "Rowan",
    "Graham",
    "Parker",
    "Bennett",
    "Kane"
  ];

  const out: NewProfile[] = [];
  const used = new Set<string>();
  let attempts = 0;
  while (out.length < count && attempts < 2500) {
    attempts += 1;
    const first = firstNames[Math.floor(Math.random() * firstNames.length)]!;
    const last = lastNames[Math.floor(Math.random() * lastNames.length)]!;
    const username = `${first}${last}`;
    if (/\d/.test(username)) continue;
    const key = username.toLowerCase();
    if (used.has(key)) continue;
    used.add(key);
    out.push({ id: slugId(username), username });
  }

  if (out.length < count) {
    throw new Error(`Failed to generate ${count} unique human-style usernames (generated ${out.length}).`);
  }

  return out;
}

function ensureProfileConfig(profile: NewProfile) {
  const configPath = path.resolve(process.cwd(), "config", `${profile.id}.json`);
  if (fs.existsSync(configPath)) return;

  const template = readJson(path.resolve(process.cwd(), "config", "default.json"));
  template.app = { ...(template.app ?? {}), dataDir: `./data/${profile.id}` };
  template.chain = {
    ...(template.chain ?? {}),
    abiCacheFile: `./data/${profile.id}/game_abi.json`,
    lootAbiCacheFile: `./data/${profile.id}/loot_abi.json`
  };
  template.session = {
    ...(template.session ?? {}),
    file: `./data/${profile.id}/session.json`,
    username: profile.username,
    controllerAddress: ""
  };
  template.logging = {
    ...(template.logging ?? {}),
    eventsFile: `./data/${profile.id}/events.jsonl`,
    milestonesFile: `./data/${profile.id}/milestones.jsonl`
  };

  writeJsonPretty(configPath, template);
}

function buildLogger(config: ReturnType<typeof loadConfig>) {
  const eventsFile = path.resolve(process.cwd(), config.logging.eventsFile);
  const milestonesFile = path.resolve(process.cwd(), config.logging.milestonesFile);
  return new Logger(eventsFile, milestonesFile);
}

async function ensureControllerAddress(configFile: string): Promise<string> {
  const prev = process.env.RUNNER_CONFIG;
  process.env.RUNNER_CONFIG = configFile;
  const config = loadConfig();
  const logger = buildLogger(config);

  let session: RunnerSession | null = loadSession(config);
  if (!session) {
    session = { address: "controller", username: config.session.username, createdAt: new Date().toISOString() };
    saveSession(config, session);
  }

  const executor = new ControllerExecutor(config, logger);
  try {
    await executor.start(session, { mode: "root" });
  } finally {
    await executor.stop().catch(() => undefined);
    process.env.RUNNER_CONFIG = prev;
  }

  const refreshed = loadSession(config);
  const addr = refreshed?.address?.trim() || "";
  if (!addr || addr === "controller") {
    throw new Error(`Failed to resolve controller address for ${config.session.username || configFile}`);
  }
  return addr;
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

async function fundProfiles(opts: {
  funderConfigFile: string;
  recipients: Array<{ username: string; address: string }>;
  amountStrk: bigint;
}) {
  const prev = process.env.RUNNER_CONFIG;
  process.env.RUNNER_CONFIG = opts.funderConfigFile;
  const config = loadConfig();
  const logger = buildLogger(config);

  let session: RunnerSession | null = loadSession(config);
  if (!session) {
    session = { address: "controller", username: config.session.username, createdAt: new Date().toISOString() };
    saveSession(config, session);
  }

  const provider = new RpcProvider({ nodeUrl: config.chain.rpcReadUrl });
  const funderAddr = mustAddress(normalizeStarknetAddress(session.address), "funder");
  const funderBal = await fetchStrkBalance(provider, funderAddr);
  logger.log("info", "funding.funder_balance", {
    address: funderAddr,
    strk: formatUnits(funderBal, STRK_DECIMALS, 4)
  });

  const amountUnits = opts.amountStrk * 10n ** STRK_DECIMALS;
  const [low, high] = uint256Calldata(amountUnits);

  const calls: StarknetCall[] = opts.recipients.map((r) => ({
    contractAddress: mustAddress(normalizeStarknetAddress(STRK_TOKEN_MAINNET), "STRK token"),
    entrypoint: "transfer",
    calldata: [mustAddress(normalizeStarknetAddress(r.address), `recipient:${r.username}`), low, high]
  }));

  const total = amountUnits * BigInt(opts.recipients.length);
  if (funderBal < total + 1n) {
    throw new Error(
      `Insufficient STRK: need ${formatUnits(total, STRK_DECIMALS)} but funder has ${formatUnits(funderBal, STRK_DECIMALS)}`
    );
  }

  const executor = new ControllerExecutor(config, logger);
  try {
    await executor.start(session, { mode: "root" });
    const tx = await executor.executeCalls("fund_strk", calls);
    if (tx.transaction_hash) {
      logger.log("info", "funding.tx_submitted", { txHash: tx.transaction_hash });
      await provider.waitForTransaction(tx.transaction_hash);
      logger.log("info", "funding.tx_confirmed", { txHash: tx.transaction_hash });
    } else {
      logger.log("warn", "funding.tx_missing_hash", {});
    }
  } finally {
    await executor.stop().catch(() => undefined);
    process.env.RUNNER_CONFIG = prev;
  }

  for (const r of opts.recipients) {
    const bal = await fetchStrkBalance(provider, r.address);
    logger.log("info", "funding.recipient_balance", {
      username: r.username,
      address: normalizeStarknetAddress(r.address),
      strk: formatUnits(bal, STRK_DECIMALS, 4)
    });
  }
}

async function main() {
  // Keep provisioning headless by default.
  process.env.RUNNER_HEADLESS = process.env.RUNNER_HEADLESS || "1";

  const count = Number(process.env.NEW_ACCOUNTS || "5");
  const amountStrk = BigInt(process.env.FUND_AMOUNT_STRK || "300");
  const funderConfigFile = process.env.FUNDER_CONFIG || "config/autopsy.json";

  const explicitIdsRaw = (process.env.PROFILE_IDS || "").trim();
  const profiles: NewProfile[] = explicitIdsRaw
    ? explicitIdsRaw
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
        .map((id) => {
          const cfgPath = path.resolve(process.cwd(), "config", `${id}.json`);
          const parsed = fs.existsSync(cfgPath) ? readJson(cfgPath) : null;
          const username = String(parsed?.session?.username || id);
          return { id, username };
        })
    : makeNewProfiles(count);

  if (!explicitIdsRaw) {
    for (const p of profiles) {
      ensureProfileConfig(p);
    }
  }

  const recipients: Array<{ id: string; username: string; address: string }> = [];
  for (const p of profiles) {
    const cfgFile = `config/${p.id}.json`;
    const address = await ensureControllerAddress(cfgFile);
    recipients.push({ id: p.id, username: p.username, address });
  }

  await fundProfiles({
    funderConfigFile,
    recipients: recipients.map((r) => ({ username: r.username, address: r.address })),
    amountStrk
  });

  // Emit a minimal summary to stdout.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ funded: recipients }, null, 2));
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("provisionFundedProfiles failed:", error);
  process.exit(1);
});
