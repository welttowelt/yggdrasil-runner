import { RunnerConfig } from "../config/schema.js";
import { Logger } from "../utils/logger.js";
import { PlaywrightClient } from "../ui/playwrightClient.js";
import { sleep } from "../utils/time.js";
import { BurnerSession, loadSession, saveSession } from "./session.js";

function extractRpcUrl(url: string): string | null {
  if (!url.includes("api.cartridge.gg/x/")) return null;
  const base = url.split("?")[0] ?? url;
  if (base.includes("/katana")) return base;
  if (base.includes("/starknet/") && base.includes("/rpc/")) return base;
  return null;
}

function pickRpcUrl(urls: Set<string>): string | undefined {
  const list = Array.from(urls);
  const slot = list.find((url) => url.includes("/pg-slot-") && url.includes("/katana"));
  if (slot) return slot;
  const katana = list.find((url) => url.includes("/katana"));
  if (katana) return katana;
  const mainnet = list.find((url) => url.includes("/starknet/mainnet/"));
  if (mainnet) return mainnet;
  return list[0];
}

const START_GAME_SELECTOR =
  "0x2214fe6a6e2545aebfe589b84884a2c528416482abec76605b7fdb1c31ce5b2";
const GET_GAME_STATE_SELECTOR =
  "0x2305fda54e31f8525bf15eaf4f22b11a7d1d2a03f1b4d0602b9ead3c29533e";

function toInt(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    try {
      return value.startsWith("0x") ? parseInt(value, 16) : parseInt(value, 10);
    } catch {
      return 0;
    }
  }
  return 0;
}

function parseInvokeCalls(calldata: string[]): Array<{ to: string; selector: string }> {
  const calls: Array<{ to: string; selector: string }> = [];
  if (calldata.length === 0) return calls;
  const total = toInt(calldata[0]);
  let idx = 1;
  for (let i = 0; i < total && idx + 2 < calldata.length; i += 1) {
    const to = calldata[idx]!;
    const selector = calldata[idx + 1]!;
    const dataLen = toInt(calldata[idx + 2]);
    calls.push({ to, selector });
    idx += 3 + dataLen;
  }
  return calls;
}

function extractGameContractHint(postData: string): string | null {
  let payload: any;
  try {
    payload = JSON.parse(postData);
  } catch {
    return null;
  }
  const items = Array.isArray(payload) ? payload : [payload];
  for (const item of items) {
    const method = item?.method;
    if (method === "starknet_call") {
      const req = item?.params?.request;
      if (req?.entry_point_selector === GET_GAME_STATE_SELECTOR && typeof req.contract_address === "string") {
        return req.contract_address;
      }
    }
    if (method === "starknet_estimateFee" || method === "starknet_addInvokeTransaction") {
      const reqs = item?.params?.request ?? item?.params?.invoke_transaction;
      const list = Array.isArray(reqs) ? reqs : reqs ? [reqs] : [];
      for (const req of list) {
        if (req?.type !== "INVOKE") continue;
        const calldata = req?.calldata;
        if (!Array.isArray(calldata)) continue;
        const calls = parseInvokeCalls(calldata);
        for (const call of calls) {
          if (call.selector === START_GAME_SELECTOR) {
            return call.to;
          }
        }
      }
    }
  }
  return null;
}

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
  const inputs = frameLocator.locator("input");
  const usernameInput = frameLocator.locator("input[type='text'], input[type='email'], input:not([type])").first();
  const passwordInput = frameLocator.locator("input[type='password']").first();
  const loginButton = frameLocator.locator("[data-testid='submit-button'], text=log in").first();

  const inputVisible = await inputs.first().isVisible().catch(() => false);
  if (!inputVisible) return false;

  const username = config.session.username?.trim()
    ? config.session.username.trim()
    : `${config.session.usernamePrefix}-${Date.now().toString(36).slice(-6)}`;

  logger.log("info", "session.login", { username });
  await usernameInput.fill(username).catch(() => undefined);

  const password = config.session.password?.trim();
  if (password) {
    const pwVisible = await passwordInput.isVisible().catch(() => false);
    if (pwVisible) {
      await passwordInput.fill(password).catch(() => undefined);
    } else {
      const count = await inputs.count().catch(() => 0);
      if (count >= 2) {
        await inputs.nth(1).fill(password).catch(() => undefined);
      }
    }
  }

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

