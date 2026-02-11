import { RunnerConfig } from "../config/schema.js";
import { Action, GameState } from "../runner/types.js";

function getHpPct(state: GameState): number {
  if (state.hp == null || state.maxHp == null || state.maxHp === 0) return 1;
  return state.hp / state.maxHp;
}

function getPotionCount(state: GameState): number | null {
  const inv: any = state.inventory;
  if (!inv) return null;
  if (typeof inv.potions === "number") return inv.potions;
  if (Array.isArray(inv.items)) {
    return inv.items.filter((i: any) => {
      const name = String(i?.name ?? "").toLowerCase();
      return name.includes("potion");
    }).length;
  }
  return null;
}

function hasAction(state: GameState, key: string) {
  return state.availableActions.includes(key);
}

export function decideNextAction(state: GameState, config: RunnerConfig): Action {
  const hpPct = getHpPct(state);
  const potions = getPotionCount(state) ?? 0;

  if (state.phase === "menu" && hasAction(state, "practiceStart")) {
    return { type: "startPractice", reason: "start practice run" };
  }

  if (state.phase === "death") {
    if (hasAction(state, "continue")) return { type: "continue", reason: "restart after death" };
    if (hasAction(state, "practiceStart")) return { type: "startPractice", reason: "restart practice" };
  }

  if (state.phase === "combat") {
    if (hpPct < config.policy.fleeBelowHpPct && hasAction(state, "flee")) {
      return { type: "flee", reason: `hp ${hpPct.toFixed(2)} below flee threshold` };
    }
    if (hpPct < config.policy.usePotionBelowHpPct && hasAction(state, "drinkPotion")) {
      return { type: "drinkPotion", reason: `hp ${hpPct.toFixed(2)} below potion threshold` };
    }
    if (hasAction(state, "fight")) {
      return { type: "fight", reason: "survival-first fight" };
    }
  }

  if (state.phase === "market" || state.phase === "town") {
    const needPotions = potions < config.policy.maxPotions;
    if (needPotions && hpPct < config.policy.buyPotionIfBelowPct && hasAction(state, "buyPotion")) {
      return { type: "buyPotion", reason: "restock potions for safety" };
    }
    if (hasAction(state, "continue")) {
      return { type: "continue", reason: "leave market" };
    }
    if (hasAction(state, "explore")) {
      return { type: "explore", reason: "return to dungeon" };
    }
  }

  if (state.phase === "dungeon" || state.phase === "unknown") {
    if (hpPct < config.policy.minHpToExplorePct) {
      if (hasAction(state, "drinkPotion")) {
        return { type: "drinkPotion", reason: `hp ${hpPct.toFixed(2)} below explore threshold` };
      }
      if (hasAction(state, "market")) {
        return { type: "market", reason: "seek market for recovery" };
      }
      if (hasAction(state, "continue")) {
        return { type: "continue", reason: "low hp, avoid risk" };
      }
      return { type: "wait", reason: "low hp and no safe action" };
    }

    if (hasAction(state, "explore")) {
      return { type: "explore", reason: "progress dungeon" };
    }
  }

  if (hasAction(state, "continue")) {
    return { type: "continue", reason: "fallback continue" };
  }

  return { type: "wait", reason: "no actionable buttons" };
}
