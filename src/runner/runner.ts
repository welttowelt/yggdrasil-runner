import { RunnerConfig } from "../config/schema.js";
import { decideNextAction } from "../decision/policy.js";
import { Logger } from "../utils/logger.js";
import { sleep } from "../utils/time.js";
import { PlaywrightClient } from "../ui/playwrightClient.js";
import { Action, GameState } from "./types.js";

function stateHash(state: GameState): string {
  const core = {
    phase: state.phase,
    level: state.level,
    hp: state.hp,
    maxHp: state.maxHp,
    gold: state.gold,
    enemy: state.enemy,
    actions: state.availableActions
  };
  return JSON.stringify(core);
}

function actionToSelectorKey(action: Action): string | null {
  switch (action.type) {
    case "startPractice":
      return "practiceStart";
    case "continue":
      return "continue";
    case "explore":
      return "explore";
    case "fight":
      return "fight";
    case "flee":
      return "flee";
    case "drinkPotion":
      return "drinkPotion";
    case "market":
      return "market";
    case "buyPotion":
      return "buyPotion";
    case "closeOverlay":
      return "closeOverlay";
    default:
      return null;
  }
}

export class Runner {
  private config: RunnerConfig;
  private logger: Logger;
  private ui: PlaywrightClient;
  private lastStateHash: string | null = null;
  private lastStateAt = 0;
  private lastChangeAt = 0;
  private consecutiveFailures = 0;
  private lastLevel: number | null = null;
  private maxLevel: number | null = null;
  private pendingSince: number | null = null;

  constructor(config: RunnerConfig, logger: Logger, ui: PlaywrightClient) {
    this.config = config;
    this.logger = logger;
    this.ui = ui;
  }

  async start() {
    await this.ui.start();
    this.logger.log("info", "runner.start", { url: this.config.app.url });
    await this.loop();
  }

  private async loop() {
    while (true) {
      await this.step();
      await sleep(350);
    }
  }

  private async step() {
    try {
      const state = await this.ui.readState();
      this.updateStateTracking(state);

      if (await this.handleSafety(state)) {
        await sleep(1000);
        return;
      }

      if (await this.handleRecovery(state)) {
        await sleep(1000);
        return;
      }

      const action = decideNextAction(state, this.config);
      await this.executeAction(action);
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures += 1;
      this.logger.log("error", "runner.step_error", { error: String(error), consecutiveFailures: this.consecutiveFailures });

      if (this.config.app.screenshotOnError) {
        await this.ui.screenshot("step-error");
      }

      if (this.consecutiveFailures >= this.config.recovery.maxConsecutiveFailures) {
        this.logger.log("warn", "runner.restart_browser", { reason: "consecutive failures" });
        await this.ui.stop();
        await this.ui.start();
        this.consecutiveFailures = 0;
      } else {
        await this.ui.reloadIfAllowed();
      }
    }
  }

  private updateStateTracking(state: GameState) {
    const now = Date.now();
    const hash = stateHash(state);
    if (hash !== this.lastStateHash) {
      this.lastStateHash = hash;
      this.lastChangeAt = now;
    }
    this.lastStateAt = now;

    if (state.level != null) {
      if (this.lastLevel == null || state.level > this.lastLevel) {
        this.logger.milestone("level_up", { level: state.level });
        this.lastLevel = state.level;
      }
      if (this.maxLevel == null || state.level > this.maxLevel) {
        this.maxLevel = state.level;
        this.logger.milestone("new_max_level", { level: state.level });
      }
      if (state.level >= this.config.policy.targetLevel) {
        this.logger.milestone("target_level_reached", { level: state.level });
      }
    }
  }

  private async handleSafety(state: GameState): Promise<boolean> {
    if (this.config.safety.blockIfNotPractice && state.flags.practiceMode === false) {
      this.logger.log("warn", "safety.not_practice", { practiceMode: state.flags.practiceMode });
      return true;
    }

    if (this.config.safety.blockOnWalletUI && state.flags.walletUi) {
      this.logger.log("warn", "safety.wallet_ui_detected", {});
      return true;
    }

    if (this.config.safety.blockOnPendingTx && state.flags.pendingTx) {
      if (!this.pendingSince) {
        this.pendingSince = Date.now();
      }
      const pendingMs = Date.now() - this.pendingSince;
      this.logger.log("warn", "safety.pending_tx", { pendingMs });
      if (pendingMs > this.config.recovery.uiFreezeMs) {
        await this.ui.reloadIfAllowed();
      }
      return true;
    }

    this.pendingSince = null;
    return false;
  }

  private async handleRecovery(state: GameState): Promise<boolean> {
    const now = Date.now();
    if (state.flags.overlay) {
      const closed = await this.ui.recoverFromOverlay();
      if (closed) return true;
    }

    const idleMs = now - this.lastChangeAt;
    if (idleMs > this.config.recovery.staleStateMs) {
      this.logger.log("warn", "recovery.stale_state", { idleMs });
      const reloaded = await this.ui.reloadIfAllowed();
      return reloaded;
    }

    const freezeMs = now - this.lastStateAt;
    if (freezeMs > this.config.recovery.uiFreezeMs) {
      this.logger.log("warn", "recovery.ui_freeze", { freezeMs });
      const reloaded = await this.ui.reloadIfAllowed();
      return reloaded;
    }

    return false;
  }

  private async executeAction(action: Action) {
    if (action.type === "wait") {
      this.logger.log("info", "action.wait", { reason: action.reason });
      await sleep(1000);
      return;
    }

    if (action.type === "reload") {
      this.logger.log("info", "action.reload", { reason: action.reason });
      await this.ui.reloadIfAllowed();
      return;
    }

    const selectorKey = actionToSelectorKey(action);
    if (!selectorKey) {
      this.logger.log("warn", "action.no_selector", { action: action.type, reason: action.reason });
      return;
    }

    this.logger.log("info", "action.execute", { action: action.type, reason: action.reason });
    await this.ui.clickAction(selectorKey, action.selectorOverride);
    await sleep(250);
  }
}
