import fs from "node:fs";
import path from "node:path";
import { RunnerConfig } from "../config/schema.js";

export type RunnerSession = {
  address: string;
  username?: string;
  // Present for burner-based practice mode. Omitted for mainnet controller mode.
  privateKey?: string;
  adventurerId?: number;
  playUrl?: string;
  createdAt: string;
  rpcUrl?: string;
  chainId?: string;
  gameContract?: string;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function loadSession(config: RunnerConfig): RunnerSession | null {
  if (!config.session.reuse) return null;
  const sessionPath = path.resolve(process.cwd(), config.session.file);
  if (!fs.existsSync(sessionPath)) return null;
  try {
    const raw = fs.readFileSync(sessionPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<RunnerSession>;
    if (!isNonEmptyString(parsed?.address)) return null;
    const createdAt = isNonEmptyString(parsed?.createdAt) ? parsed.createdAt : new Date().toISOString();
    const session: RunnerSession = {
      address: parsed.address,
      username: isNonEmptyString(parsed.username) ? parsed.username : undefined,
      privateKey: isNonEmptyString(parsed.privateKey) ? parsed.privateKey : undefined,
      adventurerId: typeof parsed.adventurerId === "number" ? parsed.adventurerId : undefined,
      playUrl: isNonEmptyString(parsed.playUrl) ? parsed.playUrl : undefined,
      createdAt,
      rpcUrl: isNonEmptyString(parsed.rpcUrl) ? parsed.rpcUrl : undefined,
      chainId: isNonEmptyString(parsed.chainId) ? parsed.chainId : undefined,
      gameContract: isNonEmptyString(parsed.gameContract) ? parsed.gameContract : undefined
    };
    return session;
  } catch {
    return null;
  }
}

export function saveSession(config: RunnerConfig, session: RunnerSession) {
  const sessionPath = path.resolve(process.cwd(), config.session.file);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
}
