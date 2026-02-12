import { Browser, BrowserContext, Frame, FrameLocator, Locator, Page, chromium } from "playwright";
import { RunnerConfig } from "../config/schema.js";
import { RunnerSession } from "../session/session.js";
import { Logger } from "../utils/logger.js";
import { normalizeStarknetAddress, starknetAddressesEqual } from "../utils/starknet.js";
import { sleep } from "../utils/time.js";
import type { StarknetCall } from "./vrf.js";
import { buildRequestRandomCall } from "./vrf.js";

type ExecuteResult = {
  ok: boolean;
  txHash?: string | null;
  error?: {
    stage?: "preflight" | "execute";
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

function parseAdventurerIdFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    const id = parsed.searchParams.get("id");
    if (!id) return null;
    const n = Number(id);
    return Number.isFinite(n) ? n : null;
  } catch {
    const match = url.match(/[?&]id=(\d+)/);
    if (!match) return null;
    const n = Number(match[1]);
    return Number.isFinite(n) ? n : null;
  }
}

export class ControllerExecutor {
  private config: RunnerConfig;
  private logger: Logger;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private rootPage: Page | null = null;
  private playPage: Page | null = null;
  private currentAdventurerId: number | null = null;
  private session: RunnerSession | null = null;
  private gameContract: string;
  private lastControllerSnapshotAt = 0;

  constructor(config: RunnerConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.gameContract = config.chain.gameContract;
  }

  private async evalWithTimeout<T>(
    page: Page,
    fn: () => T | Promise<T>,
    timeoutMs: number,
    fallback: T
  ): Promise<T> {
    if (page.isClosed()) return fallback;
    const result = await Promise.race([
      page
        .evaluate(fn)
        .then((value) => ({ ok: true as const, value }))
        .catch(() => ({ ok: false as const, value: fallback })),
      sleep(timeoutMs).then(() => ({ ok: false as const, value: fallback }))
    ]);
    return result.value;
  }

