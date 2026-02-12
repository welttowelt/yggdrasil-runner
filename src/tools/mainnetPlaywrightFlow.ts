import { BrowserContext, chromium, FrameLocator, Locator, Page } from "playwright";
import { sleep } from "../utils/time.js";

type FlowConfig = {
  url: string;
  username: string;
  password: string;
  headless: boolean;
  slowMoMs: number;
  timeoutMs: number;
  stallReloadMs: number;
};

function envInt(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name: string, fallback: boolean) {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

function log(event: string, meta: Record<string, unknown> = {}) {
  const ts = new Date().toISOString();
  process.stdout.write(`${ts} ${event} ${JSON.stringify(meta)}\n`);
}

function isMainnetPlayUrl(url: string) {
  return url.includes("/survivor/play?id=") && !url.includes("mode=practice");
}

async function clickLocatorWhenEnabled(
  locator: Locator,
  label: string,
  attempts = 4,
  delayMs = 200
) {
  for (let i = 0; i < attempts; i += 1) {
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) {
      await sleep(delayMs);
      continue;
    }
    const enabled = await locator.isEnabled().catch(() => false);
    if (!enabled) {
      await sleep(delayMs);
      continue;
    }
    log("click", { label });
    const clicked = await locator.click().then(() => true).catch(() => false);
    if (clicked) return true;
  }
  return false;
}

async function clickIfVisible(locator: Locator, label: string) {
  const visible = await locator.isVisible().catch(() => false);
  if (!visible) return false;
  log("click", { label });
  const clicked = await locator.click().then(() => true).catch(() => false);
  return clicked;
}

async function clickVisibleSuggestion(
  locator: Locator,
  inputBox: { x: number; y: number; width: number; height: number } | null
) {
  const count = Math.min(await locator.count().catch(() => 0), 8);
  for (let i = 0; i < count; i += 1) {
    const candidate = locator.nth(i);
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;
    const box = await candidate.boundingBox().catch(() => null);
    if (inputBox && box && box.y + box.height / 2 <= inputBox.y + inputBox.height + 2) {
      continue;
    }
    const enabled = await candidate.isEnabled().catch(() => true);
    if (!enabled) continue;
    const clicked = await candidate.click().then(() => true).catch(() => false);
    if (clicked) return true;
  }
  return false;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function clickMatchingUsernameSuggestion(
  frame: FrameLocator,
  usernameInput: Locator,
  username: string
) {
  const exact = new RegExp(`^\\s*${escapeRegex(username)}\\s*$`, "i");
  const fuzzy = new RegExp(escapeRegex(username), "i");

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const inputBox = await usernameInput.boundingBox().catch(() => null);
    const candidates: Locator[] = [
      frame.locator("[role='option']").filter({ hasText: exact }),
      frame.locator("[role='option']").filter({ hasText: fuzzy }),
      frame.locator("button").filter({ hasText: exact }),
      frame.locator("div").filter({ hasText: exact }),
      frame.getByText(exact)
    ];

    for (const locator of candidates) {
      const clicked = await clickVisibleSuggestion(locator, inputBox);
      if (!clicked) continue;
      log("click", { label: "login_user_suggestion" });
      await sleep(250);
      return true;
    }

    await sleep(220);
  }

  return false;
}

