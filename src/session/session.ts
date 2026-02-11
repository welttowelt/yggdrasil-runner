import fs from "node:fs";
import path from "node:path";
import { RunnerConfig } from "../config/schema.js";

export type BurnerSession = {
  address: string;
  privateKey: string;
  adventurerId: number;
  playUrl: string;
  createdAt: string;
};

export function loadSession(config: RunnerConfig): BurnerSession | null {
  if (!config.session.reuse) return null;
  const sessionPath = path.resolve(process.cwd(), config.session.file);
  if (!fs.existsSync(sessionPath)) return null;
  try {
    const raw = fs.readFileSync(sessionPath, "utf8");
    const parsed = JSON.parse(raw) as BurnerSession;
    if (!parsed?.address || !parsed?.privateKey || !parsed?.adventurerId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(config: RunnerConfig, session: BurnerSession) {
  const sessionPath = path.resolve(process.cwd(), config.session.file);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
}
