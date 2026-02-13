import { ChainClient } from "../chain/client.js";
import { ControllerExecutor } from "../chain/controllerExecutor.js";
import { deriveState } from "../chain/state.js";
import { computeBattleSalt, computeExploreSalt } from "../chain/vrf.js";
import { RunnerConfig } from "../config/schema.js";
import { decideChainAction } from "../decision/chainPolicy.js";
import { ensureSession } from "../session/bootstrap.js";
import { RunnerSession, saveSession } from "../session/session.js";
import { Logger } from "../utils/logger.js";
import { sampleRangeMs, stableFloatInRange, stableIntInRange } from "../utils/random.js";
import { sleep } from "../utils/time.js";

export class ChainRunner {
  private config: RunnerConfig;
  private logger: Logger;
  private lastXp: number | null = null;
  private lastActionCount: number | null = null;
  private awaitingActionCount: number | null = null;
  private awaitingActionCountSince = 0;
  private awaitingActionLabel: string | null = null;
  private awaitingActionTxHash: string | null = null;
  private lastStateSyncLogAt = 0;
  private lastEquipHash: string | null = null;
  private lastEquipConfirmedActionCount: number | null = null;
  private lastEquipCooldownLogAt = 0;
  private lastProgressAt = 0;
  private lastHp: number | null = null;
  private lastDeathHandledAt = 0;
  private consecutiveFailures = 0;
  private client: ChainClient | null = null;
  private writer: ChainClient | ControllerExecutor | null = null;
  private controller: ControllerExecutor | null = null;
  private adventurerId: number | null = null;
  private activeSession: RunnerSession | null = null;
  private statUpgradeBlockedUntil = 0;
  private statUpgradeBlockedActionCount: number | null = null;
  private marketClosedBlockedUntil = 0;
  private marketClosedBlockedActionCount: number | null = null;
  private staleRecoveryAttempts = 0;
  private vrfPendingBlockedUntil = 0;
  private vrfPendingBlockedActionCount: number | null = null;
  private vrfPendingAttempts = 0;
  private vrfPendingSince = 0;
  private vrfCircuitBreakUntil = 0;
  private lastVrfWaitLogAt = 0;
  private lastVrfAbandonAt = 0;
  private nextHumanBreakAt = 0;
  private nextSleepBreakAt = 0;
  private humanBreakUntil = 0;
  private activeBreakKind: "short" | "sleep" | null = null;
  private lastHumanBreakStartAt = 0;
  private lastHumanBreakLogAt = 0;
  private deferredHumanBreaks = 0;
  private breakStartActionCount: number | null = null;
  private breakStartLevel: number | null = null;
  private stableSleepJitterMs: number | null = null;
  private txAttemptTimestamps: number[] = [];
  private txThrottleLogAt = 0;
  private lastGearReviewAt = 0;
  private lastGearReviewActionCount: number | null = null;
  private lastBagKey: string | null = null;
  private policyNoiseEpoch = 0;
  private policyNoise = { explore: 0, fight: 0, flee: 0 };

  constructor(config: RunnerConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.scheduleNextHumanBreak(Date.now(), "startup");
    this.scheduleNextSleepBreak(Date.now(), "startup");
    this.resamplePolicyNoise("startup");
  }

  private resetRunTracking(reason: string, fromAdventurerId: number | null, toAdventurerId: number) {
    this.lastXp = null;
    this.lastActionCount = null;
    this.lastHp = null;

    this.lastEquipHash = null;
    this.lastEquipConfirmedActionCount = null;
    this.lastEquipCooldownLogAt = 0;

    this.consecutiveFailures = 0;
    this.staleRecoveryAttempts = 0;
    this.lastDeathHandledAt = 0;

    this.clearAwaitingActionCount();
    this.clearStatUpgradeBlock();
    this.clearMarketClosedBlock();
    this.clearVrfPendingBlock();

    this.vrfCircuitBreakUntil = 0;
    this.lastVrfWaitLogAt = 0;
    this.lastVrfAbandonAt = 0;

    this.lastProgressAt = Date.now();
    this.lastStateSyncLogAt = 0;
    this.lastGearReviewAt = 0;
    this.lastGearReviewActionCount = null;
    this.lastBagKey = null;

    this.logger.log("info", "chain.reset_run_tracking", {
      reason,
      fromAdventurerId,
      toAdventurerId
    });
  }

  async start() {
    await this.bootstrapSession();
    while (true) {
      if (!this.client || this.adventurerId == null) {
        await this.bootstrapSession();
      }
      if (await this.maybeSleepDuringHumanBreak()) {
        continue;
      }
      await this.step(this.client!, this.adventurerId!);
      await this.sleepBetweenSteps();
    }
  }

