import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config/load.js";
import { Logger } from "./utils/logger.js";
import { PlaywrightClient } from "./ui/playwrightClient.js";
import { sleep } from "./utils/time.js";

async function main() {
  const config = loadConfig();
  const eventsFile = path.resolve(process.cwd(), config.logging.eventsFile);
  const milestonesFile = path.resolve(process.cwd(), config.logging.milestonesFile);
  const logger = new Logger(eventsFile, milestonesFile);

  const ui = new PlaywrightClient(config, logger);
  await ui.start();
  logger.log("info", "probe.start", { url: config.app.url });

  const page = ui.getPage();
  const networkLog: any[] = [];
  const responseLog: any[] = [];
  const wsLog: any[] = [];

  page.on("request", (req) => {
    const url = req.url();
    const entry: any = {
      type: "request",
      url,
      method: req.method(),
      resourceType: req.resourceType()
    };
    if (req.method() !== "GET") {
      try {
        entry.postData = req.postData()?.slice(0, 2000);
      } catch {
        // ignore
      }
    }
    if (url.includes("cartridge") || url.includes("torii") || url.includes("starknet")) {
      networkLog.push(entry);
    }
  });

  page.on("response", async (res) => {
    const headers = res.headers();
    const contentType = headers["content-type"] || "";
    if (!contentType.includes("application/json") && !contentType.includes("text/plain")) return;
    try {
      const body = await res.text();
      const snippet = body.slice(0, 2000);
      responseLog.push({
        url: res.url(),
        status: res.status(),
        contentType,
        snippet
      });
    } catch {
      // ignore
    }
  });

  page.on("websocket", (ws) => {
    ws.on("framereceived", (frame) => {
      const payload = typeof frame.payload === "string" ? frame.payload.slice(0, 1000) : "<binary>";
      wsLog.push({ type: "recv", url: ws.url(), payload });
    });
    ws.on("framesent", (frame) => {
      const payload = typeof frame.payload === "string" ? frame.payload.slice(0, 1000) : "<binary>";
      wsLog.push({ type: "sent", url: ws.url(), payload });
    });
  });

  await sleep(5000);

  const probes: any[] = [];
  const menuReport = await ui.probeUi();
  probes.push({ phase: "menu", report: menuReport });

  const practiceButton = page.getByText("PRACTICE FOR FREE", { exact: false });
  if (await practiceButton.isVisible().catch(() => false)) {
    logger.log("info", "probe.click_practice", {});
    await practiceButton.click();
    await sleep(5000);
  }

  const exploreButton = page.getByText("Explore", { exact: false });
  if (await exploreButton.isVisible().catch(() => false)) {
    logger.log("info", "probe.in_game_detected", {});
  }

  const gameReport = await ui.probeUi();
  probes.push({ phase: "in_game", report: gameReport });

  const enhancedReport = {
    probes,
    networkLog,
    responseLog,
    wsLog
  };
  const outputPath = path.resolve(process.cwd(), "data/probe.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(enhancedReport, null, 2));
  logger.log("info", "probe.saved", { outputPath });

  await ui.screenshot("probe");
  await ui.stop();
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Probe failed", error);
  process.exit(1);
});
