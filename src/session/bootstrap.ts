import { RunnerConfig } from "../config/schema.js";
import { Logger } from "../utils/logger.js";
import { PlaywrightClient } from "../ui/playwrightClient.js";
import { sleep } from "../utils/time.js";
import { BurnerSession, loadSession, saveSession } from "./session.js";

function parseAdventurerId(url: string): number | null {
  try {
    const u = new URL(url);
    const id = u.searchParams.get("id");
    if (!id) return null;
    const n = Number(id);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function waitForPlayPage(client: PlaywrightClient, timeoutMs: number): Promise<import("playwright").Page | null> {
  const page = client.getPage();
  const context = page.context();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pages = context.pages();
    for (const p of pages) {
      const url = p.url();
      if (url.includes("/play") && url.includes("id=")) return p;
    }
    await sleep(500);
  }
  return null;
}

async function attemptCartridgeLogin(client: PlaywrightClient, config: RunnerConfig, logger: Logger) {
  if (!config.session.autoLogin) return false;
  const page = client.getPage();
  const frameLocator = page.frameLocator("iframe#controller-keychain");
  const input = frameLocator.locator("input").first();
  const loginButton = frameLocator.locator("[data-testid='submit-button'], text=log in").first();

  const inputVisible = await input.isVisible().catch(() => false);
  if (!inputVisible) return false;

  const username = config.session.username?.trim()
    ? config.session.username.trim()
    : `${config.session.usernamePrefix}-${Date.now().toString(36).slice(-6)}`;

  logger.log("info", "session.login", { username });
  await input.fill(username);
  await loginButton.click().catch(() => undefined);
  await sleep(2000);
  return true;
}

async function logOpenPages(client: PlaywrightClient, logger: Logger) {
  const page = client.getPage();
  const context = page.context();
  const urls = context.pages().map((p) => p.url());
  logger.log("warn", "session.pages", { urls });
}

export async function ensureSession(config: RunnerConfig, logger: Logger): Promise<BurnerSession> {
  const existing = loadSession(config);
  if (existing) {
    logger.log("info", "session.reuse", { adventurerId: existing.adventurerId });
    return existing;
  }

  const client = new PlaywrightClient(config, logger);
  await client.start();

  try {
    const page = client.getPage();
    const practiceButton = page.getByText("PRACTICE FOR FREE", { exact: false });
    if (await practiceButton.isVisible().catch(() => false)) {
      await practiceButton.click();
    }

    await sleep(1500);
    for (let i = 0; i < 10; i += 1) {
      const didLogin = await attemptCartridgeLogin(client, config, logger);
      if (didLogin) break;
      await sleep(1000);
    }

    const playPage = await waitForPlayPage(client, 25000);
    if (!playPage) {
      await logOpenPages(client, logger);
      throw new Error("Failed to enter practice play URL");
    }
    await playPage.waitForLoadState("domcontentloaded").catch(() => undefined);

    const playUrl = playPage.url();
    const adventurerId = parseAdventurerId(playUrl);
    if (!adventurerId) {
      throw new Error(`Unable to parse adventurer id from URL: ${playUrl}`);
    }

    const burnerRaw = await playPage.evaluate(() => localStorage.getItem("burner"));
    if (!burnerRaw) {
      throw new Error("Missing burner session in localStorage");
    }
    const burner = JSON.parse(burnerRaw) as { address: string; privateKey: string };
    if (!burner.address || !burner.privateKey) {
      throw new Error("Invalid burner session data");
    }

    const session: BurnerSession = {
      address: burner.address,
      privateKey: burner.privateKey,
      adventurerId,
      playUrl,
      createdAt: new Date().toISOString()
    };

    saveSession(config, session);
    logger.log("info", "session.saved", { adventurerId, playUrl });
    return session;
  } finally {
    await client.stop();
  }
}
