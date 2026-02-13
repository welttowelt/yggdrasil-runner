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

// Onchain constants (death-mountain) — kept inline to avoid runtime ABI lookups.
const BASE_POTION_PRICE = 1;
const MINIMUM_POTION_PRICE = 1;
const CHARISMA_POTION_DISCOUNT = 2;
const POTION_HEALTH_AMOUNT = 10;

const TIER_PRICE = 4;
const MINIMUM_ITEM_PRICE = 1;
const CHARISMA_ITEM_DISCOUNT = 1;

const MAX_STAT = 31;

function clampInt(value: number, min: number, max: number) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

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
    dexterity: clampInt(Math.ceil(level * config.policy.dexTargetRatio), 0, MAX_STAT),
    vitality: clampInt(Math.ceil(level * config.policy.vitTargetRatio), 0, MAX_STAT),
    charisma: clampInt(Math.ceil(level * (config.policy.chaTargetRatio ?? 0)), 0, MAX_STAT),
    strength: clampInt(Math.ceil(level * config.policy.strTargetRatio), 0, MAX_STAT),
    intelligence: clampInt(Math.ceil(level * config.policy.intTargetRatio), 0, MAX_STAT),
    wisdom: clampInt(Math.ceil(level * config.policy.wisTargetRatio), 0, MAX_STAT)
  };

  while (remaining > 0) {
    if (state.stats.dexterity + allocated.dexterity < targets.dexterity) {
      allocateStat("dexterity", allocated);
    } else if (state.stats.vitality + allocated.vitality < targets.vitality) {
      allocateStat("vitality", allocated);
    } else if (state.stats.charisma + allocated.charisma < targets.charisma) {
      allocateStat("charisma", allocated);
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

function itemPriceForTier(tier: number, charisma: number) {
  // Onchain: ImplMarket::get_price(Tier) where:
  //   T1: 5*TIER_PRICE, T2: 4*TIER_PRICE, ..., T5: 1*TIER_PRICE
  // With charm discount:
  //   price = max(MINIMUM_ITEM_PRICE, base - CHARISMA_ITEM_DISCOUNT*charisma)
  if (!Number.isFinite(tier)) return Infinity;
  const normalizedTier = Math.floor(tier);
  if (normalizedTier < 1 || normalizedTier > 5) return Infinity;
  const tierMultiplier = 6 - normalizedTier;
  const base = tierMultiplier * TIER_PRICE;
  const discount = Math.max(0, Math.floor(charisma)) * CHARISMA_ITEM_DISCOUNT;
  if (discount >= base) return MINIMUM_ITEM_PRICE;
  return Math.max(MINIMUM_ITEM_PRICE, base - discount);
}

function potionPrice(level: number, charisma: number) {
  // Onchain: price = BASE_POTION_PRICE*level - CHARISMA_POTION_DISCOUNT*charisma, with minimum.
  const base = Math.max(1, Math.floor(level)) * BASE_POTION_PRICE;
  const discount = Math.max(0, Math.floor(charisma)) * CHARISMA_POTION_DISCOUNT;
  if (discount >= base) return MINIMUM_POTION_PRICE;
  return Math.max(MINIMUM_POTION_PRICE, base - discount);
}

function ownedItemIds(state: DerivedState) {
  const owned = new Set<number>();
  for (const item of state.bagItems) {
    if (item.id > 0) owned.add(item.id);
  }
  for (const equipped of Object.values(state.equipment)) {
    if (equipped && equipped.id > 0) owned.add(equipped.id);
  }
  return owned;
}

export function decideChainAction(state: DerivedState, config: RunnerConfig, lootMeta: LootMetaMap): ChainAction {
  // Onchain start_game precondition:
  //   adventurer.xp == 0 && adventurer.health == 0
  // If hp is 0 but xp > 0 the run has ended and cannot be restarted for this adventurer id.
  if (state.hp <= 0 && state.xp === 0) {
    return { type: "startGame", reason: "adventurer not started (hp=0,xp=0)" };
  }
  if (state.hp <= 0) {
    return { type: "wait", reason: "adventurer dead (need new game)" };
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
    const owned = ownedItemIds(state);

    if (state.hpPct < config.policy.buyPotionIfBelowPct) {
      const unitPrice = potionPrice(state.level, state.stats.charisma);
      if (state.hp >= state.maxHp) {
        // Prevent wasteful purchases that can revert with HEALTH_FULL.
      } else if (state.gold >= unitPrice) {
        // Buy enough in a single action to cross the threshold; buying potions is immediate heal onchain.
        const targetHp = Math.ceil(config.policy.buyPotionIfBelowPct * state.maxHp);
        const missingHp = Math.max(0, targetHp - state.hp);
        const needed = Math.max(1, Math.ceil(missingHp / POTION_HEALTH_AMOUNT));
        const affordable = Math.max(0, Math.floor(state.gold / unitPrice));
        const count = Math.max(1, Math.min(needed, affordable));
        if (count > 0) {
          return {
            type: "buyPotions",
            reason: `buy potions for recovery (price ${unitPrice} x${count})`,
            payload: { count }
          };
        }
      }
    }

    const marketChoices = state.market
      .filter((id) => !owned.has(id))
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
        if (currentItem && currentItem.id === best.id) {
          // Contract disallows purchasing duplicates ("Item already owned").
          best = null;
        }
      }

      if (best) {
        const slot = best.meta.slot;
        const currentItem = (state.equipment as Record<string, { id: number; xp: number } | null>)[slot] ?? null;
        const currentMeta = currentItem ? lootMeta[currentItem.id] : null;
        const currentScore = currentItem && currentMeta ? itemScore(currentItem, currentMeta, config) : 0;
        const price = itemPriceForTier(best.meta.tier, state.stats.charisma);
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
