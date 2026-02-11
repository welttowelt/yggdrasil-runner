import { RunnerConfig } from "../config/schema.js";
import { DerivedState } from "../chain/state.js";

export type ChainActionType =
  | "startGame"
  | "explore"
  | "attack"
  | "flee"
  | "buyPotions"
  | "equip"
  | "selectStats"
  | "wait";

export type ChainAction = {
  type: ChainActionType;
  reason: string;
  payload?: any;
};

function pickStats(config: RunnerConfig, upgrades: number): Record<string, number> {
  const base = {
    strength: 0,
    dexterity: 0,
    vitality: 0,
    intelligence: 0,
    wisdom: 0,
    charisma: 0,
    luck: 0
  };

  let remaining = upgrades;
  const order = config.policy.statUpgradePriority;
  let idx = 0;
  while (remaining > 0) {
    const stat = order[idx % order.length];
    base[stat] += 1;
    remaining -= 1;
    idx += 1;
  }
  return base;
}

export function decideChainAction(state: DerivedState, config: RunnerConfig): ChainAction {
  if (state.hp <= 0) {
    return { type: "wait", reason: "adventurer dead or not started" };
  }

  if (state.statUpgrades > 0) {
    return {
      type: "selectStats",
      reason: `stat upgrades available: ${state.statUpgrades}`,
      payload: { stats: pickStats(config, state.statUpgrades) }
    };
  }

  if (state.inCombat) {
    if (state.hpPct < config.policy.fleeBelowHpPct) {
      return { type: "flee", reason: `hp ${state.hpPct.toFixed(2)} below flee threshold` };
    }
    return { type: "attack", reason: "combat attack" };
  }

  if (state.market.length > 0) {
    if (state.hpPct < config.policy.buyPotionIfBelowPct) {
      return { type: "buyPotions", reason: "buy potions for recovery", payload: { count: 1 } };
    }
  }

  if (state.bagItems.length > 0) {
    return { type: "equip", reason: "equip new items", payload: { items: state.bagItems } };
  }

  if (state.hpPct < config.policy.minHpToExplorePct) {
    return { type: "wait", reason: `hp ${state.hpPct.toFixed(2)} below explore threshold` };
  }

  const tillBeast = state.hpPct >= config.policy.exploreTillBeastPct;
  return { type: "explore", reason: "advance dungeon", payload: { tillBeast } };
}