  async start(session: RunnerSession) {
    this.session = session;
    this.currentAdventurerId = (session.adventurerId ?? null) ?? this.currentAdventurerId;
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
        page.setDefaultTimeout(this.config.app.timeoutMs);
        page.setDefaultNavigationTimeout(this.config.app.navigationTimeoutMs);
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

  async startGame(adventurerId: number, weaponId: number, vrfSalt?: string | null) {
    return this.execute("start_game", [adventurerId, weaponId], { vrfSalt: vrfSalt ?? null });
  }

  async explore(adventurerId: number, tillBeast: boolean, vrfSalt?: string | null) {
    return this.execute("explore", [adventurerId, tillBeast], { vrfSalt: vrfSalt ?? null });
  }

  async attack(adventurerId: number, toTheDeath: boolean, vrfSalt?: string | null) {
    return this.execute("attack", [adventurerId, toTheDeath], { vrfSalt: vrfSalt ?? null });
  }

  async flee(adventurerId: number, toTheDeath: boolean, vrfSalt?: string | null) {
    return this.execute("flee", [adventurerId, toTheDeath], { vrfSalt: vrfSalt ?? null });
  }

  async buyItems(adventurerId: number, potions: number, items: Array<{ item_id: number; equip: boolean }>) {
    return this.execute("buy_items", [adventurerId, potions, items]);
  }

  async equip(adventurerId: number, items: number[], vrfSalt?: string | null) {
    return this.execute("equip", [adventurerId, items], { vrfSalt: vrfSalt ?? null });
  }

  async selectStatUpgrades(adventurerId: number, stats: Record<string, number>) {
    return this.execute("select_stat_upgrades", [adventurerId, stats]);
  }

  getCurrentAdventurerId() {
    return this.currentAdventurerId;
  }

  getCurrentPlayUrl() {
    return this.playPage?.url() ?? null;
  }

  async recoverToKnownPlay(adventurerId: number, playUrl?: string | null) {
    if (!this.context || !this.rootPage || !this.session) {
      return false;
    }
    this.currentAdventurerId = adventurerId;
    const recovered = await this.tryRestoreTrackedPlay("stale_recovery", adventurerId, playUrl ?? null);
    if (!recovered) {
      return false;
    }
    await this.trySubmitControllerExecute();
    return true;
  }

  private async execute(
    entrypoint: string,
    calldata: any[],
    opts: { vrfSalt?: string | null } = {}
  ): Promise<{ transaction_hash?: string }> {
    const retries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        const page = await this.ensureMainnetPlay();
        const connected = await this.ensureControllerConnected(page, attempt > 1);
        if (!connected) {
          throw new Error("Controller account not connected");
        }

        const calls: StarknetCall[] = [];
        if (opts.vrfSalt) {
          calls.push(buildRequestRandomCall(this.gameContract, opts.vrfSalt));
        }
        calls.push({
          contractAddress: this.gameContract,
          entrypoint,
          calldata
        });

        const wantsMainnet = this.config.chain.rpcWriteUrl.includes("/mainnet/");
        const pumpMs = wantsMainnet
          ? Math.max(30_000, this.config.recovery.actionTimeoutMs)
          : Math.max(8_000, this.config.recovery.actionTimeoutMs);
        let done = false;
        const submitPump = this.pumpSubmitClicksUntil(() => done, pumpMs);
        const result = await this.executeOnPage(page, entrypoint, calls);
        done = true;
        await submitPump;
        if (result.ok) {
          return { transaction_hash: result.txHash || undefined };
        }

        if ((result.error?.text ?? "").includes("execute_timeout")) {
          await this.logControllerSnapshot(page, "execute_timeout");
        }

        const text = `${result.error?.message || ""} ${result.error?.text || ""} ${result.error?.json || ""}`;
        const alreadyStarted =
          entrypoint === "start_game" &&
          (text.toLowerCase().includes("already started") || text.includes("Adventurer") && text.includes("started"));
        if (alreadyStarted) {
          this.logger.log("warn", "controller.start_game_already_started", { attempt });
          await this.refreshSurvivorPages("start_game_already_started");
          return {};
        }
        const notInBattle = text.toLowerCase().includes("not in battle");
        if (notInBattle && (entrypoint === "attack" || entrypoint === "flee")) {
          this.logger.log("warn", "controller.not_in_battle_refresh", { entrypoint, attempt });
          await this.refreshSurvivorPages("not_in_battle");
          return {};
        }

        const needsReconnect =
          text.includes("NOT_CONNECTED") ||
          text.includes("no_controller") ||
          text.includes("no_account_execute") ||
          text.includes("execute_timeout") ||
          text.includes("page_closed");
        if (needsReconnect && attempt < retries) {
          this.logger.log("warn", "controller.reconnect", { entrypoint, attempt });
          await this.ensureMainnetPlay(true);
          continue;
        }

        throw new Error(
          `Controller execute failed (${entrypoint})${result.error?.stage ? ` [${result.error.stage}]` : ""}: ${
            text || "unknown error"
          }`
        );
      } catch (error) {
        lastError = error as Error;
        const message = String(error);
        this.logger.log("warn", "controller.execute_error", {
          entrypoint,
          attempt,
          error: String(error)
        });
        const nonRetryable =
          message.includes("[preflight]") ||
          message.toLowerCase().includes("vrfprovider: not fulfilled") ||
          message.toLowerCase().includes("market is closed");

        if (nonRetryable) {
          break;
        }

        if (attempt < retries) {
          await sleep(1000);
          await this.ensureMainnetPlay(true);
          continue;
        }
      }
    }

