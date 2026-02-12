import { ChainClient } from "../chain/client.js";
import { ControllerExecutor } from "../chain/controllerExecutor.js";
import { deriveState } from "../chain/state.js";
import { RunnerConfig } from "../config/schema.js";
import { decideChainAction } from "../decision/chainPolicy.js";
import { ensureSession } from "../session/bootstrap.js";
import { BurnerSession, saveSession } from "../session/session.js";
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
  private writer: ChainClient | ControllerExecutor | null = null;
  private adventurerId: number | null = null;
  private activeSession: BurnerSession | null = null;
  private statUpgradeBlockedUntil = 0;
  private statUpgradeBlockedActionCount: number | null = null;
  private marketClosedBlockedUntil = 0;
  private marketClosedBlockedActionCount: number | null = null;
  private marketWindowActionCount: number | null = null;
  private marketWindowUntil = 0;
  private staleRecoveryAttempts = 0;
  private vrfPendingBlockedUntil = 0;
  private vrfPendingBlockedActionCount: number | null = null;
  private vrfPendingAttempts = 0;
  private vrfPendingSince = 0;
  private vrfCircuitBreakUntil = 0;
  private lastVrfWaitLogAt = 0;

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
    let resolvedSession = session;
    this.activeSession = session;
    if (this.config.safety.blockIfNotPractice && !session.playUrl.includes("mode=practice")) {
      throw new Error(`Session is not in practice mode: ${session.playUrl}`);
    }

    this.client = await ChainClient.init(this.config, session);
    await this.writerStop();
    if (this.useControllerWriter()) {
      const controllerWriter = new ControllerExecutor(this.config, this.logger);
      await controllerWriter.start(session);
      const liveAdventurerId = controllerWriter.getCurrentAdventurerId();
      if (liveAdventurerId && liveAdventurerId !== session.adventurerId) {
        const livePlayUrl = controllerWriter.getCurrentPlayUrl() ?? session.playUrl;
        resolvedSession = { ...session, adventurerId: liveAdventurerId, playUrl: livePlayUrl };
        this.activeSession = resolvedSession;
        saveSession(this.config, resolvedSession);
        this.logger.log("info", "session.sync_adventurer", {
          from: session.adventurerId,
          to: liveAdventurerId,
          playUrl: livePlayUrl
        });
      }
      this.writer = controllerWriter;
    } else {
      this.writer = this.client;
    }
    this.adventurerId = resolvedSession.adventurerId;
    this.lastProgressAt = Date.now();

    this.logger.log("info", "chain.start", {
      adventurerId: resolvedSession.adventurerId,
      address: resolvedSession.address
    });

    if (this.config.chain.autoDeployAccount) {
      try {
        const deployResult = await this.client.ensureAccountDeployed();
        if (deployResult.transactionHash) {
          this.logger.log("info", "chain.account_deploy", { tx: deployResult.transactionHash });
          await this.waitForTx(this.client, deployResult.transactionHash);
        }
      } catch (error) {
        this.logger.log("warn", "chain.account_deploy_failed", { error: String(error) });
      }
    }

    try {
      let shouldStartGame = true;
      try {
        const preStateRaw = await this.client.getGameState(resolvedSession.adventurerId);
        const preState = deriveState(this.config, resolvedSession.adventurerId, preStateRaw);
        if (preState.hp > 0) {
          shouldStartGame = false;
          this.logger.log("info", "chain.start_game_skip", {
            reason: "adventurer_already_alive",
            hp: preState.hp,
            level: preState.level,
            actionCount: preState.actionCount,
            xp: preState.xp
          });
        }
      } catch (error) {
        this.logger.log("warn", "chain.start_game_precheck_failed", { error: String(error) });
      }

      if (shouldStartGame) {
        this.logger.log("info", "chain.start_game", { weaponId: this.config.policy.startingWeaponId });
        const tx = await this.getWriter().startGame(resolvedSession.adventurerId, this.config.policy.startingWeaponId);
        if (tx?.transaction_hash) {
          await this.waitForTx(this.client, tx.transaction_hash);
        }
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

      this.syncMarketWindow(state);

      if (
        this.statUpgradeBlockedActionCount != null &&
        state.actionCount > this.statUpgradeBlockedActionCount
      ) {
        this.clearStatUpgradeBlock();
      }
      if (
        this.marketClosedBlockedActionCount != null &&
        state.actionCount > this.marketClosedBlockedActionCount
      ) {
        this.clearMarketClosedBlock();
      }
      if (this.vrfPendingBlockedActionCount != null && state.actionCount > this.vrfPendingBlockedActionCount) {
        this.clearVrfPendingBlock();
      }

      if (this.handleDeath(state)) {
        return;
      }

      if (this.shouldPauseForVrfCircuit(state)) {
        this.lastProgressAt = Date.now();
        if (Date.now() - this.lastVrfWaitLogAt >= 10_000) {
          this.lastVrfWaitLogAt = Date.now();
          this.logger.log("warn", "chain.wait_vrf_circuit", {
            actionCount: state.actionCount,
            attempts: this.vrfPendingAttempts,
            blockedUntil: this.vrfCircuitBreakUntil
          });
        }
        await sleep(1_500);
        return;
      }

      if (this.shouldWaitForVrf(state)) {
        this.lastProgressAt = Date.now();
        if (Date.now() - this.lastVrfWaitLogAt >= 2_000) {
          this.lastVrfWaitLogAt = Date.now();
          this.logger.log("info", "chain.wait_vrf", {
            actionCount: state.actionCount,
            blockedUntil: this.vrfPendingBlockedUntil
          });
        }
        await sleep(900);
        return;
      }

      if (this.lastProgressAt && Date.now() - this.lastProgressAt > this.config.recovery.staleStateMs) {
        this.logger.log("warn", "chain.stale_progress", {
          lastProgressAt: this.lastProgressAt,
          actionCount: state.actionCount,
          xp: state.xp
        });
        const recovered = await this.tryRecoverAfterStall(adventurerId);
        if (recovered) {
          this.staleRecoveryAttempts += 1;
          if (this.staleRecoveryAttempts <= 2) {
            return;
          }
          this.logger.log("warn", "chain.stale_recovery_exhausted", {
            attempts: this.staleRecoveryAttempts
          });
        }
        this.staleRecoveryAttempts = 0;
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

      const marketWindowActive = this.isMarketWindowActive(state);
      const policyState =
        this.shouldBlockSelectStats(state)
          ? {
              ...state,
              statUpgrades: 0,
              market: this.shouldBlockMarketClosed(state) ? [] : state.market
            }
          : this.shouldBlockMarketClosed(state)
            ? { ...state, market: [] }
          : state;

      const marketFilteredState = marketWindowActive ? policyState : { ...policyState, market: [] };
      const action = decideChainAction(marketFilteredState, this.config, lootMeta);
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
      this.staleRecoveryAttempts = 0;
    }
    if (this.lastActionCount == null || state.actionCount > this.lastActionCount) {
      this.logger.milestone("action_count", { actionCount: state.actionCount });
      this.lastActionCount = state.actionCount;
      this.lastProgressAt = Date.now();
      this.staleRecoveryAttempts = 0;
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
    const executionStatus = this.extractExecutionStatus(result);
    if (executionStatus?.toUpperCase().includes("REVERT")) {
      const reason = this.extractRevertReason(result);
      const suffix = reason ? `: ${reason}` : "";
      throw new Error(`Transaction reverted (${txHash})${suffix}`);
    }
    return result;
  }

  private async callWriterWithTimeout<T>(
    adventurerId: number,
    action: string,
    fn: () => Promise<T>
  ): Promise<T | null> {
    const timeoutMs = Math.max(12_000, this.config.recovery.actionTimeoutMs + 10_000);
    const result = await Promise.race([
      fn()
        .then((value) => ({ ok: true as const, value }))
        .catch((error) => ({ ok: false as const, error })),
      sleep(timeoutMs).then(() => ({ ok: false as const, error: new Error(`action_timeout:${action}`) }))
    ]);
    if (result.ok) {
      return result.value;
    }
    const message = String((result as { error: unknown }).error ?? "");
    if (message.includes("action_timeout:")) {
      this.logger.log("warn", "chain.action_timeout", { action, timeoutMs });
      await this.tryRecoverAfterStall(adventurerId, `action_timeout:${action}`);
      return null;
    }
    throw (result as { error: unknown }).error;
  }

  private async executeAction(client: ChainClient, adventurerId: number, action: any, state: any) {
    const writer = this.getWriter();
    switch (action.type) {
      case "startGame": {
        this.logger.log("info", "action.start_game", { reason: action.reason });
        try {
          const tx = await this.callWriterWithTimeout(adventurerId, "start_game", () =>
            writer.startGame(adventurerId, this.config.policy.startingWeaponId)
          );
          if (!tx) return;
          if (tx?.transaction_hash) {
            await this.waitForTx(client, tx.transaction_hash);
            this.markWriteProgress("startGame", tx.transaction_hash);
          }
        } catch (error) {
          this.logger.log("warn", "action.start_game_failed", { error: String(error) });
          throw error;
        }
        return;
      }
      case "selectStats": {
        this.logger.log("info", "action.select_stats", { reason: action.reason });
        try {
          const tx = await this.callWriterWithTimeout(adventurerId, "select_stat_upgrades", () =>
            writer.selectStatUpgrades(adventurerId, action.payload.stats)
          );
          if (!tx) return;
          if (!tx?.transaction_hash) {
            this.blockStatUpgrade(state.actionCount, "no_tx_hash_after_select_stats");
            this.logger.log("warn", "action.select_stats_no_tx_hash", { reason: "controller_refresh_or_market_closed" });
            return;
          }
          await this.waitForTx(client, this.requireTxHash(tx, "selectStats"));
          this.markWriteProgress("selectStats", tx.transaction_hash);
          this.clearStatUpgradeBlock();
          this.clearMarketClosedBlock();
        } catch (error) {
          if (this.isVrfPendingError(error)) {
            this.blockVrfPending(state.actionCount, "vrf_not_fulfilled_select_stats");
            await this.maybeResyncAfterVrfPending(adventurerId, state.actionCount);
            this.logger.log("warn", "action.select_stats_vrf_pending", {
              actionCount: state.actionCount
            });
            return;
          }
          if (this.isMarketClosedError(error)) {
            this.blockStatUpgrade(state.actionCount, "market_closed");
            this.blockMarketClosed(state.actionCount, "market_closed_select_stats");
            this.logger.log("warn", "action.select_stats_market_closed", {
              actionCount: state.actionCount
            });
            return;
          }
          throw error;
        }
        return;
      }
      case "equip": {
        const equipHash = JSON.stringify(action.payload.items);
        if (this.lastEquipHash === equipHash) {
          return;
        }
        this.lastEquipHash = equipHash;
        this.logger.log("info", "action.equip", { items: action.payload.items });
        const tx = await this.callWriterWithTimeout(adventurerId, "equip", () =>
          writer.equip(adventurerId, action.payload.items)
        );
        if (!tx) return;
        if (!tx?.transaction_hash) {
          this.logger.log("warn", "action.equip_no_tx_hash", { reason: "controller_refresh_or_ui_resync" });
          return;
        }
        await this.waitForTx(client, this.requireTxHash(tx, "equip"));
        this.markWriteProgress("equip", tx.transaction_hash);
        return;
      }
      case "buyPotions": {
        this.logger.log("info", "action.buy_potions", { count: action.payload.count });
        try {
          const tx = await this.callWriterWithTimeout(adventurerId, "buy_items_potions", () =>
            writer.buyItems(adventurerId, action.payload.count, [])
          );
          if (!tx) return;
          if (!tx?.transaction_hash) {
            this.logger.log("warn", "action.buy_potions_no_tx_hash", { reason: "controller_refresh_or_ui_resync" });
            return;
          }
          await this.waitForTx(client, this.requireTxHash(tx, "buyPotions"));
          this.markWriteProgress("buyPotions", tx.transaction_hash);
          this.clearMarketClosedBlock();
        } catch (error) {
          if (this.isMarketClosedError(error)) {
            this.blockMarketClosed(state.actionCount, "market_closed_buy_potions");
            this.logger.log("warn", "action.buy_potions_market_closed", { actionCount: state.actionCount });
            return;
          }
          throw error;
        }
        return;
      }
      case "buyItems": {
        this.logger.log("info", "action.buy_items", { items: action.payload.items });
        try {
          const tx = await this.callWriterWithTimeout(adventurerId, "buy_items", () =>
            writer.buyItems(adventurerId, action.payload.potions ?? 0, action.payload.items)
          );
          if (!tx) return;
          if (!tx?.transaction_hash) {
            this.logger.log("warn", "action.buy_items_no_tx_hash", { reason: "controller_refresh_or_ui_resync" });
            return;
          }
          await this.waitForTx(client, this.requireTxHash(tx, "buyItems"));
          this.markWriteProgress("buyItems", tx.transaction_hash);
          this.clearMarketClosedBlock();
        } catch (error) {
          if (this.isMarketClosedError(error)) {
            this.blockMarketClosed(state.actionCount, "market_closed_buy_items");
            this.logger.log("warn", "action.buy_items_market_closed", { actionCount: state.actionCount });
            return;
          }
          throw error;
        }
        return;
      }
      case "flee": {
        this.logger.log("info", "action.flee", { reason: action.reason });
        try {
          const tx = await this.callWriterWithTimeout(adventurerId, "flee", () => writer.flee(adventurerId, false));
          if (!tx) return;
          if (!tx?.transaction_hash) {
            this.logger.log("warn", "action.flee_no_tx_hash", { reason: "controller_refresh_or_ui_resync" });
            return;
          }
          await this.waitForTx(client, this.requireTxHash(tx, "flee"));
          this.markWriteProgress("flee", tx.transaction_hash);
        } catch (error) {
          if (this.isVrfPendingError(error)) {
            this.blockVrfPending(state.actionCount, "vrf_not_fulfilled_flee");
            await this.maybeResyncAfterVrfPending(adventurerId, state.actionCount);
            this.logger.log("warn", "action.flee_vrf_pending", { actionCount: state.actionCount });
            return;
          }
          if (this.isNotInBattleError(error)) {
            this.logger.log("warn", "action.flee_not_in_battle", { actionCount: state.actionCount });
            await this.tryRecoverAfterStall(adventurerId, "flee_not_in_battle");
            return;
          }
          throw error;
        }
        return;
      }
      case "attack": {
        this.logger.log("info", "action.attack", { reason: action.reason, beast: state.beast });
        try {
          const tx = await this.callWriterWithTimeout(adventurerId, "attack", () => writer.attack(adventurerId, false));
          if (!tx) return;
          if (!tx?.transaction_hash) {
            this.logger.log("warn", "action.attack_no_tx_hash", { reason: "controller_refresh_or_ui_resync" });
            return;
          }
          await this.waitForTx(client, this.requireTxHash(tx, "attack"));
          this.markWriteProgress("attack", tx.transaction_hash);
        } catch (error) {
          if (this.isVrfPendingError(error)) {
            this.blockVrfPending(state.actionCount, "vrf_not_fulfilled_attack");
            await this.maybeResyncAfterVrfPending(adventurerId, state.actionCount);
            this.logger.log("warn", "action.attack_vrf_pending", { actionCount: state.actionCount });
            return;
          }
          if (this.isNotInBattleError(error)) {
            this.logger.log("warn", "action.attack_not_in_battle", { actionCount: state.actionCount });
            await this.tryRecoverAfterStall(adventurerId, "attack_not_in_battle");
            return;
          }
          throw error;
        }
        return;
      }
      case "explore": {
        this.logger.log("info", "action.explore", { reason: action.reason, tillBeast: action.payload.tillBeast });
        try {
          const tx = await this.callWriterWithTimeout(adventurerId, "explore", () =>
            writer.explore(adventurerId, action.payload.tillBeast)
          );
          if (!tx) return;
          if (!tx?.transaction_hash) {
            this.logger.log("warn", "action.explore_no_tx_hash", { reason: "controller_refresh_or_ui_resync" });
            return;
          }
          await this.waitForTx(client, this.requireTxHash(tx, "explore"));
          this.markWriteProgress("explore", tx.transaction_hash);
        } catch (error) {
          if (this.isVrfPendingError(error)) {
            this.blockVrfPending(state.actionCount, "vrf_not_fulfilled_explore");
            await this.maybeResyncAfterVrfPending(adventurerId, state.actionCount);
            this.logger.log("warn", "action.explore_vrf_pending", { actionCount: state.actionCount });
            return;
          }
          throw error;
        }
        return;
      }
      case "wait":
      default:
        await sleep(1000);
        return;
    }
  }

  private useControllerWriter() {
    const wantsMainnet = !this.config.safety.blockIfNotPractice || this.config.chain.rpcWriteUrl.includes("/mainnet/");
    return wantsMainnet && this.config.session.useControllerAddress;
  }

  private getWriter() {
    if (!this.writer) {
      throw new Error("Writer not initialized");
    }
    return this.writer;
  }

  private async writerStop() {
    if (this.writer && this.writer instanceof ControllerExecutor) {
      await this.writer.stop();
    }
    this.writer = null;
  }

  private requireTxHash(tx: { transaction_hash?: string }, action: string) {
    if (!tx.transaction_hash) {
      throw new Error(`Missing transaction hash for action ${action}`);
    }
    return tx.transaction_hash;
  }

  private shouldBlockSelectStats(state: ReturnType<typeof deriveState>) {
    return (
      state.statUpgrades > 0 &&
      this.statUpgradeBlockedActionCount != null &&
      state.actionCount === this.statUpgradeBlockedActionCount &&
      Date.now() < this.statUpgradeBlockedUntil
    );
  }

  private shouldBlockMarketClosed(state: ReturnType<typeof deriveState>) {
    return (
      this.marketClosedBlockedActionCount != null &&
      state.actionCount === this.marketClosedBlockedActionCount &&
      Date.now() < this.marketClosedBlockedUntil
    );
  }

  private blockStatUpgrade(actionCount: number, reason: string) {
    this.statUpgradeBlockedActionCount = actionCount;
    this.statUpgradeBlockedUntil = Date.now() + 60_000;
    this.logger.log("warn", "policy.block_select_stats", {
      reason,
      actionCount,
      blockedForMs: 60_000
    });
  }

  private clearStatUpgradeBlock() {
    if (this.statUpgradeBlockedActionCount == null && this.statUpgradeBlockedUntil === 0) {
      return;
    }
    this.statUpgradeBlockedActionCount = null;
    this.statUpgradeBlockedUntil = 0;
    this.logger.log("info", "policy.unblock_select_stats", {});
  }

  private blockMarketClosed(actionCount: number, reason: string) {
    this.marketClosedBlockedActionCount = actionCount;
    this.marketClosedBlockedUntil = Date.now() + 60_000;
    this.logger.log("warn", "policy.block_market_phase", {
      reason,
      actionCount,
      blockedForMs: 60_000
    });
  }

  private clearMarketClosedBlock() {
    if (this.marketClosedBlockedActionCount == null && this.marketClosedBlockedUntil === 0) {
      return;
    }
    this.marketClosedBlockedActionCount = null;
    this.marketClosedBlockedUntil = 0;
    this.logger.log("info", "policy.unblock_market_phase", {});
  }

  private syncMarketWindow(state: ReturnType<typeof deriveState>) {
    const now = Date.now();
    if (this.marketWindowActionCount != null && state.actionCount !== this.marketWindowActionCount) {
      this.clearMarketWindow("action_count_changed");
    }
    if (state.inCombat) {
      this.clearMarketWindow("combat_started");
    }
    if (this.marketWindowActionCount != null && now > this.marketWindowUntil) {
      this.clearMarketWindow("market_window_timeout");
    }

    if (!state.inCombat && state.statUpgrades > 0) {
      const ttlMs = 5 * 60_000;
      if (this.marketWindowActionCount == null || this.marketWindowActionCount !== state.actionCount) {
        this.marketWindowActionCount = state.actionCount;
        this.marketWindowUntil = now + ttlMs;
        this.logger.log("info", "policy.market_window_open", {
          actionCount: state.actionCount,
          statUpgrades: state.statUpgrades,
          ttlMs
        });
      } else if (now + 60_000 > this.marketWindowUntil) {
        // Extend while still observing upgrades at the same action_count.
        this.marketWindowUntil = now + ttlMs;
      }
    }
  }

  private isMarketWindowActive(state: ReturnType<typeof deriveState>) {
    if (state.inCombat) return false;
    if (this.marketWindowActionCount == null) return false;
    if (state.actionCount !== this.marketWindowActionCount) return false;
    return Date.now() < this.marketWindowUntil;
  }

  private clearMarketWindow(reason: string) {
    if (this.marketWindowActionCount == null && this.marketWindowUntil === 0) return;
    const actionCount = this.marketWindowActionCount;
    this.marketWindowActionCount = null;
    this.marketWindowUntil = 0;
    this.logger.log("info", "policy.market_window_close", { reason, actionCount });
  }

  private isMarketClosedError(error: unknown) {
    return String(error).toLowerCase().includes("market is closed");
  }

  private isNotInBattleError(error: unknown) {
    return String(error).toLowerCase().includes("not in battle");
  }

  private isVrfPendingError(error: unknown) {
    const text = String(error).toLowerCase();
    return text.includes("vrfprovider: not fulfilled") || text.includes("vrf provider: not fulfilled");
  }

  private markWriteProgress(action: string, txHash?: string) {
    this.lastProgressAt = Date.now();
    this.staleRecoveryAttempts = 0;
    this.clearVrfPendingBlock();
    this.logger.log("info", "chain.write_confirmed", { action, txHash });
  }

  private extractExecutionStatus(result: unknown) {
    const receipt = result as Record<string, any>;
    return (
      receipt?.execution_status ??
      receipt?.receipt?.execution_status ??
      receipt?.value?.execution_status ??
      receipt?.value?.receipt?.execution_status ??
      null
    );
  }

  private extractRevertReason(result: unknown) {
    const receipt = result as Record<string, any>;
    const directReason = receipt?.revert_reason ?? receipt?.receipt?.revert_reason;
    if (typeof directReason === "string" && directReason.trim().length > 0) {
      return directReason;
    }
    const directError = receipt?.execution_error ?? receipt?.receipt?.execution_error;
    if (typeof directError === "string" && directError.trim().length > 0) {
      return directError;
    }
    return "";
  }

  private async tryRecoverAfterStall(adventurerId: number, reason = "stale_progress") {
    if (!(this.writer instanceof ControllerExecutor)) {
      return false;
    }
    const recovered = await this.writer.recoverToKnownPlay(adventurerId, this.activeSession?.playUrl);
    if (!recovered) {
      return false;
    }

    const liveAdventurerId = this.writer.getCurrentAdventurerId();
    const livePlayUrl = this.writer.getCurrentPlayUrl();
    if (liveAdventurerId && this.activeSession && liveAdventurerId !== this.activeSession.adventurerId) {
      this.activeSession = {
        ...this.activeSession,
        adventurerId: liveAdventurerId,
        playUrl: livePlayUrl ?? this.activeSession.playUrl
      };
      this.adventurerId = liveAdventurerId;
      saveSession(this.config, this.activeSession);
      this.logger.log("info", "session.sync_adventurer", {
        from: adventurerId,
        to: liveAdventurerId,
        playUrl: this.activeSession.playUrl
      });
    }

    this.lastProgressAt = Date.now();
    this.logger.log("info", "chain.recovered", { reason, adventurerId: this.adventurerId });
    return true;
  }

  private blockVrfPending(actionCount: number, reason: string) {
    const now = Date.now();
    const sameAction = this.vrfPendingBlockedActionCount === actionCount;
    if (!sameAction) {
      this.vrfPendingAttempts = 0;
      this.vrfPendingSince = now;
    }
    this.vrfPendingAttempts += 1;
    this.vrfPendingBlockedActionCount = actionCount;

    const baseMs = 4_000;
    const maxMs = 90_000;
    const backoffMs = Math.min(maxMs, baseMs * 2 ** (this.vrfPendingAttempts - 1));
    this.vrfPendingBlockedUntil = now + backoffMs;
    this.lastProgressAt = Date.now();
    const sinceMs = this.vrfPendingSince ? now - this.vrfPendingSince : 0;
    if (this.vrfPendingAttempts >= 8 && sinceMs >= 5 * 60_000 && now >= this.vrfCircuitBreakUntil) {
      this.vrfCircuitBreakUntil = now + 5 * 60_000;
      this.logger.log("warn", "policy.vrf_circuit_break", {
        actionCount,
        attempts: this.vrfPendingAttempts,
        sinceMs,
        blockedForMs: 5 * 60_000
      });
    }
    this.logger.log("warn", "policy.block_vrf_pending", {
      reason,
      actionCount,
      attempt: this.vrfPendingAttempts,
      blockedForMs: backoffMs,
      sinceMs
    });
  }

  private clearVrfPendingBlock() {
    if (
      this.vrfPendingBlockedActionCount == null &&
      this.vrfPendingBlockedUntil === 0 &&
      this.vrfPendingAttempts === 0
    ) {
      return;
    }
    const attempts = this.vrfPendingAttempts;
    const actionCount = this.vrfPendingBlockedActionCount;
    this.vrfPendingBlockedActionCount = null;
    this.vrfPendingBlockedUntil = 0;
    this.vrfPendingAttempts = 0;
    this.vrfPendingSince = 0;
    this.vrfCircuitBreakUntil = 0;
    this.logger.log("info", "policy.unblock_vrf_pending", { attempts, actionCount });
  }

  private shouldWaitForVrf(state: ReturnType<typeof deriveState>) {
    return (
      this.vrfPendingBlockedActionCount != null &&
      this.vrfPendingBlockedActionCount === state.actionCount &&
      Date.now() < this.vrfPendingBlockedUntil
    );
  }

  private shouldPauseForVrfCircuit(state: ReturnType<typeof deriveState>) {
    return (
      this.vrfPendingBlockedActionCount != null &&
      this.vrfPendingBlockedActionCount === state.actionCount &&
      Date.now() < this.vrfCircuitBreakUntil
    );
  }

  private async maybeResyncAfterVrfPending(adventurerId: number, actionCount: number) {
    if (this.vrfPendingBlockedActionCount !== actionCount) {
      return;
    }
    if (this.vrfPendingAttempts < 4) {
      return;
    }
    if ((this.vrfPendingAttempts - 4) % 3 !== 0) {
      return;
    }
    const sinceMs = this.vrfPendingSince ? Date.now() - this.vrfPendingSince : undefined;
    this.logger.log("warn", "chain.vrf_pending_resync", {
      adventurerId,
      actionCount,
      attempts: this.vrfPendingAttempts,
      sinceMs
    });
    await this.tryRecoverAfterStall(adventurerId, "vrf_pending_resync");
  }
}
