import { chromium, Browser, BrowserContext, Page } from "playwright";
import { RunnerConfig } from "../config/schema.js";
import { Logger } from "../utils/logger.js";
import { GameState, Phase } from "../runner/types.js";
import { parseNumber } from "../utils/parse.js";
import { sleep } from "../utils/time.js";

export class PlaywrightClient {
  private config: RunnerConfig;
  private logger: Logger;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private lastReloadAt = 0;
  private reloads: number[] = [];

  constructor(config: RunnerConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  async start() {
    this.browser = await chromium.launch({
      headless: this.config.app.headless || !!process.env.RUNNER_HEADLESS,
      slowMo: this.config.app.slowMoMs
    });
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.config.app.timeoutMs);
    this.page.setDefaultNavigationTimeout(this.config.app.navigationTimeoutMs);

    this.page.on("dialog", async (dialog) => {
      this.logger.log("warn", "ui.dialog", { message: dialog.message() });
      await dialog.dismiss();
    });

    this.page.on("pageerror", (error) => {
      this.logger.log("error", "ui.page_error", { error: String(error) });
    });

    await this.navigate();
  }

  getPage(): Page {
    if (!this.page) throw new Error("Page not initialized");
    return this.page;
  }

  async stop() {
    await this.page?.close().catch(() => undefined);
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
  }

  async navigate() {
    if (!this.page) throw new Error("Page not initialized");
    this.logger.log("info", "ui.navigate", { url: this.config.app.url });
    await this.page.goto(this.config.app.url, { waitUntil: "domcontentloaded" });
  }

  async readState(): Promise<GameState> {
    if (!this.page) throw new Error("Page not initialized");
    const [windowState, domState, hasWallet, hasPending] = await Promise.all([
      this.extractFromWindow(),
      this.extractFromDom(),
      this.hasAnyText(this.config.safety.walletText),
      this.hasAnyText(this.config.safety.pendingTxText)
    ]);

    const level = parseNumber(windowState?.level ?? domState.level ?? null);
    const hp = parseNumber(windowState?.hp ?? domState.hp ?? null);
    const maxHp = parseNumber(windowState?.maxHp ?? domState.maxHp ?? null);
    const gold = parseNumber(windowState?.gold ?? domState.gold ?? null);

    const enemyName = windowState?.enemy?.name ?? domState.enemyName ?? null;
    const enemyLevel = parseNumber(windowState?.enemy?.level ?? domState.enemyLevel ?? null);
    const enemyHp = parseNumber(windowState?.enemy?.hp ?? domState.enemyHp ?? null);
    const enemyMaxHp = parseNumber(windowState?.enemy?.maxHp ?? domState.enemyMaxHp ?? null);

    const location = windowState?.location ?? domState.location ?? null;

    const availableActions = await this.detectAvailableActions();
    const phase = this.inferPhase(availableActions, location);

    const practiceMode = await this.detectPracticeMode();
    const overlay = await this.isVisible(this.config.selectors.closeOverlay).catch(() => false);

    return {
      phase,
      level,
      hp,
      maxHp,
      gold,
      location,
      enemy: enemyName || enemyLevel || enemyHp || enemyMaxHp ? {
        name: enemyName,
        level: enemyLevel,
        hp: enemyHp,
        maxHp: enemyMaxHp
      } : null,
      inventory: windowState?.inventory ?? null,
      market: windowState?.market ?? null,
      availableActions,
      flags: {
        pendingTx: hasPending,
        walletUi: hasWallet,
        overlay,
        practiceMode
      }
    };
  }