async function tryLogin(page: Page, config: FlowConfig) {
  if (!config.username || !config.password) return false;

  await page.evaluate(() => {
    const sc = (window as any).starknet_controller;
    if (!sc?.connect) return;
    sc.connect().catch(() => undefined);
  }).catch(() => undefined);
  await sleep(250);

  const frame = page.frameLocator("iframe#controller-keychain");
  const usernameInput = frame.locator("input[type='text'], input[type='email'], input:not([type])").first();
  const passwordInput = frame.locator("input[type='password']").first();
  const loginWithPassword = frame
    .locator("button[data-testid='submit-button']")
    .filter({ hasText: /log in with password/i })
    .first();
  const primaryLogin = frame.locator("button#primary-button").filter({ hasText: /^login$/i }).first();
  const loginSubmit = frame
    .locator("button[data-testid='submit-button']")
    .filter({ hasText: /^log in$/i })
    .first();
  const anySubmit = frame.locator("button[data-testid='submit-button']").first();

  const fillPasswordAndSubmit = async () => {
    const pwVisible = await passwordInput.isVisible().catch(() => false);
    if (!pwVisible) return false;
    await passwordInput.fill(config.password).catch(() => undefined);
    const primaryClicked = await clickLocatorWhenEnabled(primaryLogin, "login_submit_primary", 8, 180);
    if (primaryClicked) {
      await sleep(1000);
      return true;
    }
    const submitVisible = await loginSubmit.isVisible().catch(() => false);
    const submitTarget = submitVisible ? loginSubmit : anySubmit;
    const clicked = await clickLocatorWhenEnabled(submitTarget, "login_submit", 8, 180);
    if (!clicked) return false;
    await sleep(1000);
    return true;
  };

  if (await fillPasswordAndSubmit()) {
    log("login_password_submitted", { mode: "direct_password_field" });
    return true;
  }

  const userVisible = await usernameInput.isVisible().catch(() => false);
  if (!userVisible) return false;

  await usernameInput.fill("").catch(() => undefined);
  await usernameInput.type(config.username.toLowerCase(), { delay: 35 }).catch(() => undefined);
  await sleep(420);

  const pickedUser = await clickMatchingUsernameSuggestion(frame, usernameInput, config.username);
  if (!pickedUser) {
    log("login_user_suggestion_not_found");
    return false;
  }

  await clickLocatorWhenEnabled(loginWithPassword, "login_with_password", 24, 250);

  for (let i = 0; i < 6; i += 1) {
    if (await fillPasswordAndSubmit()) {
      log("login_password_submitted", { mode: "after_login_with_password" });
      return true;
    }
    await clickLocatorWhenEnabled(loginWithPassword, "login_with_password", 24, 250);
    await sleep(350);
  }

  return false;
}

async function tryAcceptTerms(page: Page) {
  const acceptButton = page.locator("button").filter({ hasText: /accept\s*&\s*continue/i }).first();
  const acceptVisible = await acceptButton.isVisible().catch(() => false);
  if (!acceptVisible) return false;

  const checkboxes = page.locator("input[type='checkbox']");
  const count = await checkboxes.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const checkbox = checkboxes.nth(i);
    const visible = await checkbox.isVisible().catch(() => false);
    if (!visible) continue;
    const isChecked = await checkbox.isChecked().catch(() => false);
    if (!isChecked) {
      await checkbox.click({ force: true }).catch(() => undefined);
      log("click", { label: "terms_checkbox" });
      await sleep(180);
    }
    break;
  }

  const accepted = await clickLocatorWhenEnabled(acceptButton, "accept_continue", 6, 180);
  if (accepted) {
    await sleep(500);
  }
  return accepted;
}

async function tryEnterDungeon(page: Page) {
  const enterDungeonLabel = page.getByText(/^\s*Enter Dungeon\s*$/i).first();
  const visible = await enterDungeonLabel.isVisible().catch(() => false);
  if (!visible) return false;

  const clickableAncestor = enterDungeonLabel
    .locator("xpath=ancestor-or-self::*[self::button or self::a or @role='button'][1]")
    .first();
  const ancestorClicked = await clickLocatorWhenEnabled(clickableAncestor, "enter_dungeon", 4, 150);
  if (ancestorClicked) {
    await sleep(350);
    return true;
  }

  log("click", { label: "enter_dungeon" });
  await enterDungeonLabel.click({ force: true }).catch(() => undefined);
  await sleep(350);
  return true;
}

async function trySubmitOnPage(page: Page) {
  const submit = page.locator("button, [role='button'], a").filter({ hasText: /^\s*submit\s*$/i }).first();
  return clickLocatorWhenEnabled(submit, "submit", 5, 180);
}

