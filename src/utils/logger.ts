import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

export class Logger {
  private eventsFile: string;
  private milestonesFile: string;
  private reservedKeys = new Set(["ts", "level", "event", "milestone"]);

  constructor(eventsFile: string, milestonesFile: string) {
    this.eventsFile = eventsFile;
    this.milestonesFile = milestonesFile;
    ensureDir(this.eventsFile);
    ensureDir(this.milestonesFile);
  }

  log(level: LogLevel, event: string, data: Record<string, unknown> = {}) {
    const safeData = this.sanitizePayload(data);
    const entry = {
      ts: new Date().toISOString(),
      level,
      event,
      ...safeData
    };
    fs.appendFileSync(this.eventsFile, JSON.stringify(entry) + "\n");
    const label = level.toUpperCase();
    console.log(`${label} ${event}`, safeData);
  }

  milestone(name: string, data: Record<string, unknown> = {}) {
    const safeData = this.sanitizePayload(data);
    const entry = {
      ts: new Date().toISOString(),
      milestone: name,
      ...safeData
    };
    fs.appendFileSync(this.milestonesFile, JSON.stringify(entry) + "\n");
    console.log(`MILESTONE ${name}`, safeData);
  }

  private sanitizePayload(data: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (this.reservedKeys.has(key)) {
        out[`data_${key}`] = value;
      } else {
        out[key] = value;
      }
    }
    return out;
  }
}