  async probeUi(): Promise<Record<string, unknown>> {
    if (!this.page) throw new Error("Page not initialized");

    const windowState = await this.extractFromWindow();
    const domState = await this.extractFromDom();
    const practiceMode = await this.detectPracticeMode();

    const practiceToken = this.config.safety.practiceText;
    const report = await this.page.evaluate(`(() => {
      const practiceToken = ${JSON.stringify(practiceToken)};
      const normalize = (text) => (text ?? "").replace(/\\s+/g, " ").trim();
      const unique = (items) => Array.from(new Set(items.filter(Boolean)));

      const allElements = Array.from(document.querySelectorAll("*"));
      const elementCounts = {
        total: allElements.length,
        buttons: document.querySelectorAll("button").length,
        roleButtons: document.querySelectorAll("[role='button']").length,
        anchors: document.querySelectorAll("a").length,
        canvas: document.querySelectorAll("canvas").length,
        inputs: document.querySelectorAll("input,textarea,select").length,
        iframes: document.querySelectorAll("iframe").length
      };

      const tagCounts = {};
      for (const el of allElements) {
        const tag = el.tagName || "UNKNOWN";
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }

      const bodyHtml = document.body?.innerHTML ?? "";
      const bodyHtmlSample = bodyHtml.slice(0, 2000);
      const bodyChildren = Array.from(document.body?.children ?? []).map((el) => ({
        tag: el.tagName,
        id: el.id || undefined,
        className: el.className || undefined
      }));

      const buttonLike = allElements.filter((el) => {
        const role = el.getAttribute?.("role");
        const tab = el.getAttribute?.("tabindex");
        return role === "button" || (tab != null && tab !== \"-1\") || el.tagName === \"BUTTON\";
      });

      const buttonInfo = buttonLike.map((btn) => {
        const text = normalize(btn.innerText || btn.textContent || "");
        const testId = btn.getAttribute?.("data-testid") || undefined;
        const ariaLabel = btn.getAttribute?.("aria-label") || undefined;
        const title = btn.getAttribute?.("title") || undefined;
        return { text, testId, ariaLabel, title, tag: btn.tagName };
      });

      const dataTestIds = unique(
        Array.from(document.querySelectorAll("[data-testid]")).map((el) =>
          el.getAttribute("data-testid") || ""
        )
      );

      const actionLabels = [
        "Practice",
        "Practice for Free",
        "Continue",
        "Explore",
        "Fight",
        "Flee",
        "Drink Potion",
        "Potion",
        "Market",
        "Buy"
      ];

      const suggestedSelectors = {};
      for (const label of actionLabels) {
        const matches = buttonInfo.filter((b) =>
          b.text.toLowerCase().includes(label.toLowerCase())
        );
        const selectors = unique(
          matches.flatMap((b) => {
            const results = [];
            if (b.testId) results.push(\`[data-testid='\${b.testId}']\`);
            if (b.ariaLabel) results.push(\`[aria-label='\${b.ariaLabel}']\`);
            if (b.text) results.push(\`text=\${b.text}\`);
            return results;
          })
        );
        if (selectors.length > 0) suggestedSelectors[label] = selectors;
      }

      const windowKeys = Object.keys(window);
      const keyMatches = windowKeys.filter((k) =>
        /state|loot|survivor|game|dojo|world|store|client/i.test(k)
      );

      const candidates = [];
      for (const key of keyMatches) {
        try {
          const value = window[key];
          const type = typeof value;
          if (value && type === "object") {
            const keys = Object.keys(value).slice(0, 40);
            candidates.push({ key, type, keys });
          } else {
            candidates.push({ key, type });
          }
        } catch {
          candidates.push({ key, type: "unreadable" });
        }
      }

      const localStorageKeys = (() => {
        try {
          return Object.keys(localStorage);
        } catch {
          return [];
        }
      })();

      const localStorageValues = {};
      for (const key of localStorageKeys) {
        if (key === "burner" || key === "burner_version") {
          try {
            const value = localStorage.getItem(key);
            localStorageValues[key] = value?.slice(0, 2000);
          } catch {
            // ignore
          }
        }
      }

      const sessionStorageKeys = (() => {
        try {
          return Object.keys(sessionStorage);
        } catch {
          return [];
        }
      })();

      const bodyText = document.body?.innerText ?? "";
      const bodyTextSample = bodyText.slice(0, 2000);
      const htmlLength = document.body?.innerHTML?.length ?? 0;

      const textMatches = {};
      for (const label of actionLabels) {
        textMatches[label] = bodyText.includes(label);
      }

      const keyTargets = ["hp", "health", "level", "gold", "adventurer", "player", "enemy", "inventory", "potions", "weapon", "armor", "market"];

      const scanWindow = () => {
        const results = [];
        const queue = [{ path: "window", value: window, depth: 0 }];
        const seen = new WeakSet();
        const maxDepth = 3;
        const maxNodes = 2000;
        let processed = 0;

        const isObject = (v) => v && typeof v === "object";

        while (queue.length && processed < maxNodes) {
          const { path, value, depth } = queue.shift();
          if (!isObject(value)) continue;
          if (seen.has(value)) continue;
          seen.add(value);
          processed += 1;

          const keys = Object.keys(value);
          const keySet = new Set(keys.map((k) => k.toLowerCase()));
          const hit = keyTargets.some((k) => keySet.has(k));
          if (hit) {
            const sample = {};
            for (const k of keys.slice(0, 20)) {
              const v = value[k];
              if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v == null) {
                sample[k] = v;
              }
            }
            results.push({ path, keys: keys.slice(0, 40), sample });
          }

          if (depth >= maxDepth) continue;

          for (const k of keys.slice(0, 50)) {
            try {
              const child = value[k];
              if (!isObject(child)) continue;
              if (child instanceof Window) continue;
              if (child instanceof Document) continue;
              if (child instanceof HTMLElement) continue;
              queue.push({ path: path + "." + k, value: child, depth: depth + 1 });
            } catch {
              // ignore
            }
          }
        }

        return results.slice(0, 50);
      };

      let stateCandidates = [];
      try {
        stateCandidates = scanWindow();
      } catch {
        stateCandidates = [];
      }

      return {
        practiceDetected: practiceToken ? bodyText.includes(practiceToken) : null,
        elementCounts,
        tagCounts,
        bodyChildren,
        buttonInfo,
        dataTestIds,
        suggestedSelectors,
        windowKeyCandidates: candidates,
        stateCandidates,
        localStorageKeys,
        localStorageValues,
        sessionStorageKeys,
        bodyTextLength: bodyText.length,
        bodyTextSample,
        bodyHtmlSample,
        htmlLength,
        textMatches
      };
    })()`);

    const frames = this.page.frames();
    const frameReports = [];
    const frameEvalScript = `(() => {
      const normalize = (text) => (text ?? "").replace(/\\s+/g, " ").trim();
      const bodyText = document.body?.innerText ?? "";
      const buttons = Array.from(document.querySelectorAll("button,[role='button']"));
      return {
        url: window.location.href,
        bodyTextLength: bodyText.length,
        bodyTextSample: bodyText.slice(0, 500),
        elementCounts: {
          total: document.querySelectorAll("*").length,
          buttons: document.querySelectorAll("button").length,
          roleButtons: document.querySelectorAll("[role='button']").length,
          anchors: document.querySelectorAll("a").length,
          canvas: document.querySelectorAll("canvas").length,
          inputs: document.querySelectorAll("input,textarea,select").length,
          iframes: document.querySelectorAll("iframe").length
        },
        buttonInfo: buttons.slice(0, 30).map((btn) => ({
          text: normalize(btn.innerText || btn.textContent || ""),
          testId: btn.getAttribute("data-testid") || undefined,
          ariaLabel: btn.getAttribute("aria-label") || undefined,
          title: btn.getAttribute("title") || undefined,
          tag: btn.tagName
        }))
      };
    })()`;

    for (const frame of frames) {
      try {
        const frameReport = await frame.evaluate(frameEvalScript);
        frameReports.push({
          name: frame.name(),
          url: frame.url(),
          report: frameReport
        });
      } catch (error) {
        frameReports.push({
          name: frame.name(),
          url: frame.url(),
          error: String(error)
        });
      }
    }

    return {
      url: this.page.url(),
      timestamp: new Date().toISOString(),
      practiceMode,
      windowState,
      domState,
      frames: frameReports,
      ...report
    };
  }