async function clickIfVisible(locator: ReturnType<import("playwright").Page["locator"]>, label: string, logger: Logger) {
  const visible = await locator.isVisible().catch(() => false);
  if (!visible) return false;
  logger.log("info", "session.click", { label });
  await locator.click().catch(() => undefined);
  return true;
}

async function readControllerInfo(page: import("playwright").Page) {
  try {
    await page.waitForFunction(() => (globalThis as any).controller, { timeout: 5000 });
  } catch {
    // ignore if controller never appears
  }
  try {
    const info = await page.evaluate(() => {
      const controller = (globalThis as any).controller;
      if (!controller) return null;
      let rpcUrl: string | null = null;
      let chainId: string | null = null;
      const rpcValue = controller.rpcUrl;
      const chainValue = controller.chainId;
      rpcUrl = typeof rpcValue === "function" ? rpcValue() : rpcValue ?? null;
      chainId = typeof chainValue === "function" ? chainValue() : chainValue ?? null;
      return { rpcUrl, chainId };
    });
    if (!info) return null;
    return {
      rpcUrl: info.rpcUrl ?? undefined,
      chainId: info.chainId ?? undefined
    };
  } catch {
    return null;
  }
}

export async function ensureSession(config: RunnerConfig, logger: Logger): Promise<BurnerSession> {
  const wantsMainnet = !config.safety.blockIfNotPractice || config.chain.rpcWriteUrl.includes("/mainnet/");
  logger.log("info", "session.mode", { wantsMainnet, rpcWriteUrl: config.chain.rpcWriteUrl });
  const existing = loadSession(config);
  const controllerAddress = config.session.controllerAddress?.trim();
  const shouldUseController = wantsMainnet && config.session.useControllerAddress && !!controllerAddress;
  const existingIsKatana = existing?.rpcUrl?.includes("/katana");
  const existingIsMainnetPlay =
    !!existing &&
    existing.playUrl.includes("/play") &&
    !existing.playUrl.includes("mode=practice");
  if (existing && shouldUseController && existing.address.toLowerCase() !== controllerAddress!.toLowerCase()) {
    const patched: BurnerSession = { ...existing, address: controllerAddress! };
    saveSession(config, patched);
    logger.log("info", "session.override_address", { burner: existing.address, controller: controllerAddress });
    return patched;
  }
  if (wantsMainnet && existingIsMainnetPlay) {
    logger.log("info", "session.reuse", { adventurerId: existing.adventurerId });
    return existing;
  }
  if (existing?.rpcUrl && (!existingIsKatana || existing.gameContract) && (!wantsMainnet || !existingIsKatana)) {
    logger.log("info", "session.reuse", { adventurerId: existing.adventurerId });
    return existing;
  }
  if (existing && !config.session.autoLogin) {
    logger.log("info", "session.reuse", { adventurerId: existing.adventurerId });
    return existing;
  }
  if (existing && !existing.rpcUrl) {
    logger.log("info", "session.refresh", { reason: "missing rpc url", adventurerId: existing.adventurerId });
  } else if (!wantsMainnet && existingIsKatana && !existing?.gameContract) {
    logger.log("info", "session.refresh", { reason: "missing game contract", adventurerId: existing?.adventurerId });
  } else if (wantsMainnet && existingIsKatana) {
    logger.log("info", "session.refresh", { reason: "switching to mainnet", adventurerId: existing?.adventurerId });
  }

  const client = new PlaywrightClient(config, logger);
  await client.start();

  try {
    const page = client.getPage();
    const context = page.context();
    const rpcUrlHints = new Set<string>();
    let gameContractHint: string | undefined;
    const onRequest = (req: import("playwright").Request) => {
      const hint = extractRpcUrl(req.url());
      if (hint) rpcUrlHints.add(hint);
      const postData = req.postData();
      if (postData) {
        const gameHint = extractGameContractHint(postData);
        if (gameHint) gameContractHint = gameHint;
      }
    };
    const attachedPages = new Set<import("playwright").Page>();
    const attach = (p: import("playwright").Page) => {
      if (attachedPages.has(p)) return;
      attachedPages.add(p);
      p.on("request", onRequest);
    };
    context.pages().forEach(attach);
    context.on("page", attach);

    await page.waitForLoadState("domcontentloaded").catch(() => undefined);

    const practiceButton = page.getByText("PRACTICE FOR FREE", { exact: false });
    const myGamesButton = page.getByText("MY GAMES", { exact: false });
    const playButton = page.getByText("PLAY", { exact: false });
    const loginButton = page.getByText("LOG IN", { exact: false });
    const continueButton = page.getByText("CONTINUE", { exact: false });
    const buyGameButton = page.getByText("BUY GAME", { exact: false });

    let playPage: import("playwright").Page | null = null;
    if (wantsMainnet) {
      const deadline = Date.now() + 30 * 60 * 1000;
      let lastNudgeAt = 0;
      let noGamesLogged = false;
      while (!playPage && Date.now() < deadline) {
        const now = Date.now();
        if (now - lastNudgeAt >= 4000) {
          await clickIfVisible(myGamesButton, "my_games", logger);
          await clickIfVisible(continueButton, "continue", logger);
          await clickIfVisible(playButton, "play", logger);
          await clickIfVisible(loginButton, "login", logger);
          await attemptCartridgeLogin(client, config, logger).catch(() => false);
          lastNudgeAt = now;
        }

        const buyVisible = await buyGameButton.isVisible().catch(() => false);
        if (buyVisible && !noGamesLogged) {
          noGamesLogged = true;
          logger.log("warn", "session.no_games", {
            hint: "Buy Game required for mainnet runs. Waiting for manual purchase."
          });
        }
        if (!buyVisible && noGamesLogged) {
          noGamesLogged = false;
          logger.log("info", "session.game_ticket_detected", {});
        }

        playPage = await waitForPlayPage(client, 1200);
        if (playPage && playPage.url().includes("mode=practice")) {
          logger.log("warn", "session.practice_detected", { url: playPage.url() });
          playPage = null;
        }
        if (!playPage) {
          await sleep(500);
        }
      }
    } else {
      for (let attempt = 0; attempt < 3 && !playPage; attempt += 1) {
        logger.log("info", "session.attempt", { attempt });
        await clickIfVisible(practiceButton, "practice", logger);
        await clickIfVisible(loginButton, "login", logger);

        await sleep(1500);
        for (let i = 0; i < 10; i += 1) {
          const didLogin = await attemptCartridgeLogin(client, config, logger);
          if (didLogin) break;
          await sleep(1000);
        }

        playPage = await waitForPlayPage(client, 25000);
      }
    }

    if (!playPage) {
      await logOpenPages(client, logger);
      throw new Error(wantsMainnet ? "Failed to enter mainnet play URL" : "Failed to enter practice play URL");
    }
    await playPage.waitForLoadState("domcontentloaded").catch(() => undefined);
    const hintDeadline = Date.now() + 6000;
    while (!gameContractHint && Date.now() < hintDeadline) {
      await sleep(500);
    }

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
    const burnerGameContract =
      (burner as { gameContract?: string; game_contract?: string }).gameContract ??
      (burner as { gameContract?: string; game_contract?: string }).game_contract;
    if (burnerGameContract) {
      gameContractHint = burnerGameContract;
    }

    const controllerInfo = await readControllerInfo(playPage);
    const rpcUrlFromNetwork = pickRpcUrl(rpcUrlHints);
    const rpcUrl =
      controllerInfo?.rpcUrl ??
      rpcUrlFromNetwork ??
      (burner as { rpcUrl?: string; rpc_url?: string }).rpcUrl ??
      (burner as { rpcUrl?: string; rpc_url?: string }).rpc_url;
    const chainId =
      controllerInfo?.chainId ??
      (burner as { chainId?: string; chain_id?: string }).chainId ??
      (burner as { chainId?: string; chain_id?: string }).chain_id;

    let address = burner.address;
    if (shouldUseController && controllerAddress) {
      if (controllerAddress.toLowerCase() !== burner.address.toLowerCase()) {
        logger.log("info", "session.override_address", { burner: burner.address, controller: controllerAddress });
      }
      address = controllerAddress;
    }

    const session: BurnerSession = {
      address,
      privateKey: burner.privateKey,
      adventurerId,
      playUrl,
      createdAt: new Date().toISOString(),
      rpcUrl: rpcUrl || undefined,
      chainId: chainId || undefined,
      gameContract: gameContractHint || undefined
    };

    saveSession(config, session);
    logger.log("info", "session.saved", { adventurerId, playUrl });
    return session;
  } finally {
    await client.stop();
  }
}