  private async bootstrapSession() {
    const session = await ensureSession(this.config, this.logger);
    let resolvedSession = session;
    this.activeSession = session;
    if (this.config.safety.blockIfNotPractice && !(session.playUrl ?? "").includes("mode=practice")) {
      throw new Error(`Session is not in practice mode: ${session.playUrl}`);
    }

    const useController = this.useControllerWriter();
    this.client = await ChainClient.init(this.config, session, { readOnly: useController });

    // Preserve the controller browser across reboots; closing it mid-flow is disruptive on mainnet.
    if (!useController) {
      await this.writerStop();
    }

    if (useController) {
      if (!this.controller) {
        this.controller = new ControllerExecutor(this.config, this.logger);
      }
      await this.controller.start(session);
      const liveAdventurerId = this.controller.getCurrentAdventurerId();
      if (liveAdventurerId && liveAdventurerId !== session.adventurerId) {
        const livePlayUrl = this.controller.getCurrentPlayUrl() ?? session.playUrl ?? undefined;
        resolvedSession = { ...session, adventurerId: liveAdventurerId, playUrl: livePlayUrl };
        this.activeSession = resolvedSession;
        saveSession(this.config, resolvedSession);
        this.logger.log("info", "session.sync_adventurer", {
          from: session.adventurerId,
          to: liveAdventurerId,
          playUrl: livePlayUrl
        });
      }
      this.writer = this.controller;
    } else {
      this.writer = this.client;
    }
    if (!resolvedSession.adventurerId) {
      throw new Error("Unable to resolve adventurerId (no play page detected)");
    }

    const nextAdventurerId = resolvedSession.adventurerId;
    const prevAdventurerId = this.adventurerId;
    if (prevAdventurerId == null || prevAdventurerId !== nextAdventurerId) {
      this.resetRunTracking(prevAdventurerId == null ? "bootstrap" : "adventurer_changed", prevAdventurerId, nextAdventurerId);
    }

    this.adventurerId = nextAdventurerId;
    this.lastProgressAt = Date.now();
    this.clearAwaitingActionCount();

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

    // Starting/continuing the game is handled in the main loop (decision policy).
  }

