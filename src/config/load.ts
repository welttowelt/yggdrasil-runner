import fs from "node:fs";
import path from "node:path";
import { ConfigSchema, RunnerConfig } from "./schema.js";

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "config/default.json");

function readJson(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

export function loadConfig(): RunnerConfig {
  const configPath = process.env.RUNNER_CONFIG
    ? path.resolve(process.cwd(), process.env.RUNNER_CONFIG)
    : DEFAULT_CONFIG_PATH;

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const parsed = ConfigSchema.safeParse(readJson(configPath));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid config: ${issues}`);
  }

  const config = parsed.data;
  const dataDir = path.resolve(process.cwd(), config.app.dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  return config;
}
