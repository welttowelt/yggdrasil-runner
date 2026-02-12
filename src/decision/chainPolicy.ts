import { RunnerConfig } from "../config/schema.js";
import { DerivedState } from "../chain/state.js";

export type ChainActionType =
  | "startGame"
  | "explore"
  | "attack"
  | "flee"
  | "buyPotions"
  | "buyItems"
  | "equip"
  | "selectStats"
  | "wait";

export type ChainAction = {
  type: ChainActionType;
  reason: string;
  payload?: any;
};

type LootMetaMap = Record<number, { id: number; tier: number; slot: string; itemType: string }>;

function allocateStat(stat: keyof ReturnType<typeof baseStats>, stats: Record<string, number>) {
  stats[stat] += 1;
}

function baseStats() {
  const base = {
    strength: 0,
    dexterity: 0,
    vitality: 0,
    intelligence: 0,
    wisdom: 0,
    charisma: 0,
    luck: 0
  };
  return base;
}

function pickStats(state: DerivedState, config: RunnerConfig): Record<string, number> {
  const upgrades = state.statUpgrades;
  const allocated = baseStats();
  let remaining = upgrades;
  const level = Math.max(1, state.level);

  const targets = {
    dexterity: Math.ceil(level * config.policy.dexTargetRatio),
    vitality: Math.ceil(level * config.policy.vitTargetRatio),
    strength: Math.ceil(level * config.policy.strTargetRatio),
    intelligence: Math.ceil(level * config.policy.intTargetRatio),
    wisdom: Math.ceil(level * config.policy.wisTargetRatio)
  };

  while (remaining > 0) {
    if (state.stats.dexterity + allocated.dexterity < targets.dexterity) {
      allocateStat("dexterity", allocated);
    } else if (state.stats.vitality + allocated.vitality < targets.vitality) {
      allocateStat("vitality", allocated);
    } else if (state.stats.strength + allocated.strength < targets.strength) {
      allocateStat("strength", allocated);
    } else if (state.stats.intelligence + allocated.intelligence < targets.intelligence) {
      allocateStat("intelligence", allocated);
    } else if (state.stats.wisdom + allocated.wisdom < targets.wisdom) {
      allocateStat("wisdom", allocated);
    } else {
      const order = config.policy.statUpgradePriority;
      const stat = order[(upgrades - remaining) % order.length];
      allocateStat(stat === "luck" ? "vitality" : stat, allocated);
    }
    remaining -= 1;
  }
  return allocated;
}

function itemLevelFromXp(xp: number, config: RunnerConfig) {
  const divisor = Math.max(1, config.policy.itemXpDivisor);
  return Math.max(1, Math.floor(xp / divisor) + 1);
}

function itemScore(item: { id: number; xp: number }, meta: { tier: number }, config: RunnerConfig) {
  const tier = meta.tier || 0;
  const tierWeight = Math.max(1, 6 - tier);
  const level = itemLevelFromXp(item.xp, config);
  return tierWeight * level;
}

function chooseEquipItems(state: DerivedState, lootMeta: LootMetaMap, config: RunnerConfig) {
  const slots = state.equipment;
  const bestBySlot: Record<string, { item: { id: number; xp: number }; score: number }> = {};
  for (const item of state.bagItems) {
    const meta = lootMeta[item.id];
    if (!meta?.slot) continue;
    const score = itemScore(item, meta, config);
    const current = bestBySlot[meta.slot];
    if (!current || score > current.score) {
      bestBySlot[meta.slot] = { item, score };
    }
  }

  const toEquip: number[] = [];
  for (const [slot, candidate] of Object.entries(bestBySlot)) {
    const currentItem = (slots as Record<string, { id: number; xp: number } | null>)[slot] ?? null;
    const currentMeta = currentItem ? lootMeta[currentItem.id] : null;
    if (!currentItem || !currentMeta) {
      toEquip.push(candidate.item.id);
      continue;
    }
    const currentScore = itemScore(currentItem, currentMeta, config);
    const upgradeThreshold = 1 + config.policy.equipUpgradeThreshold;
    if (candidate.score > currentScore * upgradeThreshold) {
      toEquip.push(candidate.item.id);
    }
  }
  return toEquip;
}

