import { Browser, BrowserContext, FrameLocator, Locator, Page, chromium } from "playwright";
import { RunnerConfig } from "../config/schema.js";
import { BurnerSession } from "../session/session.js";
import { Logger } from "../utils/logger.js";
import { sleep } from "../utils/time.js";

type ExecuteResult = {
  ok: boolean;
  txHash?: string | null;
  error?: {
    text?: string;
    code?: number | string;
    message?: string;
    json?: string;
  };
};

function isPlayUrl(url: string) {
  return url.includes("/survivor/play?id=");
}

function isMainnetPlayUrl(url: string) {
  return isPlayUrl(url) && !url.includes("mode=practice");
}

export class ControllerExecutor {
  private config: RunnerConfig;
  private logger: Logger;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private rootPage: Page | null = null;
  private playPage: Page | null = null;
  private session: BurnerSession | null = null;
  private gameContract: string;

  constructor(config: RunnerConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.gameContract = config.chain.gameContract;
  }

  async start(session: BurnerSession) {
    this.session = session;
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: this.config.app.headless || !!process.env.RUNNER_HEADLESS,
        slowMo: this.config.app.slowMoMs
      });
      this.context = await this.browser.newContext();
      this.rootPage = await this.context.newPage();
      this.rootPage.setDefaultTimeout(this.config.app.timeoutMs);
      this.rootPage.setDefaultNavigationTimeout(this.config.app.navigationTimeoutMs);
      this.rootPage.on("dialog", async (dialog) => {
        this.logger.log("warn", "controller.dialog", { message: dialog.message() });
        await dialog.dismiss().catch(() => undefined);
      });
      this.context.on("page", (page) => {
        page.on("dialog", async (dialog) => {
          this.logger.log("warn", "controller.dialog", { message: dialog.message() });
          await dialog.dismiss().catch(() => undefined);
        });
      });
    }

    if (!this.rootPage || this.rootPage.isClosed()) {
      this.rootPage = await this.context!.newPage();
      this.rootPage.setDefaultTimeout(this.config.app.timeoutMs);
      this.rootPage.setDefaultNavigationTimeout(this.config.app.navigationTimeoutMs);
    }

    if (!this.rootPage.url().includes("/survivor")) {
      await this.rootPage.goto(this.config.app.url, { waitUntil: "domcontentloaded" });
    }
    await this.ensureMainnetPlay();
  }

  async stop() {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.context = null;
    this.rootPage = null;
    this.playPage = null;
    this.session = null;
  }

  async startGame(adventurerId: number, weaponId: number) {
    return this.execute("start_game", [adventurerId, weaponId]);
  }

  async explore(adventurerId: number, tillBeast: boolean) {
    return this.execute("explore", [adventurerId, tillBeast]);
  }

  async attack(adventurerId: number, toTheDeath: boolean) {
    return this.execute("attack", [adventurerId, toTheDeath]);
  }

  async flee(adventurerId: number, toTheDeath: boolean) {
    return this.execute("flee", [adventurerId, toTheDeath]);
  }

  async buyItems(adventurerId: number, potions: number, items: Array<{ item_id: number; equip: boolean }>) {
    return this.execute("buy_items", [adventurerId, potions, items]);
  }

  async equip(adventurerId: number, items: number[]) {
    return this.execute("equip", [adventurerId, items]);
  }

  async selectStatUpgrades(adventurerId: number, stats: Record<string, number>) {
    return this.execute("select_stat_upgrades", [adventurerId, stats]);
  }

  private async execute(entrypoint: string, calldata: any[]): Promise<{ transaction_hash?: string }> {
    const retries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        const page = await this.ensureMainnetPlay();
        const result = await this.executeOnPage(page, entrypoint, calldata);
        if (result.ok) {
          return { transaction_hash: result.txHash || undefined };
        }

        const text = `${result.error?.message || ""} ${result.error?.text || ""} ${result.error?.json || ""}`;
        const needsReconnect =
          text.includes("NOT_CONNECTED") ||
          text.includes("no_controller") ||
          text.includes("page_closed");
        if (needsReconnect && attempt < retries) {
          this.logger.log("warn", "controller.reconnect", { entrypoint, attempt });
          await this.ensureMainnetPlay(true);
          continue;
        }

        throw new Error(`Controller execute failed (${entrypoint}): ${text || "unknown error"}`);
      } catch (error) {
        lastError = error as Error;
        this.logger.log("warn", "controller.execute_error", {
          entrypoint,
          attempt,
          error: String(error)
        });
        if (attempt < retries) {
          await sleep(1000);
          await this.ensureMainnetPlay(true);
          continue;
        }
      }
    }

    throw lastError ?? new Error(`Controller execute failed (${entrypoint})`);
  }

  private async executeOnPage(page: Page, entrypoint: string, calldata: any[]): Promise<ExecuteResult> {
    const script = `
      (async function () {
        var sc = (window && window.starknet_controller) || null;
        if (!sc) {
          return { ok: false, error: { text: "no_controller" } };
        }
        try {
          var account = sc.account || (await sc.connect());
          var tx = await account.execute([{
            contractAddress: ${JSON.stringify(this.gameContract)},
            entrypoint: ${JSON.stringify(entrypoint)},
            calldata: ${JSON.stringify(calldata)}
          }]);
          var txHash = (tx && (tx.transaction_hash || tx.transactionHash)) || null;
          return { ok: true, txHash: txHash };
        } catch (error) {
          var out = { text: String(error) };
          try { out.code = error && error.code; } catch (e) {}
          try { out.message = error && error.message; } catch (e) {}
          try { out.json = JSON.stringify(error); } catch (e) {}
          return { ok: false, error: out };
        }
      })()
    `;

    return page.evaluate(function (rawScript) {
      return (0, eval)(rawScript);
    }, script);
  }

  private async ensureMainnetPlay(forceReopen = false): Promise<Page> {
    if (!this.context || !this.rootPage || !this.session) {
      throw new Error("Controller executor is not started");
    }

    if (!this.rootPage || this.rootPage.isClosed()) {
      this.rootPage = await this.context.newPage();
      this.rootPage.setDefaultTimeout(this.config.app.timeoutMs);
      this.rootPage.setDefaultNavigationTimeout(this.config.app.navigationTimeoutMs);
    }

    const livePlay = this.findMainnetPlayPage();
    if (livePlay && !forceReopen) {
      this.playPage = livePlay;
      return this.playPage;
    }

    if (!this.rootPage.url().includes("/survivor")) {
      await this.rootPage.goto(this.config.app.url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    }

    const playButton = this.rootPage.locator("button, [role='button'], a").filter({ hasText: /^\s*PLAY\s*$/i }).first();
    const continueButton = this.rootPage
      .locator("button, [role='button'], a")
      .filter({ hasText: /^\s*CONTINUE\s*$/i })
      .first();
    const loginButton = this.rootPage
      .locator("button, [role='button'], a")
      .filter({ hasText: /^\s*LOG IN\s*$/i })
      .first();
    const buyGameButton = this.rootPage
      .locator("button, [role='button'], a")
      .filter({ hasText: /^\s*BUY GAME\s*$/i })
      .first();

    const deadline = Date.now() + 30 * 60 * 1000;
    let noGamesLogged = false;
    let lastNudgeAt = 0;
    let lastBuyAttemptAt = 0;
    while (Date.now() < deadline) {
      const play = this.findMainnetPlayPage();
      if (play) {
        this.playPage = play;
        await this.playPage.waitForLoadState("domcontentloaded").catch(() => undefined);
        return this.playPage;
      }

      const now = Date.now();
      const executeHandled = await this.trySubmitControllerExecute();
      if (executeHandled) {
        await sleep(1200);
      }

      if (now - lastNudgeAt >= 2500) {
        await this.clickIfVisible(buyGameButton, "buy_game");
        await this.clickIfVisible(loginButton, "login");
        await this.tryLogin(this.rootPage);
        await this.clickIfVisible(continueButton, "continue");
        await this.clickIfVisible(playButton, "play");
        lastNudgeAt = now;
      }

      const buyVisible = await buyGameButton.isVisible().catch(() => false);
      if (buyVisible) {
        if (!noGamesLogged) {
          noGamesLogged = true;
          this.logger.log("warn", "controller.no_games", {
            hint: "Mainnet game ticket required (BUY GAME is visible)"
          });
        }
        if (now - lastBuyAttemptAt >= 8000) {
          lastBuyAttemptAt = now;
          const clicked = await this.clickIfVisible(buyGameButton, "buy_game");
          if (clicked) {
            this.logger.log("info", "controller.buy_game_attempt", {});
            await sleep(1200);
            await this.trySubmitControllerExecute();
          }
        }
      } else if (noGamesLogged) {
        noGamesLogged = false;
        this.logger.log("info", "controller.game_ticket_detected", {});
      }

      await sleep(800);
    }

    const openPages = this.context.pages().map((p) => p.url());
    throw new Error(`Failed to reach mainnet play page. Open pages: ${openPages.join(", ")}`);
  }

  private findMainnetPlayPage(): Page | null {
    if (!this.context) return null;
    for (const page of this.context.pages()) {
      if (!page.isClosed() && isMainnetPlayUrl(page.url())) {
        return page;
      }
    }
    return null;
  }

  private async tryLogin(page: Page) {
    if (!this.config.session.autoLogin) return false;

    await page.evaluate(() => {
      const sc = (window as any).starknet_controller;
      if (!sc?.connect) return;
      sc.connect().catch(() => undefined);
    }).catch(() => undefined);
    await sleep(250);

    const frame = page.frameLocator("iframe#controller-keychain");
    const username = this.config.session.username?.trim();
    if (!username) {
      this.logger.log("warn", "controller.login_missing_username", {});
      return false;
    }
    const password = this.config.session.password?.trim();
    if (!password) {
      this.logger.log("warn", "controller.login_missing_password", {});
      return false;
    }

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
    let sawLoginUi = false;

    for (let i = 0; i < 20; i += 1) {
      const userVisible = await usernameInput.isVisible().catch(() => false);
      const passwordVisible = await passwordInput.isVisible().catch(() => false);
      const methodVisible = await loginWithPassword.isVisible().catch(() => false);
      if (userVisible || passwordVisible || methodVisible) {
        sawLoginUi = true;
        break;
      }
      await sleep(250);
    }
    if (!sawLoginUi) {
      this.logger.log("info", "controller.login_ui_not_visible", {});
      return false;
    }

    const fillPasswordAndSubmit = async () => {
      const pwVisible = await passwordInput.isVisible().catch(() => false);
      if (!pwVisible) return false;
      await passwordInput.fill(password).catch(() => undefined);
      // Prefer explicit primary Login button after password entry.
      const primaryClicked = await this.clickLocatorWhenEnabled(primaryLogin, "login_submit_primary", 8, 180);
      if (primaryClicked) {
        await sleep(1000);
        return true;
      }

      const submitVisible = await loginSubmit.isVisible().catch(() => false);
      const submitTarget = submitVisible ? loginSubmit : anySubmit;
      const clicked = await this.clickLocatorWhenEnabled(submitTarget, "login_submit", 8, 180);
      if (!clicked) return false;
      await sleep(1000);
      return true;
    };

    // If we are already on password step, just submit credentials.
    if (await fillPasswordAndSubmit()) {
      this.logger.log("info", "controller.login_password_submitted", { mode: "direct_password_field" });
      return true;
    }

    const userVisible = await usernameInput.isVisible().catch(() => false);
    if (!userVisible) return false;
    await usernameInput.fill("").catch(() => undefined);
    await usernameInput.type(username.toLowerCase(), { delay: 40 }).catch(() => undefined);
    await sleep(450);

    // Must explicitly click matching username suggestion before password login.
    const pickedUser = await this.clickMatchingUsernameSuggestion(frame, usernameInput, username);
    if (!pickedUser) {
      this.logger.log("warn", "controller.login_user_suggestion_required_not_found", {});
      return false;
    }

    // Ensure we are on password auth flow.
    await this.clickLocatorWhenEnabled(loginWithPassword, "login_with_password", 24, 250);

    // Retry a short window for delayed render of password step button.
    for (let i = 0; i < 6; i += 1) {
      if (await fillPasswordAndSubmit()) {
        this.logger.log("info", "controller.login_password_submitted", { mode: "after_login_with_password" });
        return true;
      }
      await this.clickLocatorWhenEnabled(loginWithPassword, "login_with_password", 24, 250);
      await sleep(350);
    }

    this.logger.log("warn", "controller.login_password_step_not_ready", {});
    return false;
  }

  private async clickIfVisible(locator: ReturnType<Page["getByText"]>, label: string) {
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) return false;
    this.logger.log("info", "controller.click", { label });
    await locator.click().catch(() => undefined);
    return true;
  }

  private async clickLocatorWhenEnabled(
    locator: ReturnType<Page["locator"]>,
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
      this.logger.log("info", "controller.click", { label });
      await locator.click().catch(() => undefined);
      return true;
    }
    return false;
  }

  private async clickMatchingUsernameSuggestion(
    frame: FrameLocator,
    usernameInput: Locator,
    username: string
  ) {
    const exact = new RegExp(`^\\s*${this.escapeRegex(username)}\\s*$`, "i");
    const fuzzy = new RegExp(this.escapeRegex(username), "i");

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
        const clicked = await this.clickVisibleSuggestion(locator, inputBox);
        if (clicked) {
          this.logger.log("info", "controller.click", { label: "login_user_suggestion" });
          await sleep(250);
          return true;
        }
      }

      await sleep(220);
    }

    return false;
  }

  private async clickVisibleSuggestion(
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

  private escapeRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private async trySubmitControllerExecute() {
    if (!this.context) return false;
    const pages = this.context.pages();
    const executePage = pages.find((page) => !page.isClosed() && page.url().includes("x.cartridge.gg/execute"));
    if (!executePage) return false;

    await executePage.waitForLoadState("domcontentloaded").catch(() => undefined);
    const submit = executePage.getByText("SUBMIT", { exact: false }).first();
    const visible = await submit.isVisible().catch(() => false);
    if (!visible) return false;

    this.logger.log("info", "controller.click", { label: "submit" });
    await submit.click().catch(() => undefined);
    return true;
  }
}