async function trySubmitExecutePages(context: BrowserContext) {
  const pages = context.pages().filter((page) => !page.isClosed() && page.url().includes("x.cartridge.gg/execute"));
  if (pages.length === 0) return false;

  let clicked = false;
  for (const page of pages) {
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    const didClick = await trySubmitOnPage(page);
    if (didClick) clicked = true;
  }
  return clicked;
}

async function refreshOnKnownError(page: Page) {
  const alreadyStarted = page.getByText(/already started/i).first();
  if (await alreadyStarted.isVisible().catch(() => false)) {
    log("refresh", { reason: "already_started" });
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    return true;
  }

  const notInBattle = page.getByText(/not in battle/i).first();
  if (await notInBattle.isVisible().catch(() => false)) {
    log("refresh", { reason: "not_in_battle" });
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    return true;
  }

  return false;
}

async function main() {
  const config: FlowConfig = {
    url: process.env.LS2_URL || "https://lootsurvivor.io/survivor",
    username: process.env.LS2_USERNAME || "",
    password: process.env.LS2_PASSWORD || "",
    headless: envBool("RUNNER_HEADLESS", false),
    slowMoMs: envInt("RUNNER_SLOWMO_MS", 0),
    timeoutMs: envInt("FLOW_TIMEOUT_MS", 20 * 60 * 1000),
    stallReloadMs: envInt("FLOW_STALL_RELOAD_MS", 45000)
  };

  const browser = await chromium.launch({ headless: config.headless, slowMo: config.slowMoMs });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(30000);

  page.on("dialog", async (dialog) => {
    log("dialog", { message: dialog.message() });
    await dialog.dismiss().catch(() => undefined);
  });

  try {
    await page.goto(config.url, { waitUntil: "domcontentloaded" });
    const deadline = Date.now() + config.timeoutMs;
    let lastProgressAt = Date.now();

    const buyGameButton = page.locator("button, [role='button'], a").filter({ hasText: /^\s*BUY GAME\s*$/i }).first();
    const loginButton = page.locator("button, [role='button'], a").filter({ hasText: /^\s*LOG IN\s*$/i }).first();
    const continueButton = page
      .locator("button, [role='button'], a")
      .filter({ hasText: /^\s*CONTINUE\s*$/i })
      .first();
    const playButton = page.locator("button, [role='button'], a").filter({ hasText: /^\s*PLAY\s*$/i }).first();

    while (Date.now() < deadline) {
      const livePlay = context.pages().find((p) => !p.isClosed() && isMainnetPlayUrl(p.url()));
      if (livePlay) {
        log("mainnet_play_ready", { url: livePlay.url() });
        return;
      }

      let progressed = false;
      if (await trySubmitExecutePages(context)) progressed = true;
      if (await refreshOnKnownError(page)) progressed = true;
      if (await clickIfVisible(buyGameButton, "buy_game")) progressed = true;
      if (await clickIfVisible(loginButton, "login")) progressed = true;
      if (await tryLogin(page, config)) progressed = true;
      if (await tryAcceptTerms(page)) progressed = true;
      if (await tryEnterDungeon(page)) progressed = true;
      if (await trySubmitOnPage(page)) progressed = true;
      if (await clickIfVisible(continueButton, "continue")) progressed = true;
      if (await clickIfVisible(playButton, "play")) progressed = true;

      if (progressed) {
        lastProgressAt = Date.now();
      } else if (Date.now() - lastProgressAt > config.stallReloadMs) {
        log("refresh", { reason: "stall_timeout", stallMs: config.stallReloadMs });
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
        lastProgressAt = Date.now();
      }

      await sleep(700);
    }

    throw new Error(`Timed out after ${config.timeoutMs}ms without reaching mainnet play page`);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  log("fatal", { error: message });
  process.exitCode = 1;
});
