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

  constructor(eventsFile: string, milestonesFile: string) {
    this.eventsFile = eventsFile;
    this.milestonesFile = milestonesFile;
    ensureDir(this.eventsFile);
    ensureDir(this.milestonesFile);
  }

  log(level: LogLevel, event: string, data: Record<string, unknown> = {}) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      event,
      ...data
    };
    fs.appendFileSync(this.eventsFile, JSON.stringify(entry) + "\n");
    const label = level.toUpperCase();
    console.log(`${label} ${event}`, data);
  }

  milestone(name: string, data: Record<string, unknown> = {}) {
    const entry = {
      ts: new Date().toISOString(),
      milestone: name,
      ...data
    };
    fs.appendFileSync(this.milestonesFile, JSON.stringify(entry) + "\n");
    console.log(`MILESTONE ${name}`, data);
  }
}
