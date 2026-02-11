import path from "node:path";
import { loadConfig } from "./config/load.js";
import { Logger } from "./utils/logger.js";
import { ChainRunner } from "./runner/chainRunner.js";

async function main() {
  const config = loadConfig();
  const eventsFile = path.resolve(process.cwd(), config.logging.eventsFile);
  const milestonesFile = path.resolve(process.cwd(), config.logging.milestonesFile);
  const logger = new Logger(eventsFile, milestonesFile);

  const runner = new ChainRunner(config, logger);

  process.on("SIGINT", async () => {
    logger.log("info", "runner.stop", { signal: "SIGINT" });
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    logger.log("info", "runner.stop", { signal: "SIGTERM" });
    process.exit(0);
  });

  await runner.start();
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error", error);
  process.exit(1);
});
