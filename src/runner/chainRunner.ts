import { ChainClient } from "../chain/client.js";
import { deriveState } from "../chain/state.js";
import { RunnerConfig } from "../config/schema.js";
import { decideChainAction } from "../decision/chainPolicy.js";
import { ensureSession } from "../session/bootstrap.js";
import { Logger } from "../utils/logger.js";
import { sleep } from "../utils/time.js";

export class ChainRunner {
  private config: RunnerConfig;
  private logger: Logger;
  private lastXp: number | null = null;
  private lastActionCount: number | null = null;
  private lastBagHash: string | null = null;
  private consecutiveFailures = 0;
  private client: ChainClient | null = null;
  private adventurerId: number | null = null;

  constructor(config: RunnerConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  async start() {
    await this.bootstrapSession();
    while (true) {
      if (!this.client || this.adventurerId == null) {
        await this.bootstrapSession();
      }
      await this.step(this.client!, this.adventurerId!);
      await sleep(500);
    }
  }

  private async bootstrapSession() {
    const session = await ensureSession(this.config, this.logger);
    if (this.config.safety.blockIfNotPractice && !session.playUrl.includes("mode=practice")) {
      throw new Error(`Session is not in practice mode: ${session.playUrl}`);
    }

    this.client = await ChainClient.init(this.config, session);
    this.adventurerId = session.adventurerId;

    this.logger.log("info", "chain.start", {
      adventurerId: session.adventurerId,
      address: session.address
    });

    try {
      this.logger.log("info", "chain.start_game", { weaponId: this.config.policy.startingWeaponId });
      const tx = await this.client.startGame(session.adventurerId, this.config.policy.startingWeaponId);
      if (tx?.transaction_hash) {
        await this.client.waitForTx(tx.transaction_hash);
      }
    } catch (error) {
      this.logger.log("warn", "chain.start_game_failed", { error: String(error) });
    }
  }

  private async step(client: ChainClient, adventurerId: number) {
    try {
      const rawState = await client.getGameState(adventurerId);
      const state = deriveState(this.config, adventurerId, rawState);
      this.trackMilestones(state);

      const action = decideChainAction(state, this.config);
      await this.executeAction(client, adventurerId, action, state);
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures += 1;
      this.logger.log("error", "chain.step_error", {
        error: String(error),
        consecutiveFailures: this.consecutiveFailures
      });
      if (this.consecutiveFailures >= this.config.recovery.maxConsecutiveFailures) {
        this.logger.log("warn", "chain.rebootstrap", { reason: "too many failures" });
        this.consecutiveFailures = 0;
        await this.bootstrapSession();
      }
      await sleep(1500);
    }
  }

  private trackMilestones(state: ReturnType<typeof deriveState>) {
    if (this.lastXp == null || state.xp > this.lastXp) {
      this.logger.milestone("xp_gain", { xp: state.xp, hp: state.hp });
      this.lastXp = state.xp;
    }
    if (this.lastActionCount == null || state.actionCount > this.lastActionCount) {
      this.logger.milestone("action_count", { actionCount: state.actionCount });
      this.lastActionCount = state.actionCount;
    }
  }

  private async executeAction(client: ChainClient, adventurerId: number, action: any, state: any) {
    switch (action.type) {
      case "selectStats": {
        this.logger.log("info", "action.select_stats", { reason: action.reason });
        const tx = await client.selectStatUpgrades(adventurerId, action.payload.stats);
        await client.waitForTx(tx.transaction_hash);
        return;
      }
      case "equip": {
        const bagHash = JSON.stringify(action.payload.items);
        if (this.lastBagHash === bagHash) {
          return;
        }
        this.lastBagHash = bagHash;
        this.logger.log("info", "action.equip", { items: action.payload.items });
        const tx = await client.equip(adventurerId, action.payload.items);
        await client.waitForTx(tx.transaction_hash);
        return;
      }
      case "buyPotions": {
        this.logger.log("info", "action.buy_potions", { count: action.payload.count });
        const tx = await client.buyItems(adventurerId, action.payload.count, []);
        await client.waitForTx(tx.transaction_hash);
        return;
      }
      case "flee": {
        this.logger.log("info", "action.flee", { reason: action.reason });
        const tx = await client.flee(adventurerId, false);
        await client.waitForTx(tx.transaction_hash);
        return;
      }
      case "attack": {
        this.logger.log("info", "action.attack", { reason: action.reason, beast: state.beast });
        const tx = await client.attack(adventurerId, false);
        await client.waitForTx(tx.transaction_hash);
        return;
      }
      case "explore": {
        this.logger.log("info", "action.explore", { reason: action.reason, tillBeast: action.payload.tillBeast });
        const tx = await client.explore(adventurerId, action.payload.tillBeast);
        await client.waitForTx(tx.transaction_hash);
        return;
      }
      case "wait":
      default:
        await sleep(1000);
        return;
    }
  }
}