  private async step(client: ChainClient, adventurerId: number) {
    try {
      const rawState = await client.getGameState(adventurerId);
      const state = deriveState(this.config, adventurerId, rawState);
      this.trackMilestones(state);

      if (await this.maybeWaitForStateSync(adventurerId, state)) {
        return;
      }

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

      if (await this.handleDeath(state)) {
        return;
      }

      if (this.shouldPauseForVrfCircuit(state)) {
        if (await this.maybeHandleVrfStuck(state)) {
          return;
        }
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
        if (await this.maybeHandleVrfStuck(state)) {
          return;
        }
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

      if (await this.maybeTakeHumanBreak(state)) {
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

      if (this.shouldBlockSelectStats(state)) {
        this.logger.log("info", "policy.wait_select_stats", {
          actionCount: state.actionCount,
          blockedUntil: this.statUpgradeBlockedUntil
        });
        await sleep(900);
        return;
      }

      const equipCooldownActions = 5;
      const equipCooldownActive =
        this.lastEquipConfirmedActionCount != null &&
        state.actionCount < this.lastEquipConfirmedActionCount + equipCooldownActions;
      if (equipCooldownActive && Date.now() - this.lastEquipCooldownLogAt >= 5_000) {
        this.lastEquipCooldownLogAt = Date.now();
        this.logger.log("info", "policy.equip_cooldown", {
          actionCount: state.actionCount,
          lastEquipActionCount: this.lastEquipConfirmedActionCount,
          cooldownActions: equipCooldownActions
        });
      }

      let stateForPolicy = this.shouldBlockMarketClosed(state) ? { ...state, market: [] } : state;
      const { considerEquip } = this.computeEquipConsideration(stateForPolicy, equipCooldownActive);
      const effectiveConfig = this.getEffectiveConfigForDecision();
      const action = decideChainAction(stateForPolicy, effectiveConfig, lootMeta, { considerEquip });

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

  private async maybeWaitForStateSync(adventurerId: number, state: ReturnType<typeof deriveState>) {
    if (this.awaitingActionCount == null) return false;

    if (state.actionCount >= this.awaitingActionCount) {
      const waitedMs = this.awaitingActionCountSince ? Date.now() - this.awaitingActionCountSince : 0;
      this.logger.log("info", "chain.state_sync_ok", {
        expectedActionCount: this.awaitingActionCount,
        actionCount: state.actionCount,
        waitedMs,
        action: this.awaitingActionLabel,
        txHash: this.awaitingActionTxHash
      });
      this.clearAwaitingActionCount();
      return false;
    }

    const now = Date.now();
    const waitedMs = this.awaitingActionCountSince ? now - this.awaitingActionCountSince : 0;
    if (now - this.lastStateSyncLogAt >= 2_000) {
      this.lastStateSyncLogAt = now;
      this.logger.log("info", "chain.wait_state_sync", {
        expectedActionCount: this.awaitingActionCount,
        actionCount: state.actionCount,
        waitedMs,
        action: this.awaitingActionLabel,
        txHash: this.awaitingActionTxHash
      });
    }

    // Keep the stale-progress watchdog from firing while we are intentionally waiting for the
    // read RPC to reflect a just-confirmed transaction.
    this.lastProgressAt = now;

    const maxWaitMs = 25_000;
    if (waitedMs > maxWaitMs) {
      this.logger.log("warn", "chain.state_sync_timeout", {
        expectedActionCount: this.awaitingActionCount,
        actionCount: state.actionCount,
        waitedMs,
        action: this.awaitingActionLabel,
        txHash: this.awaitingActionTxHash
      });
      this.clearAwaitingActionCount();
      await this.tryRecoverAfterStall(adventurerId, "state_sync_timeout");
      return false;
    }

    await sleep(900);
    return true;
  }

  private setAwaitingActionCount(expectedActionCount: number, action: string, txHash?: string) {
    if (!Number.isFinite(expectedActionCount)) return;
    this.awaitingActionCount = expectedActionCount;
    this.awaitingActionCountSince = Date.now();
    this.awaitingActionLabel = action;
    this.awaitingActionTxHash = txHash ?? null;
  }

  private clearAwaitingActionCount() {
    this.awaitingActionCount = null;
    this.awaitingActionCountSince = 0;
    this.awaitingActionLabel = null;
    this.awaitingActionTxHash = null;
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

  private async handleDeath(state: ReturnType<typeof deriveState>) {
    if (state.hp > 0) return false;

    // When `xp == 0 && hp == 0`, start_game is permitted onchain and should be attempted by policy.
    // When `xp > 0 && hp == 0`, the run has ended and the adventurer id cannot be restarted.
    if (state.xp === 0) {
      return false;
    }

    const now = Date.now();
    if (now - this.lastDeathHandledAt < this.config.recovery.deathCooldownMs) {
      return true;
    }
    this.lastDeathHandledAt = now;
    this.logger.log("warn", "chain.dead", { xp: state.xp, actionCount: state.actionCount });

    if (!this.config.session.autoBuyGame) {
      this.logger.log("warn", "chain.dead_blocker", {
        hint: "Enable session.autoBuyGame to allow automatic recovery by buying a fresh game."
      });
      return true;
    }

    await this.abandonAndRebootstrap("dead");
    return true;
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
    const wantsMainnet = this.config.chain.rpcWriteUrl.includes("/mainnet/");
    const minTimeoutMs = wantsMainnet ? 45_000 : 12_000;
    const timeoutMs = Math.max(minTimeoutMs, this.config.recovery.actionTimeoutMs + 10_000);
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
    await this.maybeHumanThinkDelay(action?.type ?? "unknown", state);
    await this.maybeThrottleTxRate(action?.type ?? "unknown");
    const writer = this.getWriter();
    const vrfEnabled = this.isVrfEnabled();
    switch (action.type) {
      case "startGame": {
        this.logger.log("info", "action.start_game", { reason: action.reason });
        try {
          const tx = await this.callWriterWithTimeout(adventurerId, "start_game", () =>
            writer.startGame(adventurerId, this.config.policy.startingWeaponId, null)
          );
          if (!tx) {
            this.setAwaitingActionCount(state.actionCount + 1, "startGame_timeout");
            return;
          }
          if (tx?.transaction_hash) {
            this.logWriteSubmitted("startGame", tx.transaction_hash);
            await this.waitForTx(client, tx.transaction_hash);
            this.markWriteProgress("startGame", tx.transaction_hash, state.actionCount + 1);
            await this.maybePostEventDwell(action.type, state);
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
          if (!tx) {
            this.setAwaitingActionCount(state.actionCount + 1, "selectStats_timeout");
            return;
          }
          if (!tx?.transaction_hash) {
            this.blockStatUpgrade(state.actionCount, "no_tx_hash_after_select_stats");
            this.logger.log("warn", "action.select_stats_no_tx_hash", { reason: "controller_refresh_or_market_closed" });
            return;
          }
          this.logWriteSubmitted("selectStats", tx.transaction_hash);
          await this.waitForTx(client, this.requireTxHash(tx, "selectStats"));
          this.markWriteProgress("selectStats", tx.transaction_hash, state.actionCount + 1);
          await this.maybePostEventDwell(action.type, state);
          this.clearStatUpgradeBlock();
          this.clearMarketClosedBlock();
        } catch (error) {
          if (this.isVrfPendingError(error)) {
            const preflight = this.isPreflightStageError(error);
            this.blockVrfPending(
              state.actionCount,
              preflight ? "vrf_not_fulfilled_select_stats_preflight" : "vrf_not_fulfilled_select_stats_revert"
            );
            await this.maybeResyncAfterVrfPending(adventurerId, state.actionCount);
            this.logger.log("warn", "action.select_stats_vrf_pending", {
              actionCount: state.actionCount,
              preflight
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
        this.logger.log("info", "action.equip", { reason: action.reason, items: action.payload.items });
        const vrfSalt = vrfEnabled && state.inCombat ? computeBattleSalt(adventurerId, state.xp, state.actionCount) : null;
        const tx = await this.callWriterWithTimeout(adventurerId, "equip", () =>
          writer.equip(adventurerId, action.payload.items, vrfSalt)
        );
        if (!tx) {
          this.setAwaitingActionCount(state.actionCount + 1, "equip_timeout");
          return;
        }
        if (!tx?.transaction_hash) {
          this.logger.log("warn", "action.equip_no_tx_hash", { reason: "controller_refresh_or_ui_resync" });
          return;
        }
        this.logWriteSubmitted("equip", tx.transaction_hash);
        await this.waitForTx(client, this.requireTxHash(tx, "equip"));
        this.markWriteProgress("equip", tx.transaction_hash, state.actionCount + 1);
        // action_count is incremented inside equip(), so observed state.actionCount is pre-action.
        this.lastEquipConfirmedActionCount = state.actionCount + 1;
        await this.maybePostEventDwell(action.type, state);
        return;
      }
      case "buyPotions": {
        this.logger.log("info", "action.buy_potions", { reason: action.reason, count: action.payload.count });
        try {
          const tx = await this.callWriterWithTimeout(adventurerId, "buy_items_potions", () =>
            writer.buyItems(adventurerId, action.payload.count, [])
          );
          if (!tx) {
            this.setAwaitingActionCount(state.actionCount + 1, "buyPotions_timeout");
            return;
          }
          if (!tx?.transaction_hash) {
            this.logger.log("warn", "action.buy_potions_no_tx_hash", { reason: "controller_refresh_or_ui_resync" });
            return;
          }
          this.logWriteSubmitted("buyPotions", tx.transaction_hash);
          await this.waitForTx(client, this.requireTxHash(tx, "buyPotions"));
          this.markWriteProgress("buyPotions", tx.transaction_hash, state.actionCount + 1);
          await this.maybePostEventDwell(action.type, state);
          this.clearMarketClosedBlock();
        } catch (error) {
          if (this.isNotEnoughGoldError(error)) {
            this.blockMarketClosed(state.actionCount, "not_enough_gold_buy_potions");
            this.logger.log("warn", "action.buy_potions_not_enough_gold", { actionCount: state.actionCount });
            return;
          }
          if (this.isHealthFullError(error)) {
            this.blockMarketClosed(state.actionCount, "health_full_buy_potions");
            this.logger.log("warn", "action.buy_potions_health_full", { actionCount: state.actionCount });
            return;
          }
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
        this.logger.log("info", "action.buy_items", {
          reason: action.reason,
          items: action.payload.items,
          potions: action.payload.potions ?? 0
        });
        try {
          const tx = await this.callWriterWithTimeout(adventurerId, "buy_items", () =>
            writer.buyItems(adventurerId, action.payload.potions ?? 0, action.payload.items)
          );
          if (!tx) {
            this.setAwaitingActionCount(state.actionCount + 1, "buyItems_timeout");
            return;
          }
          if (!tx?.transaction_hash) {
            this.logger.log("warn", "action.buy_items_no_tx_hash", { reason: "controller_refresh_or_ui_resync" });
            return;
          }
          this.logWriteSubmitted("buyItems", tx.transaction_hash);
          await this.waitForTx(client, this.requireTxHash(tx, "buyItems"));
          this.markWriteProgress("buyItems", tx.transaction_hash, state.actionCount + 1);
          await this.maybePostEventDwell(action.type, state);
          this.clearMarketClosedBlock();
        } catch (error) {
          if (this.isNotEnoughGoldError(error)) {
            this.blockMarketClosed(state.actionCount, "not_enough_gold_buy_items");
            this.logger.log("warn", "action.buy_items_not_enough_gold", { actionCount: state.actionCount });
            return;
          }
          if (this.isItemAlreadyOwnedError(error)) {
            // Treat as non-fatal: the onchain inventory already contains the item. Avoid repeating market
            // decisions on this action_count and proceed with exploration.
            this.blockMarketClosed(state.actionCount, "item_already_owned_buy_items");
            this.logger.log("warn", "action.buy_items_item_already_owned", { actionCount: state.actionCount });
            return;
          }
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
          const vrfSalt = vrfEnabled ? computeBattleSalt(adventurerId, state.xp, state.actionCount) : null;
          const tx = await this.callWriterWithTimeout(adventurerId, "flee", () =>
            writer.flee(adventurerId, false, vrfSalt)
          );
          if (!tx) {
            this.setAwaitingActionCount(state.actionCount + 1, "flee_timeout");
            return;
          }
          if (!tx?.transaction_hash) {
            this.logger.log("warn", "action.flee_no_tx_hash", { reason: "controller_refresh_or_ui_resync" });
            return;
          }
          this.logWriteSubmitted("flee", tx.transaction_hash);
          await this.waitForTx(client, this.requireTxHash(tx, "flee"));
          this.markWriteProgress("flee", tx.transaction_hash, state.actionCount + 1);
          await this.maybePostEventDwell(action.type, state);
        } catch (error) {
          if (this.isVrfPendingError(error)) {
            const preflight = this.isPreflightStageError(error);
            this.blockVrfPending(
              state.actionCount,
              preflight ? "vrf_not_fulfilled_flee_preflight" : "vrf_not_fulfilled_flee_revert"
            );
            await this.maybeResyncAfterVrfPending(adventurerId, state.actionCount);
            this.logger.log("warn", "action.flee_vrf_pending", { actionCount: state.actionCount, preflight });
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
          const vrfSalt = vrfEnabled ? computeBattleSalt(adventurerId, state.xp, state.actionCount) : null;
          const tx = await this.callWriterWithTimeout(adventurerId, "attack", () =>
            writer.attack(adventurerId, false, vrfSalt)
          );
          if (!tx) {
            this.setAwaitingActionCount(state.actionCount + 1, "attack_timeout");
            return;
          }
          if (!tx?.transaction_hash) {
            this.logger.log("warn", "action.attack_no_tx_hash", { reason: "controller_refresh_or_ui_resync" });
            return;
          }
          this.logWriteSubmitted("attack", tx.transaction_hash);
          await this.waitForTx(client, this.requireTxHash(tx, "attack"));
          this.markWriteProgress("attack", tx.transaction_hash, state.actionCount + 1);
          await this.maybePostEventDwell(action.type, state);
        } catch (error) {
          if (this.isVrfPendingError(error)) {
            const preflight = this.isPreflightStageError(error);
            this.blockVrfPending(
              state.actionCount,
              preflight ? "vrf_not_fulfilled_attack_preflight" : "vrf_not_fulfilled_attack_revert"
            );
            await this.maybeResyncAfterVrfPending(adventurerId, state.actionCount);
            this.logger.log("warn", "action.attack_vrf_pending", { actionCount: state.actionCount, preflight });
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
          const vrfSalt = vrfEnabled ? computeExploreSalt(adventurerId, state.xp) : null;
          const tx = await this.callWriterWithTimeout(adventurerId, "explore", () =>
            writer.explore(adventurerId, action.payload.tillBeast, vrfSalt)
          );
          if (!tx) {
            this.setAwaitingActionCount(state.actionCount + 1, "explore_timeout");
            return;
          }
          if (!tx?.transaction_hash) {
            this.logger.log("warn", "action.explore_no_tx_hash", { reason: "controller_refresh_or_ui_resync" });
            return;
          }
          this.logWriteSubmitted("explore", tx.transaction_hash);
          await this.waitForTx(client, this.requireTxHash(tx, "explore"));
          this.markWriteProgress("explore", tx.transaction_hash, state.actionCount + 1);
          await this.maybePostEventDwell(action.type, state);
        } catch (error) {
          if (this.isVrfPendingError(error)) {
            const preflight = this.isPreflightStageError(error);
            this.blockVrfPending(
              state.actionCount,
              preflight ? "vrf_not_fulfilled_explore_preflight" : "vrf_not_fulfilled_explore_revert"
            );
            await this.maybeResyncAfterVrfPending(adventurerId, state.actionCount);
            this.logger.log("warn", "action.explore_vrf_pending", { actionCount: state.actionCount, preflight });
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

  private sleepMsFromRange(range: { min: number; max: number } | undefined, fallbackMs: number) {
    const sampled = sampleRangeMs(range, fallbackMs);
    if (!Number.isFinite(sampled) || sampled < 0) return fallbackMs;
    return sampled;
  }

  private clampPct(value: number, min: number, max: number) {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
  }

  private resamplePolicyNoise(reason: string) {
    const pacing = this.config.pacing;
    this.policyNoiseEpoch += 1;
    const seedBase = `${this.breakSeed()}|policy_noise|${this.policyNoiseEpoch}`;
    const explore = stableFloatInRange(pacing?.exploreHpNoisePct, `${seedBase}|explore`, 0);
    const fight = stableFloatInRange(pacing?.fightHpNoisePct, `${seedBase}|fight`, 0);
    const flee = stableFloatInRange(pacing?.fleeHpNoisePct, `${seedBase}|flee`, 0);
    this.policyNoise = { explore, fight, flee };
    this.logger.log("info", "pacing.policy_noise", {
      reason,
      epoch: this.policyNoiseEpoch,
      explore,
      fight,
      flee
    });
  }

  private getEffectiveConfigForDecision() {
    const base = this.config.policy;
    const exploreTillBeastPct = this.clampPct(base.exploreTillBeastPct + this.policyNoise.explore, 0.55, 0.99);
    const minHpToFightPct = this.clampPct(base.minHpToFightPct + this.policyNoise.fight, 0.35, 0.99);
    const fleeBelowHpPct = this.clampPct(base.fleeBelowHpPct + this.policyNoise.flee, 0.12, 0.9);
    const policy = {
      ...base,
      exploreTillBeastPct,
      minHpToFightPct,
      fleeBelowHpPct
    };
    return { ...this.config, policy };
  }

  private hourInRange(hour: number, start: number, end: number) {
    // half-open interval [start, end), with wrap support (e.g. 23..7)
    if (start === end) return true;
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
  }

  private timeOfDayMultiplier() {
    const pacing = this.config.pacing;
    if (!pacing?.enabled || pacing.timeOfDayEnabled === false) return 1;
    const hour = new Date().getHours();
    if (this.hourInRange(hour, pacing.timeOfDayNightStartHour, pacing.timeOfDayNightEndHour)) {
      return pacing.timeOfDayNightMultiplier;
    }
    if (this.hourInRange(hour, pacing.timeOfDayEveningStartHour, pacing.timeOfDayEveningEndHour)) {
      return pacing.timeOfDayEveningMultiplier;
    }
    return 1;
  }

  private applyDelayMultiplier(ms: number) {
    const factor = this.timeOfDayMultiplier();
    const scaled = Math.round(ms * factor);
    return Math.max(0, scaled);
  }

  private computeBagKey(state: ReturnType<typeof deriveState>) {
    const bag = state.bagItems
      .map((item) => `${item.id}:${item.xp}`)
      .sort()
      .join("|");
    const equipped = Object.values(state.equipment)
      .filter((item): item is { id: number; xp: number } => !!item)
      .map((item) => `${item.id}:${item.xp}`)
      .sort()
      .join("|");
    return `${bag}//${equipped}`;
  }

  private computeEquipConsideration(state: ReturnType<typeof deriveState>, equipCooldownActive: boolean) {
    if (equipCooldownActive) {
      return { considerEquip: false, reason: "equip_cooldown" };
    }

    if (state.inCombat) {
      return { considerEquip: true, reason: "combat" };
    }

    const pacing = this.config.pacing;
    if (!pacing?.enabled) {
      return { considerEquip: true, reason: "pacing_disabled" };
    }

    const now = Date.now();
    const bagKey = this.computeBagKey(state);
    const bagChanged = this.lastBagKey == null ? state.bagItems.length > 0 : bagKey !== this.lastBagKey;
    const dueByActions =
      this.lastGearReviewActionCount == null ||
      state.actionCount - this.lastGearReviewActionCount >= pacing.gearReviewEveryActions;
    const dueByTime = !this.lastGearReviewAt || now - this.lastGearReviewAt >= pacing.gearReviewEveryMs;
    const due = bagChanged || state.market.length > 0 || dueByActions || dueByTime;
    if (!due) {
      return { considerEquip: false, reason: "gear_review_not_due" };
    }

    const reason = bagChanged
      ? "bag_changed"
      : state.market.length > 0
        ? "market_open"
        : dueByActions
          ? "actions"
          : "time";

    this.lastGearReviewAt = now;
    this.lastGearReviewActionCount = state.actionCount;
    this.lastBagKey = bagKey;
    this.logger.log("info", "policy.gear_review", { reason, actionCount: state.actionCount, level: state.level });
    return { considerEquip: true, reason };
  }

  private async maybeThrottleTxRate(actionType: string) {
    const pacing = this.config.pacing;
    if (!pacing?.enabled) return;
    const limit = pacing.maxTxPerMinute ?? 0;
    if (!limit || limit <= 0) return;
    if (!actionType || actionType === "wait") return;

    while (true) {
      const now = Date.now();
      // Drop entries outside the rolling 60s window.
      this.txAttemptTimestamps = this.txAttemptTimestamps.filter((t) => now - t < 60_000);
      if (this.txAttemptTimestamps.length < limit) {
        this.txAttemptTimestamps.push(now);
        return;
      }

      const oldest = this.txAttemptTimestamps[0] ?? now;
      const waitMs = Math.max(250, 60_000 - (now - oldest) + Math.floor(Math.random() * 750));
      if (Date.now() - this.txThrottleLogAt >= 10_000) {
        this.txThrottleLogAt = Date.now();
        this.logger.log("warn", "pacing.tx_throttle", {
          limitPerMinute: limit,
          buffered: this.txAttemptTimestamps.length,
          waitMs
        });
      }

      // Avoid stale-progress watchdogs while intentionally waiting.
      this.lastProgressAt = Date.now();
      await sleep(Math.min(2_000, waitMs));
    }
  }

  private async maybePostEventDwell(actionType: string, preState: ReturnType<typeof deriveState>) {
    const pacing = this.config.pacing;
    if (!pacing?.enabled) return;

    let kind: "near_death" | "market" | "level_up" | null = null;
    let range: { min: number; max: number } | undefined;

    if (preState.hpPct <= (pacing.nearDeathHpPct ?? 0)) {
      kind = "near_death";
      range = pacing.postNearDeathDwellMs;
    } else if (actionType === "buyItems" || actionType === "buyPotions") {
      kind = "market";
      range = pacing.postMarketDwellMs;
    } else if (actionType === "selectStats") {
      kind = "level_up";
      range = pacing.postLevelUpDwellMs;
    }

    if (!kind || !range) return;

    const sampled = this.sleepMsFromRange(range, 0);
    const dwellMs = this.applyDelayMultiplier(sampled);
    if (dwellMs <= 0) return;

    this.logger.log("info", "pacing.post_event_dwell", {
      kind,
      actionType,
      dwellMs,
      hpPct: Number(preState.hpPct.toFixed(3)),
      actionCount: preState.actionCount
    });
    this.lastProgressAt = Date.now();
    await sleep(dwellMs);
  }

  private scheduleNextHumanBreak(now: number, reason: string) {
    const pacing = this.config.pacing;
    if (!pacing?.enabled) {
      this.nextHumanBreakAt = 0;
      return;
    }
    const inMs = this.sleepMsFromRange(pacing.breakIntervalMs, 15 * 60 * 1000);
    this.nextHumanBreakAt = now + inMs;
    this.logger.log("info", "pacing.next_break_scheduled", { kind: "short", reason, inMs });
  }

  private scheduleNextSleepBreak(now: number, reason: string) {
    const pacing = this.config.pacing;
    if (!pacing?.enabled || pacing.sleepEnabled === false) {
      this.nextSleepBreakAt = 0;
      return;
    }
    const intervalMs = this.sleepMsFromRange(pacing.sleepIntervalMs, 24 * 60 * 60 * 1000);
    const jitterMs = this.getStableSleepJitterMs();
    const inMs = intervalMs + jitterMs;
    this.nextSleepBreakAt = now + inMs;
    this.logger.log("info", "pacing.next_break_scheduled", {
      kind: "sleep",
      reason,
      inMs,
      intervalMs,
      jitterMs
    });
  }

  private breakSeed() {
    const username = this.config.session.username?.trim() || "runner";
    return `${this.config.app.dataDir}|${this.config.logging.eventsFile}|${username}`;
  }

  private getStableSleepJitterMs() {
    if (this.stableSleepJitterMs != null) {
      return this.stableSleepJitterMs;
    }
    const pacing = this.config.pacing;
    const jitter = stableIntInRange(pacing?.sleepJitterMs, this.breakSeed(), 0);
    this.stableSleepJitterMs = jitter;
    return jitter;
  }

  private clearActiveBreakState() {
    this.humanBreakUntil = 0;
    this.activeBreakKind = null;
    this.lastHumanBreakStartAt = 0;
    this.lastHumanBreakLogAt = 0;
    this.deferredHumanBreaks = 0;
    this.breakStartActionCount = null;
    this.breakStartLevel = null;
  }

  private async maybeSleepDuringHumanBreak() {
    if (!this.humanBreakUntil) return false;

    const now = Date.now();
    if (now >= this.humanBreakUntil) {
      const kind = this.activeBreakKind ?? "short";
      const durationMs = this.lastHumanBreakStartAt ? now - this.lastHumanBreakStartAt : 0;
      this.logger.log("info", "pacing.break_end", {
        kind,
        durationMs,
        actionCount: this.breakStartActionCount,
        level: this.breakStartLevel
      });
      this.clearActiveBreakState();
      if (kind === "sleep") {
        this.resamplePolicyNoise("wake_after_sleep");
        this.scheduleNextSleepBreak(now, "break_end");
        // Reset short-break schedule after sleeping so we don't "wake up" into an immediate short break.
        this.scheduleNextHumanBreak(now, "wake_after_sleep");
      } else {
        this.scheduleNextHumanBreak(now, "break_end");
      }
      return false;
    }

    const kind = this.activeBreakKind ?? "short";
    const remainingMs = this.humanBreakUntil - now;
    const logEveryMs = kind === "sleep" ? 5 * 60_000 : 10_000;
    if (now - this.lastHumanBreakLogAt >= logEveryMs) {
      this.lastHumanBreakLogAt = now;
      this.logger.log("info", "pacing.break_active", {
        kind,
        remainingMs,
        actionCount: this.breakStartActionCount,
        level: this.breakStartLevel
      });
    }

    // Keep local watchdogs happy; breaks are intentional.
    this.lastProgressAt = now;

    const chunkMs = kind === "sleep" ? Math.min(60_000, remainingMs) : Math.min(1_000, remainingMs);
    await sleep(chunkMs);
    return true;
  }

  private async maybeTakeHumanBreak(state: ReturnType<typeof deriveState>) {
    const pacing = this.config.pacing;
    if (!pacing?.enabled) return false;

    const now = Date.now();

    if (this.humanBreakUntil && now < this.humanBreakUntil) return true;

    if (!this.nextHumanBreakAt) {
      this.scheduleNextHumanBreak(now, "init");
    }
    if (!this.nextSleepBreakAt) {
      this.scheduleNextSleepBreak(now, "init");
    }

    const sleepDue = pacing.sleepEnabled !== false && this.nextSleepBreakAt > 0 && now >= this.nextSleepBreakAt;
    const shortDue = this.nextHumanBreakAt > 0 && now >= this.nextHumanBreakAt;
    if (!sleepDue && !shortDue) return false;
    const kind: "sleep" | "short" = sleepDue ? "sleep" : "short";

    const safe =
      this.awaitingActionCount == null &&
      (!pacing.onlyOutOfCombat || !state.inCombat) &&
      !(this.vrfPendingBlockedActionCount != null && this.vrfPendingBlockedActionCount === state.actionCount);
    if (!safe) {
      this.deferredHumanBreaks += 1;
      // Retry shortly; don't spam logs.
      if (kind === "sleep") {
        this.nextSleepBreakAt = now + 30_000;
      } else {
        this.nextHumanBreakAt = now + 30_000;
      }
      if (this.deferredHumanBreaks % 10 === 0) {
        this.logger.log("info", "pacing.break_deferred", {
          kind,
          deferred: this.deferredHumanBreaks,
          inCombat: state.inCombat,
          actionCount: state.actionCount
        });
      }
      return false;
    }

    const durationMs =
      kind === "sleep"
        ? this.sleepMsFromRange(pacing.sleepDurationMs, 5 * 60 * 60 * 1000)
        : this.sleepMsFromRange(pacing.breakDurationMs, 45_000);
    this.humanBreakUntil = now + durationMs;
    this.activeBreakKind = kind;
    this.lastHumanBreakStartAt = now;
    this.lastHumanBreakLogAt = 0;
    this.breakStartActionCount = state.actionCount;
    this.breakStartLevel = state.level;
    this.logger.log("info", "pacing.break_start", {
      kind,
      durationMs,
      actionCount: state.actionCount,
      level: state.level
    });
    this.lastProgressAt = now;
    await sleep(Math.min(1000, durationMs));
    return true;
  }

  private async sleepBetweenSteps() {
    const pacing = this.config.pacing;
    const sampled = pacing?.enabled ? this.sleepMsFromRange(pacing.betweenStepsMs, 500) : 500;
    const ms = this.applyDelayMultiplier(sampled);
    await sleep(ms);
  }

  private async maybeHumanThinkDelay(actionType: string, _state: any) {
    const pacing = this.config.pacing;
    if (!pacing?.enabled) return;
    if (!actionType || actionType === "wait") return;

    const delayMs = this.applyDelayMultiplier(this.sleepMsFromRange(pacing.beforeActionMs, 0));
    if (delayMs <= 0) return;

    // Don't let think delays trip stale-progress detection; they are intentional.
    this.lastProgressAt = Date.now();
    await sleep(delayMs);
  }

  private useControllerWriter() {
    const wantsMainnet = !this.config.safety.blockIfNotPractice || this.config.chain.rpcWriteUrl.includes("/mainnet/");
    return wantsMainnet && this.config.session.useControllerAddress;
  }

  private isVrfEnabled() {
    const url = this.config.chain.rpcWriteUrl.toLowerCase();
    return url.includes("/mainnet/") || url.includes("/sepolia/");
  }

  private getWriter() {
    if (!this.writer) {
      throw new Error("Writer not initialized");
    }
    return this.writer;
  }

  private async writerStop() {
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

  private isMarketClosedError(error: unknown) {
    return String(error).toLowerCase().includes("market is closed");
  }

  private isNotInBattleError(error: unknown) {
    return String(error).toLowerCase().includes("not in battle");
  }

  private isNotEnoughGoldError(error: unknown) {
    return String(error).toLowerCase().includes("not enough gold");
  }

  private isItemAlreadyOwnedError(error: unknown) {
    return String(error).toLowerCase().includes("item already owned");
  }

  private isHealthFullError(error: unknown) {
    const text = String(error).toLowerCase();
    return text.includes("health already full") || text.includes("health full");
  }

  private isVrfPendingError(error: unknown) {
    const text = String(error).toLowerCase();
    return text.includes("vrfprovider: not fulfilled") || text.includes("vrf provider: not fulfilled");
  }

  private isPreflightStageError(error: unknown) {
    return String(error).includes("[preflight]");
  }

  private markWriteProgress(action: string, txHash?: string, expectedActionCount?: number) {
    this.lastProgressAt = Date.now();
    this.staleRecoveryAttempts = 0;
    this.clearVrfPendingBlock();
    if (typeof expectedActionCount === "number" && Number.isFinite(expectedActionCount)) {
      this.setAwaitingActionCount(expectedActionCount, action, txHash);
    }
    this.logger.log("info", "chain.write_confirmed", { action, txHash });
  }

  private logWriteSubmitted(action: string, txHash: string) {
    const voyagerBase = this.config.chain.rpcWriteUrl.includes("/mainnet/")
      ? "https://voyager.online/tx/"
      : "https://sepolia.voyager.online/tx/";
    this.logger.log("info", "chain.write_submitted", { action, txHash, voyager: `${voyagerBase}${txHash}` });
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

  private async maybeHandleVrfStuck(state: ReturnType<typeof deriveState>) {
    if (this.vrfPendingBlockedActionCount == null) return false;
    if (this.vrfPendingBlockedActionCount !== state.actionCount) return false;
    if (!this.vrfPendingSince) return false;

    const now = Date.now();
    const sinceMs = now - this.vrfPendingSince;
    if (sinceMs < this.config.recovery.vrfStuckMs) return false;
    if (this.lastVrfAbandonAt && now - this.lastVrfAbandonAt < this.config.recovery.vrfAbandonCooldownMs) {
      return false;
    }
    this.lastVrfAbandonAt = now;

    this.logger.milestone("blocker_vrf_stuck", {
      adventurerId: state.adventurerId,
      actionCount: state.actionCount,
      attempts: this.vrfPendingAttempts,
      sinceMs
    });

    if (!this.config.session.autoBuyGame) {
      this.logger.log("warn", "chain.vrf_stuck", {
        adventurerId: state.adventurerId,
        actionCount: state.actionCount,
        attempts: this.vrfPendingAttempts,
        sinceMs,
        hint: "Enable session.autoBuyGame to allow automatic recovery by buying a fresh game."
      });
      return false;
    }

    this.logger.log("warn", "chain.vrf_abandon", {
      adventurerId: state.adventurerId,
      actionCount: state.actionCount,
      attempts: this.vrfPendingAttempts,
      sinceMs
    });

    await this.abandonAndRebootstrap("vrf_stuck");
    return true;
  }

  private async abandonAndRebootstrap(reason: string) {
    if (this.activeSession) {
      const cleared: RunnerSession = { ...this.activeSession, adventurerId: undefined, playUrl: undefined };
      this.activeSession = cleared;
      saveSession(this.config, cleared);
      this.logger.log("info", "session.cleared_adventurer", { reason });
    }

    if (this.controller) {
      await this.controller.stop().catch(() => undefined);
      this.controller = null;
    }
    this.writer = null;
    this.client = null;
    this.adventurerId = null;
    this.clearAwaitingActionCount();
    this.clearVrfPendingBlock();
    this.logger.log("warn", "chain.rebootstrap", { reason });
    await this.bootstrapSession();
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
    if (this.vrfPendingAttempts === 1 && reason.includes("_revert")) {
      this.logger.log("warn", "safety.vrf_revert_paid", { actionCount, reason });
    }

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
