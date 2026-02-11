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
  private lastEquipHash: string | null = null;
  private lastProgressAt = 0;
  private lastHp: number | null = null;
  private lastDeathHandledAt = 0;
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
    this.lastProgressAt = Date.now();

    this.logger.log("info", "chain.start", {
      adventurerId: session.adventurerId,
      address: session.address
    });

    try {
      this.logger.log("info", "chain.start_game", { weaponId: this.config.policy.startingWeaponId });
      const tx = await this.client.startGame(session.adventurerId, this.config.policy.startingWeaponId);
      if (tx?.transaction_hash) {
        await this.waitForTx(this.client, tx.transaction_hash);
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

      if (this.handleDeath(state)) {
        return;
      }

      if (this.lastProgressAt && Date.now() - this.lastProgressAt > this.config.recovery.staleStateMs) {
        this.logger.log("warn", "chain.stale_progress", {
          lastProgressAt: this.lastProgressAt,
          actionCount: state.actionCount,
          xp: state.xp
        });
        await this.bootstrapSession();
        return;
      }

      const lootIds = [
        ...state.bagItems.map((item) => item.id),
        ...state.market,
        ...Object.values(state.equipment)
          .filter((item): item is { id: number; xp: number } => !!item)
          .map((item) => item.id)
      ];

      let lootMeta: Record<number, { id: number; tier: number; slot: string; itemType: string }> = {};
      try {
        lootMeta = await client.getLootMetaBatch(lootIds);
      } catch (error) {
        this.logger.log("warn", "chain.loot_meta_failed", { error: String(error) });
      }

      const action = decideChainAction(state, this.config, lootMeta);
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
      this.logger.milestone("xp_gain", { xp: state.xp, level: state.level, hp: state.hp });
      this.lastXp = state.xp;
      this.lastProgressAt = Date.now();
    }
    if (this.lastActionCount == null || state.actionCount > this.lastActionCount) {
      this.logger.milestone("action_count", { actionCount: state.actionCount });
      this.lastActionCount = state.actionCount;
      this.lastProgressAt = Date.now();
    }
    if (this.lastHp != null && this.lastHp > 0 && state.hp <= 0) {
      this.logger.milestone("run_end", { level: state.level, xp: state.xp, actionCount: state.actionCount });
    }
    this.lastHp = state.hp;
  }

  private handleDeath(state: ReturnType<typeof deriveState>) {
    if (state.hp > 0) return false;
    const now = Date.now();
    if (now - this.lastDeathHandledAt < this.config.recovery.deathCooldownMs) {
      return true;
    }
    this.lastDeathHandledAt = now;
    this.logger.log("warn", "chain.dead", { xp: state.xp, actionCount: state.actionCount });
    return false;
  }

  private async waitForTx(client: ChainClient, txHash: string) {
    const waitPromise = client.waitForTx(
      txHash,
      this.config.chain.txWaitRetries,
      this.config.chain.txWaitIntervalMs
    );
    const timeoutPromise = sleep(this.config.chain.txTimeoutMs).then(() => null);
    const result = await Promise.race([waitPromise, timeoutPromise]);
    if (!result) {
      throw new Error(`Transaction timeout after ${this.config.chain.txTimeoutMs}ms`);
    }
    return result;
  }

  private async executeAction(client: ChainClient, adventurerId: number, action: any, state: any) {
    switch (action.type) {
      case "startGame": {
        this.logger.log("info", "action.start_game", { reason: action.reason });
        try {
          const tx = await client.startGame(adventurerId, this.config.policy.startingWeaponId);
          if (tx?.transaction_hash) {
            await this.waitForTx(client, tx.transaction_hash);
          }
        } catch (error) {
          this.logger.log("warn", "action.start_game_failed", { error: String(error) });
          throw error;
        }
        return;
      }
      case "selectStats": {
        this.logger.log("info", "action.select_stats", { reason: action.reason });
        const tx = await client.selectStatUpgrades(adventurerId, action.payload.stats);
        await this.waitForTx(client, tx.transaction_hash);
        return;
      }
      case "equip": {
        const equipHash = JSON.stringify(action.payload.items);
        if (this.lastEquipHash === equipHash) {
          return;
        }
        this.lastEquipHash = equipHash;
        this.logger.log("info", "action.equip", { items: action.payload.items });
        const tx = await client.equip(adventurerId, action.payload.items);
        await this.waitForTx(client, tx.transaction_hash);
        return;
      }
      case "buyPotions": {
        this.logger.log("info", "action.buy_potions", { count: action.payload.count });
        const tx = await client.buyItems(adventurerId, action.payload.count, []);
        await this.waitForTx(client, tx.transaction_hash);
        return;
      }
      case "buyItems": {
        this.logger.log("info", "action.buy_items", { items: action.payload.items });
        const tx = await client.buyItems(adventurerId, action.payload.potions ?? 0, action.payload.items);
        await this.waitForTx(client, tx.transaction_hash);
        return;
      }
      case "flee": {
        this.logger.log("info", "action.flee", { reason: action.reason });
        const tx = await client.flee(adventurerId, false);
        await this.waitForTx(client, tx.transaction_hash);
        return;
      }
      case "attack": {
        this.logger.log("info", "action.attack", { reason: action.reason, beast: state.beast });
        const tx = await client.attack(adventurerId, false);
        await this.waitForTx(client, tx.transaction_hash);
        return;
      }
      case "explore": {
        this.logger.log("info", "action.explore", { reason: action.reason, tillBeast: action.payload.tillBeast });
        const tx = await client.explore(adventurerId, action.payload.tillBeast);
        await this.waitForTx(client, tx.transaction_hash);
        return;
      }
      case "wait":
      default:
        await sleep(1000);
        return;
    }
  }
}