function estimateMarketItemScore(
  level: number,
  meta: { tier: number },
  config: RunnerConfig
) {
  const tier = meta.tier || 0;
  const tierWeight = Math.max(1, 6 - tier);
  return tierWeight * Math.max(1, level);
}

function estimateMarketPrice(level: number, tier: number) {
  const tierWeight = Math.max(1, 6 - tier);
  const price = (2 * level * 1 + level) * tierWeight * 2;
  return Math.max(1, Math.floor(price));
}

export function decideChainAction(state: DerivedState, config: RunnerConfig, lootMeta: LootMetaMap): ChainAction {
  if (state.hp <= 0) {
    return { type: "startGame", reason: "adventurer dead or not started" };
  }

  if (state.inCombat) {
    if (state.beast.level > Math.max(1, state.level) * config.policy.maxBeastLevelRatio && state.hpPct < 0.9) {
      return { type: "flee", reason: `beast level ${state.beast.level} too high for level ${state.level}` };
    }
    if (state.hpPct < config.policy.fleeBelowHpPct) {
      if (state.fleeChance >= config.policy.minFleeChance || state.hpPct < config.policy.fleeBelowHpPct * 0.7) {
        return { type: "flee", reason: `hp ${state.hpPct.toFixed(2)} below flee threshold` };
      }
    }
    return { type: "attack", reason: "combat attack" };
  }

  if (state.statUpgrades > 0) {
    return {
      type: "selectStats",
      reason: `stat upgrades available: ${state.statUpgrades}`,
      payload: { stats: pickStats(state, config) }
    };
  }

  if (state.market.length > 0) {
    if (state.hpPct < config.policy.buyPotionIfBelowPct) {
      return { type: "buyPotions", reason: "buy potions for recovery", payload: { count: 1 } };
    }

    const marketChoices = state.market
      .map((id) => ({ id, meta: lootMeta[id] }))
      .filter((entry) => entry.meta?.slot);

    if (marketChoices.length > 0) {
      let best: { id: number; meta: { tier: number; slot: string; itemType: string }; score: number } | null = null;
      for (const entry of marketChoices) {
        const score = estimateMarketItemScore(state.level, entry.meta, config);
        if (!best || score > best.score) {
          best = { id: entry.id, meta: entry.meta, score };
        }
      }

      if (best) {
        const slot = best.meta.slot;
        const currentItem = (state.equipment as Record<string, { id: number; xp: number } | null>)[slot] ?? null;
        const currentMeta = currentItem ? lootMeta[currentItem.id] : null;
        const currentScore = currentItem && currentMeta ? itemScore(currentItem, currentMeta, config) : 0;
        const price = estimateMarketPrice(state.level, best.meta.tier);
        const upgradeThreshold = 1 + config.policy.equipUpgradeThreshold;

        if ((currentScore === 0 || best.score > currentScore * upgradeThreshold) && state.gold >= price) {
          return {
            type: "buyItems",
            reason: `market upgrade for ${slot} (price ${price})`,
            payload: { items: [{ item_id: best.id, equip: true }], potions: 0 }
          };
        }
      }
    }
  }

  if (state.bagItems.length > 0) {
    const equipItems = chooseEquipItems(state, lootMeta, config);
    if (equipItems.length > 0) {
      return { type: "equip", reason: "equip upgraded items", payload: { items: equipItems } };
    }
  }

  const tillBeast = state.hpPct >= config.policy.exploreTillBeastPct;
  return { type: "explore", reason: "advance dungeon", payload: { tillBeast } };
}
