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
const MINIMUM_DAMAGE_TO_BEASTS = 4;
const MINIMUM_DAMAGE_FROM_BEASTS = 2;
const ELEMENTAL_DAMAGE_BONUS = 2; // +/- damage / ELEMENTAL_DAMAGE_BONUS

const TIER_PRICE = 4;
const MINIMUM_ITEM_PRICE = 1;
const CHARISMA_ITEM_DISCOUNT = 1;

const MAX_STAT = 31;

// Item IDs (death-mountain/constants/loot.cairo)
const ITEM_ID_PENDANT = 1;
const ITEM_ID_NECKLACE = 2;
const ITEM_ID_AMULET = 3;
const ITEM_ID_SILVER_RING = 4;

function clampInt(value: number, min: number, max: number) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function greatnessFromXp(xp: number) {
  // Onchain: Item::get_greatness
  //   xp == 0 => 1
  //   else sqrt(xp) capped at 20
  const n = clampInt(xp, 0, 1_000_000);
  if (n === 0) return 1;
  const g = Math.floor(Math.sqrt(n));
  return clampInt(g, 1, 20);
}

function tierMultiplier(tier: number) {
  // Onchain TIER_DAMAGE_MULTIPLIER: T1=5, T2=4, T3=3, T4=2, T5=1
  const t = clampInt(tier, 0, 10);
  if (t <= 0 || t > 5) return 0;
  return 6 - t;
}