    throw lastError ?? new Error(`Controller execute failed (${entrypoint})`);
  }

  private async executeOnPage(page: Page, entrypoint: string, calls: StarknetCall[]): Promise<ExecuteResult> {
    const preflightEnabled = this.config.chain.rpcWriteUrl.includes("/mainnet/");
    const script = `
      (async function () {
        var sc = (window && window.starknet_controller) || null;
        if (!sc) {
          return { ok: false, error: { text: "no_controller" } };
        }
        try {
          var connected = null;
          if (typeof sc.connect === "function") {
            connected = await sc.connect().catch(function () { return null; });
            try {
              var candidate =
                (connected && connected.account && typeof connected.account.execute === "function" && connected.account) ||
                (connected && typeof connected.execute === "function" && connected) ||
                (sc.account && typeof sc.account.execute === "function" && sc.account) ||
                null;
              if (candidate) {
                window.__LS2_CONTROLLER_ACCOUNT__ = candidate;
              }
            } catch (e) {}
          }
          var account =
            window.__LS2_CONTROLLER_ACCOUNT__ ||
            sc.account ||
            connected?.account ||
            connected ||
            sc.provider?.account ||
            sc.controller?.account ||
            null;
          if (!account || typeof account.execute !== "function") {
            return { ok: false, error: { text: "no_account_execute" } };
          }

          var calls = ${JSON.stringify(calls)};

          if (${JSON.stringify(preflightEnabled)}) {
            var estimateFn = null;
            try {
              estimateFn =
                (typeof account.estimateInvokeFee === "function" && account.estimateInvokeFee.bind(account)) ||
                (typeof account.estimateFee === "function" && account.estimateFee.bind(account)) ||
                null;
            } catch (e) {
              estimateFn = null;
            }
            if (estimateFn) {
              try {
                await estimateFn(calls);
              } catch (error) {
                var msg = String((error && (error.message || error)) || error);
                var json = "";
                try { json = JSON.stringify(error); } catch (e) {}
                var combined = msg + " " + json;
                var lower = combined.toLowerCase();
                // VRF errors can resolve only after a real tx hits the relay; treat as informational and proceed.
                if (
                  lower.includes("market is closed") ||
                  lower.includes("not in battle") ||
                  lower.includes("already started")
                ) {
                  return { ok: false, error: { stage: "preflight", text: combined, message: msg, json: json } };
                }
                // Ignore estimation errors we don't understand and proceed to execute.
              }
            }
          }

          var tx = await account.execute(calls);
          var txHash = (tx && (tx.transaction_hash || tx.transactionHash)) || null;
          return { ok: true, txHash: txHash };
        } catch (error) {
          var out = { stage: "execute", text: String(error) };
          try { out.code = error && error.code; } catch (e) {}
          try { out.message = error && error.message; } catch (e) {}
          try { out.json = JSON.stringify(error); } catch (e) {}
          return { ok: false, error: out };
        }
      })()
    `;

    const evalPromise = page.evaluate(function (rawScript) {
      return (0, eval)(rawScript);
    }, script);
    const wantsMainnet = this.config.chain.rpcWriteUrl.includes("/mainnet/");
    const timeoutMs = wantsMainnet
      ? Math.max(30_000, this.config.recovery.actionTimeoutMs)
      : Math.max(8_000, this.config.recovery.actionTimeoutMs);
    const timeoutPromise = sleep(timeoutMs).then(
      () =>
        ({
          ok: false,
          error: { text: "execute_timeout", message: `execute timed out after ${timeoutMs}ms` }
        }) satisfies ExecuteResult
    );
    return Promise.race([evalPromise, timeoutPromise]);
  }

  private async pumpSubmitClicksUntil(shouldStop: () => boolean, durationMs: number) {
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline && !shouldStop()) {
      await this.trySubmitControllerExecute().catch(() => false);
      await sleep(250);
    }
  }

  private async ensureControllerConnected(page: Page, tryLoginFlow: boolean) {
    const pingConnect = async () => {
      await this.evalWithTimeout(
        page,
        async () => {
          const sc = (window as any).starknet_controller;
          if (!sc?.connect) return null;
          try {
            const connected = await sc.connect().catch(() => null);
            const w = window as any;
            const candidate =
              (connected?.account && typeof connected.account.execute === "function" && connected.account) ||
              (connected && typeof connected.execute === "function" && connected) ||
              (sc.account && typeof sc.account.execute === "function" && sc.account) ||
              null;
            if (candidate) {
              w.__LS2_CONTROLLER_ACCOUNT__ = candidate;
            }
          } catch {
            // ignore
          }
          return null;
        },
        2500,
        null
      );
    };

    await pingConnect();
    const deadline = Date.now() + 15_000;
    for (let i = 0; i < 12 && Date.now() < deadline; i += 1) {
      if (await this.hasControllerAccount(page)) {
        return await this.verifyControllerAccount(page);
      }
      await this.trySubmitControllerExecute().catch(() => false);
      if (tryLoginFlow) {
        if (this.rootPage && !this.rootPage.isClosed()) {
          await this.tryLogin(this.rootPage);
        }
        await this.tryLogin(page);
      }
      await pingConnect();
      if (i === 5) {
        await this.logControllerSnapshot(page, "no_account_mid_connect");
      }
      await sleep(220);
    }
    await this.logControllerSnapshot(page, "no_account_final");
    return false;
  }

  private async hasControllerAccount(page: Page) {
    return this.evalWithTimeout(
      page,
      () => {
        const sc = (window as any).starknet_controller;
        if (!sc) return false;
        const account =
          (window as any).__LS2_CONTROLLER_ACCOUNT__ ||
          sc.account ||
          sc.provider?.account ||
          sc.controller?.account;
        return !!account && typeof account.execute === "function";
      },
      2500,
      false
    );
  }

  private async verifyControllerAccount(page: Page) {
    const expected = this.config.session.controllerAddress?.trim();
    if (!expected) return true;

    const addresses = await this.evalWithTimeout(
      page,
      () => {
        const w = window as any;
        const sc = w.starknet_controller;
        const account =
          w.__LS2_CONTROLLER_ACCOUNT__ ||
          sc?.account ||
          sc?.provider?.account ||
          sc?.controller?.account ||
          null;
        return {
          executeAccount: account?.address ?? null,
          scAccount: sc?.account?.address ?? null,
          controllerAccount: sc?.controller?.account?.address ?? null
        };
      },
      2500,
      { executeAccount: null, scAccount: null, controllerAccount: null }
    );

    const candidates = [addresses.executeAccount, addresses.scAccount, addresses.controllerAccount].filter(
      (v): v is string => typeof v === "string" && v.trim().length > 0
    );
    const matches = candidates.some((candidate) => starknetAddressesEqual(candidate, expected));
    if (!matches) {
      this.logger.log("warn", "controller.account_mismatch", {
        expected,
        actual: addresses.executeAccount,
        scAccount: addresses.scAccount,
        controllerAccount: addresses.controllerAccount,
        expectedNormalized: normalizeStarknetAddress(expected),
        actualNormalized: normalizeStarknetAddress(addresses.executeAccount)
      });
      return false;
    }
    return true;
  }

  private async logControllerSnapshot(page: Page, reason: string) {
    if (Date.now() - this.lastControllerSnapshotAt < 10_000) {
      return;
    }
    this.lastControllerSnapshotAt = Date.now();

    if (page.isClosed()) {
      this.logger.log("warn", "controller.snapshot", {
        reason,
        snapshot: { error: "page_closed", href: null }
      });
      return;
    }

    const snapshot = await page
      .evaluate(() => {
        const w = window as any;
        const sc = w.starknet_controller;
        const account = w.__LS2_CONTROLLER_ACCOUNT__ || sc?.account || sc?.provider?.account || sc?.controller?.account || null;
        return {
          hasController: !!sc,
          controllerKeys: sc ? Object.keys(sc).slice(0, 20) : [],
          hasConnect: !!sc?.connect,
          hasAccount: !!account,
          accountAddress: account?.address ?? null,
          accountKeys: account ? Object.keys(account).slice(0, 20) : [],
          href: location.href
        };
      })
      .catch((error) => ({ error: String(error) }));

    this.logger.log("warn", "controller.snapshot", { reason, snapshot });
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

    const expectedAdventurerId = this.currentAdventurerId ?? this.session.adventurerId ?? null;
    const livePlay = this.findMainnetPlayPage(expectedAdventurerId);
    if (livePlay && !forceReopen) {
      this.playPage = livePlay;
      this.currentAdventurerId = parseAdventurerIdFromUrl(this.playPage.url());
      return this.playPage;
    }

    if (!this.rootPage.url().includes("/survivor")) {
      await this.rootPage.goto(this.config.app.url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    }

    // Only restore a tracked play URL if we have an explicit prior playUrl hint.
    // This prevents the runner from "jumping back" to a stale adventurer when the user just bought a fresh game.
    if (expectedAdventurerId && this.session.playUrl) {
      if (await this.tryRestoreTrackedPlay("ensure_mainnet_play", expectedAdventurerId, this.session.playUrl)) {
        return this.playPage!;
      }
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
    let lastUiProgressAt = Date.now();
    let lastStallRefreshAt = 0;
    const autoBuyGame = !!this.config.session.autoBuyGame;
    while (Date.now() < deadline) {
      const play = this.findMainnetPlayPage(expectedAdventurerId);
      if (play) {
        this.playPage = play;
        this.currentAdventurerId = parseAdventurerIdFromUrl(this.playPage.url());
        await this.playPage.waitForLoadState("domcontentloaded").catch(() => undefined);
        return this.playPage;
      }

      const now = Date.now();
      const executeHandled = await this.trySubmitControllerExecute();
      let progressed = executeHandled;
      if (executeHandled) {
        await sleep(1200);
      }

      if (now - lastNudgeAt >= 2500) {
        if (await this.clickIfVisible(loginButton, "login")) progressed = true;
        const didLogin = await this.tryLogin(this.rootPage);
        if (didLogin) progressed = true;
        if (didLogin) {
          if (await this.tryAcceptTerms(this.rootPage)) progressed = true;
        }
        if (await this.tryAcceptTerms(this.rootPage)) progressed = true;
        if (await this.tryEnterDungeon(this.rootPage)) progressed = true;
        if (await this.trySubmitOnPage(this.rootPage)) progressed = true;
        if (await this.clickIfVisible(continueButton, "continue")) progressed = true;
        if (await this.clickIfVisible(playButton, "play")) progressed = true;
        lastNudgeAt = now;
      }

      if (!autoBuyGame) {
        if (!noGamesLogged && now - lastUiProgressAt > 15_000) {
          noGamesLogged = true;
          this.logger.log("warn", "controller.no_games", {
            hint: "If you have no active game, buy a ticket via BUY GAME (mainnet) and the runner will continue."
          });
        }
      } else if (now - lastBuyAttemptAt >= 5 * 60_000 && now - lastUiProgressAt >= 12_000) {
        // Auto-buy is opt-in and rate-limited to avoid accidental repeated purchases.
        lastBuyAttemptAt = now;
        const clicked = await this.clickIfVisible(buyGameButton, "buy_game");
        if (clicked) {
          progressed = true;
          noGamesLogged = false;
          this.logger.log("info", "controller.buy_game_attempt", {});
          await sleep(1200);
          if (await this.trySubmitControllerExecute()) progressed = true;
        }
      }

      if (progressed) {
        noGamesLogged = false;
        lastUiProgressAt = now;
      } else {
        const uiFreezeMs = this.config.recovery.uiFreezeMs;
        const reloadCooldownMs = this.config.recovery.reloadCooldownMs;
        if (now - lastUiProgressAt >= uiFreezeMs && now - lastStallRefreshAt >= reloadCooldownMs) {
          this.logger.log("warn", "controller.ui_stall", {
            stalledMs: now - lastUiProgressAt,
            uiFreezeMs
          });
          await this.refreshSurvivorPages("ui_stall");
          lastStallRefreshAt = Date.now();
          lastUiProgressAt = Date.now();
          await sleep(700);
          continue;
        }
      }

      await sleep(800);
    }

    const openPages = this.context.pages().map((p) => p.url());
    throw new Error(`Failed to reach mainnet play page. Open pages: ${openPages.join(", ")}`);
  }

  private findMainnetPlayPage(expectedAdventurerId?: number | null): Page | null {
    if (!this.context) return null;
    const pages = this.context.pages();
    let newest: Page | null = null;
    for (let i = pages.length - 1; i >= 0; i -= 1) {
      const page = pages[i]!;
      if (!page.isClosed() && isMainnetPlayUrl(page.url())) {
        newest = page;
        break;
      }
    }
    if (!newest) return null;

    if (expectedAdventurerId == null) {
      return newest;
    }

    // If the newest play page is for a different adventurer id, prefer it. This prevents "jumping back"
    // to a stale session when the user (or auto-buy flow) just opened a fresh game.
    const newestId = parseAdventurerIdFromUrl(newest.url());
    if (newestId != null && newestId !== expectedAdventurerId) {
      return newest;
    }

    for (let i = pages.length - 1; i >= 0; i -= 1) {
      const page = pages[i]!;
      if (page.isClosed() || !isMainnetPlayUrl(page.url())) continue;
      const pageAdventurerId = parseAdventurerIdFromUrl(page.url());
      if (pageAdventurerId === expectedAdventurerId) {
        return page;
      }
    }

    return newest;
  }

  private buildPlayUrl(adventurerId: number) {
    const fromSession = this.session?.playUrl;
    if (fromSession && fromSession.includes("/survivor/play?id=")) {
      try {
        const parsed = new URL(fromSession);
        parsed.searchParams.set("id", String(adventurerId));
        return parsed.toString();
      } catch {
        // fall through to app url builder
      }
    }

    try {
      const base = new URL(this.config.app.url);
      base.pathname = "/survivor/play";
      base.search = `?id=${adventurerId}`;
      return base.toString();
    } catch {
      return `https://lootsurvivor.io/survivor/play?id=${adventurerId}`;
    }
  }

  private async tryRestoreTrackedPlay(reason: string, adventurerId: number, preferredPlayUrl?: string | null) {
    if (!this.context || !this.rootPage) return false;
    const candidates = new Set<string>();
    if (preferredPlayUrl && preferredPlayUrl.includes("/survivor/play?id=")) {
      candidates.add(preferredPlayUrl);
    }
    candidates.add(this.buildPlayUrl(adventurerId));

    const existing = this.findMainnetPlayPage(adventurerId);
    if (existing) {
      this.playPage = existing;
      this.currentAdventurerId = parseAdventurerIdFromUrl(existing.url());
      return true;
    }

    for (const url of candidates) {
      const targetPage = this.playPage && !this.playPage.isClosed() ? this.playPage : this.rootPage;
      const currentUrl = targetPage.url();
      if (currentUrl !== url) {
        await targetPage.goto(url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
      }
      await targetPage.waitForLoadState("domcontentloaded").catch(() => undefined);

      if (!isMainnetPlayUrl(targetPage.url())) {
        continue;
      }

      const detectedAdventurerId = parseAdventurerIdFromUrl(targetPage.url());
      if (detectedAdventurerId !== adventurerId) {
        continue;
      }

      this.playPage = targetPage;
      this.currentAdventurerId = detectedAdventurerId;
      this.logger.log("info", "controller.restore_play", {
        reason,
        adventurerId,
        url: targetPage.url()
      });
      return true;
    }

    return false;
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

    // Some controller versions enable the password flow button immediately (even before suggestion click).
    await this.clickLocatorWhenEnabled(loginWithPassword, "login_with_password", 6, 200);
    for (let i = 0; i < 3; i += 1) {
      if (await fillPasswordAndSubmit()) {
        this.logger.log("info", "controller.login_password_submitted", { mode: "direct_login_with_password" });
        return true;
      }
      await sleep(250);
    }

    // Must explicitly click matching username suggestion before password login in most flows.
    const suggestionClicked = await this.clickMatchingUsernameSuggestion(frame, usernameInput, username);
    if (!suggestionClicked) {
      // Fallback: keyboard-select the first suggestion. If this does nothing, we'll fail later and retry.
      await usernameInput.click().catch(() => undefined);
      await usernameInput.press("ArrowDown").catch(() => undefined);
      await usernameInput.press("Enter").catch(() => undefined);
      await sleep(250);
      this.logger.log("warn", "controller.login_user_suggestion_missing", { fallback: "keyboard_select" });
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

  private async tryAcceptTerms(page: Page) {
    const acceptButton = page.locator("button").filter({ hasText: /accept\s*&\s*continue/i }).first();
    const acceptVisible = await acceptButton.isVisible().catch(() => false);
    if (!acceptVisible) return false;

    const checkboxes = page.locator("input[type='checkbox']");
    const count = await checkboxes.count().catch(() => 0);
    let checkedAny = false;
    for (let i = 0; i < count; i += 1) {
      const checkbox = checkboxes.nth(i);
      const visible = await checkbox.isVisible().catch(() => false);
      if (!visible) continue;
      const isChecked = await checkbox.isChecked().catch(() => false);
      if (isChecked) {
        checkedAny = true;
        break;
      }
      await checkbox.click({ force: true }).catch(() => undefined);
      checkedAny = true;
      this.logger.log("info", "controller.click", { label: "terms_checkbox" });
      await sleep(180);
      break;
    }

    if (!checkedAny) {
      const checkboxWrapper = page.locator("span.MuiCheckbox-root").first();
      const wrapperVisible = await checkboxWrapper.isVisible().catch(() => false);
      if (wrapperVisible) {
        await checkboxWrapper.click().catch(() => undefined);
        this.logger.log("info", "controller.click", { label: "terms_checkbox" });
        await sleep(180);
      }
    }

    const accepted = await this.clickLocatorWhenEnabled(acceptButton, "accept_continue", 6, 180);
    if (accepted) {
      await sleep(500);
    }
    return accepted;
  }

  private async tryEnterDungeon(page: Page) {
    const enterDungeonLabel = page.getByText(/^\s*Enter Dungeon\s*$/i).first();
    const visible = await enterDungeonLabel.isVisible().catch(() => false);
    if (!visible) return false;

    const clickableAncestor = enterDungeonLabel
      .locator("xpath=ancestor-or-self::*[self::button or self::a or @role='button'][1]")
      .first();
    const ancestorClicked = await this.clickLocatorWhenEnabled(clickableAncestor, "enter_dungeon", 4, 150);
    if (ancestorClicked) {
      await sleep(350);
      return true;
    }

    const containerButton = page
      .locator("button, [role='button'], a")
      .filter({ hasText: /^\s*Enter Dungeon\s*$/i })
      .first();
    const containerClicked = await this.clickLocatorWhenEnabled(containerButton, "enter_dungeon", 4, 150);
    if (containerClicked) {
      await sleep(350);
      return true;
    }

    this.logger.log("info", "controller.click", { label: "enter_dungeon" });
    await enterDungeonLabel.click({ force: true }).catch(() => undefined);
    await sleep(350);
    return true;
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

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const inputBox = await usernameInput.boundingBox().catch(() => null);
      const candidates: Locator[] = [
        frame.locator("[role='option']").filter({ hasText: exact }),
        frame.locator("[role='option']").filter({ hasText: fuzzy }),
        frame.locator("button").filter({ hasText: exact }),
        frame.locator("div").filter({ hasText: exact }),
        frame.locator("li").filter({ hasText: exact }),
        frame.locator("li").filter({ hasText: fuzzy }),
        frame.getByText(exact),
        frame.getByText(fuzzy)
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
    const pages = this.context
      .pages()
      .filter((page) => !page.isClosed() && page.url().includes("cartridge.gg/execute"));
    if (pages.length === 0) return false;

    let clickedAny = false;
    for (const page of pages.reverse()) {
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      if (await this.trySubmitOnPage(page)) {
        clickedAny = true;
      }
    }
    return clickedAny;
  }

  private async trySubmitOnPage(page: Page) {
    if (await this.trySubmitOnScope(page)) {
      return true;
    }

    const frames = page.frames().filter((frame) => frame !== page.mainFrame());
    for (const frame of frames) {
      if (await this.trySubmitOnScope(frame)) {
        return true;
      }
    }

    return false;
  }

  private async trySubmitOnScope(scope: Page | Frame) {
    const roleSubmit = scope.getByRole("button", { name: /^\s*submit\s*$/i }).first();
    if (await this.clickSubmitLocator(roleSubmit, 5, 180)) {
      await this.maybeRefreshAfterSubmit(scope);
      return true;
    }

    const submitButton = scope.locator("button, [role='button'], a").filter({ hasText: /^\s*submit\s*$/i }).first();
    if (await this.clickSubmitLocator(submitButton, 5, 180)) {
      await this.maybeRefreshAfterSubmit(scope);
      return true;
    }

    const submitLabel = scope.getByText(/^\s*submit\s*$/i).first();
    const labelVisible = await submitLabel.isVisible().catch(() => false);
    if (!labelVisible) return false;

    const clickableAncestor = submitLabel
      .locator("xpath=ancestor-or-self::*[self::button or self::a or @role='button'][1]")
      .first();
    if (await this.clickSubmitLocator(clickableAncestor, 4, 140)) {
      await this.maybeRefreshAfterSubmit(scope);
      return true;
    }

    this.logger.log("info", "controller.click", { label: "submit" });
    const clicked = await submitLabel.click({ force: true }).then(() => true).catch(() => false);
    if (!clicked) {
      this.logger.log("warn", "controller.submit_click_error", { reason: "force_click_failed" });
      await this.refreshSurvivorPages("submit_click_error");
      return false;
    }
    await this.maybeRefreshAfterSubmit(scope);
    return true;
  }

  private async clickSubmitLocator(locator: Locator, attempts = 4, delayMs = 200) {
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
      this.logger.log("info", "controller.click", { label: "submit" });
      const clicked = await locator.click().then(() => true).catch(() => false);
      if (clicked) return true;

      this.logger.log("warn", "controller.submit_click_error", { reason: "click_failed", attempt: i + 1 });
      await this.refreshSurvivorPages("submit_click_error");
      return false;
    }
    return false;
  }

  private async maybeRefreshAfterSubmit(scope: Page | Frame) {
    await sleep(300);
    const patterns: Array<{ pattern: RegExp; reason: string }> = [
      { pattern: /transaction\s+(failed|error|rejected)/i, reason: "submit_transaction_error" },
      { pattern: /execution error/i, reason: "submit_execution_error" },
      { pattern: /already started/i, reason: "submit_already_started" },
      { pattern: /not in battle/i, reason: "submit_not_in_battle" },
      { pattern: /failed to (submit|send|execute)/i, reason: "submit_failed_to_execute" }
    ];

    for (const { pattern, reason } of patterns) {
      const visible = await scope.getByText(pattern).first().isVisible().catch(() => false);
      if (!visible) continue;
      this.logger.log("warn", "controller.submit_error_refresh", { reason });
      await this.refreshSurvivorPages(reason);
      return;
    }
  }

  private async refreshSurvivorPages(reason: string) {
    if (!this.context) return;
    const pages = this.context
      .pages()
      .filter((p) => !p.isClosed() && p.url().includes("/survivor"));
    const targets = pages.length > 0 ? pages : this.rootPage ? [this.rootPage] : [];
    for (const page of targets) {
      this.logger.log("info", "controller.refresh", { reason, url: page.url() });
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
      await sleep(350);
    }
    const expectedAdventurerId = this.currentAdventurerId ?? this.session?.adventurerId ?? null;
    const livePlay = this.findMainnetPlayPage(expectedAdventurerId);
    if (livePlay) {
      this.playPage = livePlay;
      this.currentAdventurerId = parseAdventurerIdFromUrl(this.playPage.url());
    }
  }
}