  async performClick(selector: string, label: string) {
    if (!this.page) throw new Error("Page not initialized");
    const locator = this.page.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) throw new Error(`Selector not visible for ${label}: ${selector}`);
    await locator.click();
  }

  async clickAction(actionType: string, selectorOverride?: string) {
    const selector = selectorOverride ?? this.config.selectors[actionType];
    if (!selector) throw new Error(`Missing selector for action: ${actionType}`);
    await this.performClick(selector, actionType);
  }

  async screenshot(tag: string) {
    if (!this.page) return;
    const fileName = `./data/screenshot-${tag}-${Date.now()}.png`;
    await this.page.screenshot({ path: fileName, fullPage: true }).catch(() => undefined);
  }

  async reloadIfAllowed() {
    const now = Date.now();
    if (now - this.lastReloadAt < this.config.recovery.reloadCooldownMs) return false;
    this.pruneReloads(now);
    if (this.reloads.length >= this.config.recovery.maxReloadsPerHour) return false;
    this.lastReloadAt = now;
    this.reloads.push(now);

    this.logger.log("warn", "ui.reload", { reason: "recovery" });
    await this.page?.reload({ waitUntil: "domcontentloaded" });
    await sleep(1000);
    return true;
  }

  async recoverFromOverlay() {
    const selector = this.config.selectors.closeOverlay;
    if (!selector) return false;
    const visible = await this.isVisible(selector).catch(() => false);
    if (!visible) return false;
    this.logger.log("info", "ui.overlay_close", { selector });
    await this.performClick(selector, "closeOverlay");
    return true;
  }

  async isVisible(selector?: string) {
    if (!selector || !this.page) return false;
    return this.page.locator(selector).first().isVisible();
  }

  private pruneReloads(now: number) {
    const hourAgo = now - 60 * 60 * 1000;
    this.reloads = this.reloads.filter((t) => t > hourAgo);
  }

  private async extractFromWindow(): Promise<any | null> {
    if (!this.page) return null;
    if (this.config.state.extractor.type !== "window" || !this.config.state.extractor.script) return null;
    try {
      return await this.page.evaluate((script) => {
        try {
          // eslint-disable-next-line no-eval
          return (0, eval)(script);
        } catch {
          return null;
        }
      }, this.config.state.extractor.script);
    } catch {
      return null;
    }
  }

  private async extractFromDom(): Promise<Record<string, string | null>> {
    if (!this.page) return {};
    const dom = this.config.state.dom;
    const read = async (selector?: string) => {
      if (!selector) return null;
      const loc = this.page!.locator(selector).first();
      if (!(await loc.isVisible().catch(() => false))) return null;
      return loc.textContent();
    };

    return {
      level: await read(dom.level),
      hp: await read(dom.hp),
      maxHp: await read(dom.maxHp),
      gold: await read(dom.gold),
      location: await read(dom.location),
      enemyName: await read(dom.enemyName),
      enemyLevel: await read(dom.enemyLevel),
      enemyHp: await read(dom.enemyHp),
      enemyMaxHp: await read(dom.enemyMaxHp)
    };
  }

  private async detectAvailableActions(): Promise<string[]> {
    if (!this.page) return [];
    const actionKeys = [
      "practiceStart",
      "continue",
      "explore",
      "fight",
      "flee",
      "drinkPotion",
      "market",
      "buyPotion"
    ];

    const available: string[] = [];
    for (const key of actionKeys) {
      const selector = this.config.selectors[key];
      if (!selector) continue;
      const visible = await this.isVisible(selector).catch(() => false);
      if (visible) available.push(key);
    }
    return available;
  }

  private inferPhase(availableActions: string[], location: string | null): Phase {
    const text = location?.toLowerCase() ?? "";
    if (availableActions.includes("fight")) return "combat";
    if (availableActions.includes("explore")) return "dungeon";
    if (availableActions.includes("market")) return "market";
    if (availableActions.includes("practiceStart")) return "menu";
    if (text.includes("town")) return "town";
    if (text.includes("market")) return "market";
    if (text.includes("dungeon") || text.includes("floor")) return "dungeon";
    if (text.includes("defeat") || text.includes("dead")) return "death";
    return "unknown";
  }

  private async hasAnyText(tokens: string[]) {
    if (!this.page) return false;
    if (tokens.length === 0) return false;
    const joined = tokens.join("||");
    return this.page.evaluate((tokenString) => {
      const text = document.body?.innerText ?? "";
      const parts = tokenString.split("||");
      return parts.some((t) => t && text.includes(t));
    }, joined);
  }

  private async detectPracticeMode(): Promise<boolean | null> {
    if (!this.page) return null;
    const text = this.config.safety.practiceText;
    if (!text) return null;
    return this.page.evaluate((token) => {
      const bodyText = document.body?.innerText ?? "";
      return bodyText.includes(token);
    }, text);
  }
}