function baseCombatPower(item: { xp: number }, meta: { tier: number }) {
  return greatnessFromXp(item.xp) * tierMultiplier(meta.tier);
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

  // Potions are the primary survival lever. Onchain:
  //   price = max(1, level - 2*charisma)
  // Keeping price at 1 is a huge economy win and prevents late-run death spirals.
  const minCharForCheapPotions = clampInt(Math.floor(level / 2), 0, MAX_STAT);

  const targets = {
    dexterity: clampInt(Math.ceil(level * config.policy.dexTargetRatio), 0, MAX_STAT),
    vitality: clampInt(Math.ceil(level * config.policy.vitTargetRatio), 0, MAX_STAT),
    charisma: clampInt(
      Math.max(minCharForCheapPotions, Math.ceil(level * (config.policy.chaTargetRatio ?? 0))),
      0,
      MAX_STAT
    ),
    strength: clampInt(Math.ceil(level * config.policy.strTargetRatio), 0, MAX_STAT),
    intelligence: clampInt(Math.ceil(level * config.policy.intTargetRatio), 0, MAX_STAT),
    wisdom: clampInt(Math.ceil(level * config.policy.wisTargetRatio), 0, MAX_STAT)
  };

  while (remaining > 0) {
    if (state.stats.charisma + allocated.charisma < minCharForCheapPotions) {
      allocateStat("charisma", allocated);
    } else if (state.stats.dexterity + allocated.dexterity < targets.dexterity) {
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

function ringLuckValue(item: { id: number; xp: number }) {
  const g = greatnessFromXp(item.xp);
  const base = g;
  const bonus = item.id === ITEM_ID_SILVER_RING ? g : 0;
  return base + bonus;
}

function neckSupportsArmorType(neckId: number, armorType: string) {
  if (armorType === "magic_or_cloth") return neckId === ITEM_ID_AMULET;
  if (armorType === "blade_or_hide") return neckId === ITEM_ID_PENDANT;
  if (armorType === "bludgeon_or_metal") return neckId === ITEM_ID_NECKLACE;
  return false;
}

function jewelryArmorBonus(armorBase: number, neck: { id: number; xp: number } | null, armorType: string) {
  // Onchain: Item::jewelry_armor_bonus => base_armor * (neckGreatness*NECKLACE_ARMOR_BONUS)/100
  // NECKLACE_ARMOR_BONUS = 3
  if (!neck) return 0;
  if (!neckSupportsArmorType(neck.id, armorType)) return 0;
  const neckGreatness = greatnessFromXp(neck.xp);
  return (armorBase * neckGreatness * 3) / 100;
}

function elementalMultiplier(weaponType: string, armorType: string) {
  // Onchain: get_elemental_effectiveness + ELEMENTAL_DAMAGE_BONUS(=2)
  // Weak => 0.5, Fair => 1, Strong => 1.5
  if (!weaponType || weaponType === "none") return 1;
  if (!armorType || armorType === "none") return 1.5;
  if (weaponType === "magic_or_cloth") {
    if (armorType === "blade_or_hide") return 0.5;
    if (armorType === "bludgeon_or_metal") return 1.5;
    return 1;
  }
  if (weaponType === "blade_or_hide") {
    if (armorType === "magic_or_cloth") return 1.5;
    if (armorType === "bludgeon_or_metal") return 0.5;
    return 1;
  }
  if (weaponType === "bludgeon_or_metal") {
    if (armorType === "magic_or_cloth") return 0.5;
    if (armorType === "blade_or_hide") return 1.5;
    return 1;
  }
  return 1;
}

function beastTypeFromId(id: number) {
  if (id >= 1 && id <= 25) return "magic_or_cloth";
  if (id >= 26 && id <= 50) return "blade_or_hide";
  if (id >= 51 && id <= 75) return "bludgeon_or_metal";
  return "none";
}

function beastTierFromId(id: number) {
  if (id < 1 || id > 75) return 5;
  const index = ((id - 1) % 25) + 1; // 1..25 within its type group
  if (index <= 5) return 1;
  if (index <= 10) return 2;
  if (index <= 15) return 3;
  if (index <= 20) return 4;
  return 5;
}

function chooseEquipItems(state: DerivedState, lootMeta: LootMetaMap, config: RunnerConfig) {
  const slots = state.equipment;
  const bestBySlot: Record<string, { item: { id: number; xp: number }; score: number }> = {};
  for (const item of state.bagItems) {
    const meta = lootMeta[item.id];
    if (!meta?.slot) continue;
    let score = 0;
    if (meta.slot === "ring") {
      score = ringLuckValue(item);
    } else if (meta.slot === "neck") {
      // Luck-only; armor synergy is handled during combat where the armor piece is known.
      score = greatnessFromXp(item.xp);
    } else {
      score = baseCombatPower(item, meta);
    }
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
    let currentScore = 0;
    if (slot === "ring") {
      currentScore = ringLuckValue(currentItem);
    } else if (slot === "neck") {
      currentScore = greatnessFromXp(currentItem.xp);
    } else {
      currentScore = baseCombatPower(currentItem, currentMeta);
    }
    const upgradeThreshold = 1 + config.policy.equipUpgradeThreshold;
    if (candidate.score > currentScore * upgradeThreshold) toEquip.push(candidate.item.id);
  }
  return toEquip;
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

function potionReserveGold(state: DerivedState, config: RunnerConfig) {
  // Keep enough gold to buy a meaningful heal even after a gear purchase.
  const unitPrice = potionPrice(state.level, state.stats.charisma);
  const reservePotions = clampInt(Math.ceil(state.maxHp * 0.5 / POTION_HEALTH_AMOUNT), 6, 30);
  return unitPrice * reservePotions;
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

function dominantArmorType(state: DerivedState, lootMeta: LootMetaMap) {
  const armorSlots = ["chest", "head", "waist", "foot", "hand"] as const;
  const totals: Record<string, number> = {};
  for (const slot of armorSlots) {
    const item = (state.equipment as any)[slot] as { id: number; xp: number } | null;
    if (!item) continue;
    const meta = lootMeta[item.id];
    if (!meta?.itemType) continue;
    const value = baseCombatPower(item, meta);
    totals[meta.itemType] = (totals[meta.itemType] ?? 0) + value;
  }
  let bestType: string | null = null;
  let best = -1;
  for (const [t, value] of Object.entries(totals)) {
    if (value > best) {
      best = value;
      bestType = t;
    }
  }
  return bestType;
}

function estimateAttackDamage(
  state: DerivedState,
  lootMeta: LootMetaMap
) {
  const weapon = state.equipment.weapon;
  if (!weapon) return MINIMUM_DAMAGE_TO_BEASTS;
  const meta = lootMeta[weapon.id];
  if (!meta) return MINIMUM_DAMAGE_TO_BEASTS;
  const beastTier = beastTierFromId(state.beast.id);
  const beastType = beastTypeFromId(state.beast.id);
  const baseAttack = baseCombatPower(weapon, meta);
  const weaponType = meta.itemType;
  const elemental = baseAttack * elementalMultiplier(weaponType, beastType);
  const strengthFactor = 1 + state.stats.strength / 10;
  const critProb = Math.min(1, Math.max(0, state.stats.luck) / 100);
  const totalAttack = elemental * (strengthFactor + critProb);
  const beastArmor = state.beast.level * tierMultiplier(beastTier);
  const dmg = Math.max(MINIMUM_DAMAGE_TO_BEASTS, Math.floor(totalAttack - beastArmor));
  return dmg;
}

function estimateBeastDamagePerHit(state: DerivedState, lootMeta: LootMetaMap) {
  const armorSlots = ["chest", "head", "waist", "foot", "hand"] as const;
  const beastTier = beastTierFromId(state.beast.id);
  const beastType = beastTypeFromId(state.beast.id);
  const baseAttack = state.beast.level * tierMultiplier(beastTier);
  const critProb = Math.min(1, Math.max(0, state.level) / 100);
  const neck = state.equipment.neck;

  let total = 0;
  for (const slot of armorSlots) {
    const armor = (state.equipment as any)[slot] as { id: number; xp: number } | null;
    let armorBase = 0;
    let armorType = "none";
    if (armor) {
      const meta = lootMeta[armor.id];
      if (meta) {
        armorBase = baseCombatPower(armor, meta);
        armorType = meta.itemType || "none";
      }
    }
    const elemental = baseAttack * elementalMultiplier(beastType, armorType);
    const totalAttack = elemental * (1 + critProb);
    let dmg = Math.max(MINIMUM_DAMAGE_FROM_BEASTS, Math.floor(totalAttack - armorBase));
    const bonus = jewelryArmorBonus(armorBase, neck, armorType);
    dmg = Math.max(MINIMUM_DAMAGE_FROM_BEASTS, Math.floor(dmg - bonus));
    total += dmg;
  }
  return Math.max(MINIMUM_DAMAGE_FROM_BEASTS, total / armorSlots.length);
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
    const estHit = estimateAttackDamage(state, lootMeta);
    const estIncoming = estimateBeastDamagePerHit(state, lootMeta);
    const turnsToKill = estHit > 0 ? Math.ceil(state.beast.health / estHit) : 99;
    const expectedFightDamage = estIncoming * Math.max(0, turnsToKill - 1);
    const expectedFleeDamage = (1 - state.fleeChance) * estIncoming;

    // Survival-first: if the projected fight cost is high, prefer a flee attempt (when it has a
    // non-trivial chance to succeed). Otherwise, attack to reduce exposure to repeated flee fails.
    if (turnsToKill >= 7 && state.fleeChance >= 0.55) {
      return { type: "flee", reason: `slow kill (${turnsToKill} turns) and fleeChance ${state.fleeChance.toFixed(2)}` };
    }
    if (expectedFightDamage >= state.hp * 0.8 && state.fleeChance >= 0.45 && expectedFleeDamage < expectedFightDamage) {
      return { type: "flee", reason: `expected fight damage ${expectedFightDamage.toFixed(1)} too high for hp ${state.hp}` };
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
    const reserveGold = potionReserveGold(state, config);

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

    const marketEntries = state.market
      .filter((id) => !owned.has(id))
      .map((id) => ({ id, meta: lootMeta[id] }))
      .filter((entry) => entry.meta?.slot);

    const canAfford = (tier: number) => {
      const price = itemPriceForTier(tier, state.stats.charisma);
      return state.gold >= price && state.gold - price >= reserveGold;
    };

    const armorSlots = ["chest", "head", "waist", "foot", "hand"] as const;
    const weaponChoices = marketEntries.filter((e) => e.meta.slot === "weapon").filter((e) => canAfford(e.meta.tier));
    if (weaponChoices.length > 0 && state.equipment.weapon) {
      const currentWeaponMeta = lootMeta[state.equipment.weapon.id];
      const currentTier = currentWeaponMeta?.tier ?? 5;
      const currentGreatness = greatnessFromXp(state.equipment.weapon.xp);

      // "Buy a real weapon immediately" strategy:
      // - Starting weapons are always Tier T5. Buying a high-tier weapon early avoids wasting item XP
      //   on something you will discard later (since greatness grows with sqrt(xp)).
      // - We prefer T1 if present, but will still take the best available tier.
      const best = weaponChoices.sort((a, b) => a.meta.tier - b.meta.tier)[0]!;
      const bestTier = best.meta.tier;
      const tierUpgrade = bestTier > 0 && bestTier < currentTier;

      const firstMarketWindow = state.actionCount <= 5 && currentTier >= 4;
      const earlyT1Investment = bestTier === 1 && currentTier > 1 && state.level <= 12 && currentGreatness <= 8;

      // Default heuristic for later in the run: only swap if it is an immediate power win.
      const currentPower = currentWeaponMeta ? baseCombatPower(state.equipment.weapon, currentWeaponMeta) : 0;
      const bestPower = tierMultiplier(bestTier); // market items start at greatness 1
      const immediatePowerUpgrade = bestPower > currentPower * (1 + Math.max(0.25, config.policy.equipUpgradeThreshold));

      if (tierUpgrade && (firstMarketWindow || earlyT1Investment || immediatePowerUpgrade)) {
        const price = itemPriceForTier(bestTier, state.stats.charisma);
        return {
          type: "buyItems",
          reason: `weapon-first upgrade (tier ${currentTier} -> ${bestTier}) (price ${price}, reserve ${reserveGold})`,
          payload: { items: [{ item_id: best.id, equip: true }], potions: 0 }
        };
      }
    }

    const emptyArmorSlots = armorSlots.filter((slot) => !(state.equipment as any)[slot]);

    // 1) Fill empty armor slots first (biggest survivability delta).
    if (emptyArmorSlots.length > 0) {
      const candidates = marketEntries
        .filter((e) => armorSlots.includes(e.meta.slot as any) && emptyArmorSlots.includes(e.meta.slot as any))
        .filter((e) => canAfford(e.meta.tier));
      if (candidates.length > 0) {
        const best = candidates.sort((a, b) => tierMultiplier(b.meta.tier) - tierMultiplier(a.meta.tier))[0]!;
        const price = itemPriceForTier(best.meta.tier, state.stats.charisma);
        return {
          type: "buyItems",
          reason: `fill empty armor slot ${best.meta.slot} (price ${price}, reserve ${reserveGold})`,
          payload: { items: [{ item_id: best.id, equip: true }], potions: 0 }
        };
      }
    }

    // 2) Ensure a ring (prefer silver ring early).
    if (!state.equipment.ring) {
      const ringChoices = marketEntries.filter((e) => e.meta.slot === "ring").filter((e) => canAfford(e.meta.tier));
      if (ringChoices.length > 0) {
        const silver = ringChoices.find((e) => e.id === ITEM_ID_SILVER_RING);
        const pick = silver ?? ringChoices.sort((a, b) => tierMultiplier(b.meta.tier) - tierMultiplier(a.meta.tier))[0]!;
        const price = itemPriceForTier(pick.meta.tier, state.stats.charisma);
        return {
          type: "buyItems",
          reason: `buy ring ${pick.id} (price ${price}, reserve ${reserveGold})`,
          payload: { items: [{ item_id: pick.id, equip: true }], potions: 0 }
        };
      }
    } else if (state.equipment.ring && state.equipment.ring.id !== ITEM_ID_SILVER_RING && !owned.has(ITEM_ID_SILVER_RING)) {
      const silver = marketEntries.find((e) => e.id === ITEM_ID_SILVER_RING && e.meta.slot === "ring" && canAfford(e.meta.tier));
      if (silver) {
        const price = itemPriceForTier(silver.meta.tier, state.stats.charisma);
        return {
          type: "buyItems",
          reason: `upgrade to silver ring (price ${price}, reserve ${reserveGold})`,
          payload: { items: [{ item_id: silver.id, equip: true }], potions: 0 }
        };
      }
    }

    // 3) Ensure a neck item, preferring one that matches our dominant armor type.
    if (!state.equipment.neck) {
      const neckChoices = marketEntries.filter((e) => e.meta.slot === "neck").filter((e) => canAfford(e.meta.tier));
      if (neckChoices.length > 0) {
        const dominantType = dominantArmorType(state, lootMeta);
        const preferredId =
          dominantType === "magic_or_cloth"
            ? ITEM_ID_AMULET
            : dominantType === "blade_or_hide"
              ? ITEM_ID_PENDANT
              : dominantType === "bludgeon_or_metal"
                ? ITEM_ID_NECKLACE
                : null;
        const preferred = preferredId ? neckChoices.find((e) => e.id === preferredId) : null;
        const pick = preferred ?? neckChoices.sort((a, b) => tierMultiplier(b.meta.tier) - tierMultiplier(a.meta.tier))[0]!;
        const price = itemPriceForTier(pick.meta.tier, state.stats.charisma);
        return {
          type: "buyItems",
          reason: `buy neck ${pick.id} (price ${price}, reserve ${reserveGold})`,
          payload: { items: [{ item_id: pick.id, equip: true }], potions: 0 }
        };
      }
    }

    // 4) Opportunistic armor upgrades (avoid churn).
    const upgradeThreshold = 1 + config.policy.equipUpgradeThreshold;
    let bestUpgrade:
      | { id: number; slot: string; tier: number; currentPower: number; candidatePower: number; price: number }
      | null = null;
    for (const entry of marketEntries) {
      const slot = entry.meta.slot;
      if (!armorSlots.includes(slot as any)) continue;
      if (!canAfford(entry.meta.tier)) continue;
      const current = (state.equipment as any)[slot] as { id: number; xp: number } | null;
      const currentMeta = current ? lootMeta[current.id] : null;
      const currentPower = current && currentMeta ? baseCombatPower(current, currentMeta) : 0;
      const candidatePower = tierMultiplier(entry.meta.tier); // greatness 1
      if (currentPower === 0 || candidatePower > currentPower * upgradeThreshold) {
        const price = itemPriceForTier(entry.meta.tier, state.stats.charisma);
        if (!bestUpgrade || candidatePower - currentPower > bestUpgrade.candidatePower - bestUpgrade.currentPower) {
          bestUpgrade = { id: entry.id, slot, tier: entry.meta.tier, currentPower, candidatePower, price };
        }
      }
    }
    if (bestUpgrade) {
      return {
        type: "buyItems",
        reason: `armor upgrade for ${bestUpgrade.slot} (power ${bestUpgrade.candidatePower} > ${bestUpgrade.currentPower.toFixed(1)}) (price ${bestUpgrade.price}, reserve ${reserveGold})`,
        payload: { items: [{ item_id: bestUpgrade.id, equip: true }], potions: 0 }
      };
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
