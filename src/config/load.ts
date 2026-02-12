import fs from "node:fs";
import path from "node:path";
import { ConfigSchema, RunnerConfig } from "./schema.js";

const DEFAULT_CONFIG_PATH = path.resolve(process.cwd(), "config/default.json");
const LOCAL_CONFIG_PATH = path.resolve(process.cwd(), "config/local.json");

function readJson(filePath: string): unknown {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override ?? base;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function loadConfig(): RunnerConfig {
  const configPath = process.env.RUNNER_CONFIG
    ? path.resolve(process.cwd(), process.env.RUNNER_CONFIG)
    : DEFAULT_CONFIG_PATH;

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const base = readJson(configPath);
  const merged =
    configPath !== LOCAL_CONFIG_PATH && fs.existsSync(LOCAL_CONFIG_PATH)
      ? deepMerge(base, readJson(LOCAL_CONFIG_PATH))
      : base;
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid config: ${issues}`);
  }

  const config = parsed.data;
  // Prefer environment variables for sensitive fields so they don't need to live in git-tracked config.
  const envUsername = process.env.LS2_USERNAME ?? process.env.RUNNER_USERNAME;
  const envPassword = process.env.LS2_PASSWORD ?? process.env.RUNNER_PASSWORD;
  const envControllerAddress = process.env.LS2_CONTROLLER_ADDRESS ?? process.env.RUNNER_CONTROLLER_ADDRESS;
  if (envUsername) config.session.username = envUsername;
  if (envPassword) config.session.password = envPassword;
  if (envControllerAddress) config.session.controllerAddress = envControllerAddress;

  const dataDir = path.resolve(process.cwd(), config.app.dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  return config;
}
