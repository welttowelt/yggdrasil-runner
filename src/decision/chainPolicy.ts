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

function clampFloat(value: number, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function pickStats(state: DerivedState, config: RunnerConfig): Record<string, number> {
  const upgrades = state.statUpgrades;
  const allocated = baseStats();
  let remaining = upgrades;
  const level = Math.max(1, state.level);
  const midgame = level >= 12;

  // Potions are the primary survival lever. Onchain:
  //   price = max(1, level - 2*charisma)
  // Keeping price at 1 is a huge economy win and prevents late-run death spirals.
  const minCharForCheapPotions = clampInt(Math.floor(level / 2), 0, MAX_STAT);

  // Mid/late game: exploration deaths (obstacles/ambush) dominate, and their avoid checks scale
  // with INT/WIS relative to level. Gradually bias targets upward after ~level 12.
  const intRatioBase = Math.max(0, config.policy.intTargetRatio);
  const wisRatioBase = Math.max(0, config.policy.wisTargetRatio);
  const lateIntWisRatio = 0.55;
  const intWisT = clampFloat((level - 12) / 18, 0, 1);
  const intRatio = midgame ? lerp(intRatioBase, Math.max(intRatioBase, lateIntWisRatio), intWisT) : intRatioBase;
  const wisRatio = midgame ? lerp(wisRatioBase, Math.max(wisRatioBase, lateIntWisRatio), intWisT) : wisRatioBase;

  const targets = {
    dexterity: clampInt(Math.ceil(level * config.policy.dexTargetRatio), 0, MAX_STAT),
    vitality: clampInt(Math.ceil(level * config.policy.vitTargetRatio), 0, MAX_STAT),
    charisma: clampInt(
      Math.max(minCharForCheapPotions, Math.ceil(level * (config.policy.chaTargetRatio ?? 0))),
      0,
      MAX_STAT
    ),
    strength: clampInt(Math.ceil(level * config.policy.strTargetRatio), 0, MAX_STAT),
    intelligence: clampInt(Math.ceil(level * intRatio), 0, MAX_STAT),
    wisdom: clampInt(Math.ceil(level * wisRatio), 0, MAX_STAT)
  };

  while (remaining > 0) {
    if (state.stats.charisma + allocated.charisma < minCharForCheapPotions) {
      allocateStat("charisma", allocated);
    } else if (state.stats.dexterity + allocated.dexterity < targets.dexterity) {
      allocateStat("dexterity", allocated);
    } else if (state.stats.vitality + allocated.vitality < targets.vitality) {
      allocateStat("vitality", allocated);
    } else if (midgame && state.stats.intelligence + allocated.intelligence < targets.intelligence) {
      allocateStat("intelligence", allocated);
    } else if (midgame && state.stats.wisdom + allocated.wisdom < targets.wisdom) {
      allocateStat("wisdom", allocated);
    } else if (state.stats.charisma + allocated.charisma < targets.charisma) {
      allocateStat("charisma", allocated);
    } else if (state.stats.strength + allocated.strength < targets.strength) {
      allocateStat("strength", allocated);
    } else if (!midgame && state.stats.intelligence + allocated.intelligence < targets.intelligence) {
      allocateStat("intelligence", allocated);
    } else if (!midgame && state.stats.wisdom + allocated.wisdom < targets.wisdom) {
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

  // Higher-tier items (T1 is best) have a much higher ceiling once they accumulate XP (greatness).
  // For non-jewelry gear, include a small future-potential premium, gated to avoid equipping items
  // that are meaningfully weaker right now.
  const targetLevel = Math.max(1, config.policy.targetLevel);
  const remainingLevels = Math.max(0, targetLevel - Math.max(1, state.level));
  const horizon = Math.min(1, remainingLevels / targetLevel);
  const potentialBias = Math.max(0, config.policy.equipPotentialBias) * horizon;
  const withinBestPct = Math.max(0, Math.min(1, config.policy.equipPotentialWithinBestPct));
  const maxImmediateDropPct = Math.max(0, Math.min(0.5, config.policy.equipPotentialMaxImmediateDropPct));

  const scoreFor = (item: { id: number; xp: number }, meta: LootMetaMap[number], slot: string) => {
    if (slot === "ring") {
      const immediate = ringLuckValue(item);
      return { immediate, effective: immediate };
    }
    if (slot === "neck") {
      const immediate = greatnessFromXp(item.xp);
      return { immediate, effective: immediate };
    }

    const immediate = baseCombatPower(item, meta);
    if (!potentialBias) return { immediate, effective: immediate };

    const g = greatnessFromXp(item.xp);
    const remainingG = Math.max(0, 20 - g);
    const tierMult = tierMultiplier(meta.tier);
    const potentialBonus = remainingG * tierMult * potentialBias;
    return { immediate, effective: immediate + potentialBonus };
  };

  type Candidate = {
    item: { id: number; xp: number };
    meta: LootMetaMap[number];
    immediate: number;
    effective: number;
  };

  const candidatesBySlot: Record<string, Candidate[]> = {};
  for (const item of state.bagItems) {
    const meta = lootMeta[item.id];
    if (!meta?.slot) continue;
    const slot = meta.slot;
    const { immediate, effective } = scoreFor(item, meta, slot);
    (candidatesBySlot[slot] ??= []).push({ item, meta, immediate, effective });
  }

  const bestBySlot: Record<string, Candidate> = {};
  for (const [slot, candidates] of Object.entries(candidatesBySlot)) {
    if (candidates.length === 0) continue;

    if (slot === "ring" || slot === "neck" || !potentialBias) {
      bestBySlot[slot] = candidates.sort((a, b) => b.immediate - a.immediate)[0]!;
      continue;
    }

    const bestImmediate = Math.max(...candidates.map((c) => c.immediate));
    const minImmediate = bestImmediate * (1 - withinBestPct);
    const pool = candidates.filter((c) => c.immediate >= minImmediate);
    const pickFrom = pool.length > 0 ? pool : candidates;
    bestBySlot[slot] = pickFrom.sort((a, b) => (b.effective - a.effective) || (b.immediate - a.immediate))[0]!;
  }

  const toEquip: number[] = [];
  for (const [slot, candidate] of Object.entries(bestBySlot)) {
    const currentItem = (slots as Record<string, { id: number; xp: number } | null>)[slot] ?? null;
    const currentMeta = currentItem ? lootMeta[currentItem.id] : null;
    if (!currentItem || !currentMeta) {
      toEquip.push(candidate.item.id);
      continue;
    }

    const currentScores = scoreFor(currentItem, currentMeta, slot);
    const upgradeThreshold = 1 + config.policy.equipUpgradeThreshold;

    if (candidate.immediate > currentScores.immediate * upgradeThreshold) {
      toEquip.push(candidate.item.id);
      continue;
    }

    // Long-run tier upgrade: allow a small immediate downgrade if the tier is better (T1<T2<...<T5),
    // because XP accrues to the equipped item and a higher tier compounds that XP harder.
    if (slot !== "ring" && slot !== "neck") {
      const tierImproves =
        Number.isFinite(candidate.meta.tier) &&
        Number.isFinite(currentMeta.tier) &&
        candidate.meta.tier > 0 &&
        currentMeta.tier > 0 &&
        candidate.meta.tier < currentMeta.tier;
      const notTooMuchWorse = candidate.immediate >= currentScores.immediate * (1 - maxImmediateDropPct);
      const effectiveImproves = candidate.effective > currentScores.effective * 1.02;
      if (tierImproves && notTooMuchWorse && effectiveImproves) {
        toEquip.push(candidate.item.id);
      }
    }
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

function marketHealTargetPct(state: DerivedState, config: RunnerConfig, unitPrice: number) {
  const base = clampFloat(config.policy.buyPotionIfBelowPct, 0, 1);
  // When potions cost 1 gold, topping off becomes cheap. At higher levels, exploration can chain
  // multiple hazards in one action (especially `tillBeast=true`), so keep HP closer to full.
  if (unitPrice > 1) return base;
  const level = Math.max(1, state.level);
  if (level < 10) return base;
  const maxTarget = 0.95;
  const t = clampFloat((level - 10) / 20, 0, 1); // 10->30 maps to 0..1
  return clampFloat(lerp(base, maxTarget, t), base, maxTarget);
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

function combatMetrics(state: DerivedState, lootMeta: LootMetaMap, config: RunnerConfig) {
  const estHit = estimateAttackDamage(state, lootMeta);
  const estIncoming = estimateBeastDamagePerHit(state, lootMeta);
  const turnsToKill = estHit > 0 ? Math.ceil(state.beast.health / estHit) : 99;
  const expectedFightDamage = estIncoming * Math.max(0, turnsToKill - 1);
  const expectedFleeDamage = (1 - state.fleeChance) * estIncoming;

  let shouldFlee = false;
  let reason = "attack";

  if (state.beast.level > Math.max(1, state.level) * config.policy.maxBeastLevelRatio && state.hpPct < 0.9) {
    shouldFlee = true;
    reason = `beast level ${state.beast.level} too high for level ${state.level}`;
  } else if (turnsToKill >= 7 && state.fleeChance >= 0.55) {
    shouldFlee = true;
    reason = `slow kill (${turnsToKill} turns) and fleeChance ${state.fleeChance.toFixed(2)}`;
  } else if (
    expectedFightDamage >= state.hp * 0.8 &&
    state.fleeChance >= 0.45 &&
    expectedFleeDamage < expectedFightDamage
  ) {
    shouldFlee = true;
    reason = `expected fight damage ${expectedFightDamage.toFixed(1)} too high for hp ${state.hp}`;
  } else if (state.hpPct < config.policy.fleeBelowHpPct) {
    if (state.fleeChance >= config.policy.minFleeChance || state.hpPct < config.policy.fleeBelowHpPct * 0.7) {
      shouldFlee = true;
      reason = `hp ${state.hpPct.toFixed(2)} below flee threshold`;
    }
  }

  return {
    estHit,
    estIncoming,
    turnsToKill,
    expectedFightDamage,
    expectedFleeDamage,
    shouldFlee,
    reason
  };
}

function chooseCombatEquipItems(state: DerivedState, lootMeta: LootMetaMap) {
  const bagIds = new Set(state.bagItems.map((item) => item.id));

  const weaponCandidates = state.bagItems
    .filter((item) => lootMeta[item.id]?.slot === "weapon")
    .concat(state.equipment.weapon ? [state.equipment.weapon] : []);

  let bestWeapon = state.equipment.weapon;
  let bestHit = estimateAttackDamage(state, lootMeta);
  for (const candidate of weaponCandidates) {
    if (!candidate) continue;
    const altState = {
      ...state,
      equipment: { ...state.equipment, weapon: candidate }
    };
    const hit = estimateAttackDamage(altState, lootMeta);
    if (hit > bestHit) {
      bestHit = hit;
      bestWeapon = candidate;
    }
  }

  const armorSlots = ["chest", "head", "waist", "foot", "hand"] as const;
  const bestArmor: Partial<DerivedState["equipment"]> = {};
  for (const slot of armorSlots) {
    const current = (state.equipment as any)[slot] as { id: number; xp: number } | null;
    const candidates = state.bagItems.filter((item) => lootMeta[item.id]?.slot === slot).concat(current ? [current] : []);
    let best = current;
    let bestDmg = Infinity;
    for (const candidate of candidates) {
      if (!candidate) continue;
      const altState = {
        ...state,
        equipment: { ...state.equipment, [slot]: candidate }
      } as DerivedState;
      // Estimate slot impact by looking at the full incoming average after swapping just this slot.
      const incoming = estimateBeastDamagePerHit(altState, lootMeta);
      if (incoming < bestDmg) {
        bestDmg = incoming;
        best = candidate;
      }
    }
    if (best) (bestArmor as any)[slot] = best;
  }

  const neckCandidates = state.bagItems
    .filter((item) => lootMeta[item.id]?.slot === "neck")
    .concat(state.equipment.neck ? [state.equipment.neck] : []);

  let bestNeck = state.equipment.neck;
  let bestIncoming = Infinity;
  for (const candidate of neckCandidates) {
    const altState = {
      ...state,
      equipment: {
        ...state.equipment,
        ...bestArmor,
        weapon: bestWeapon ?? state.equipment.weapon,
        neck: candidate ?? null
      }
    };
    const incoming = estimateBeastDamagePerHit(altState, lootMeta);
    if (incoming < bestIncoming) {
      bestIncoming = incoming;
      bestNeck = candidate ?? null;
    }
  }

  const desiredEquipment: DerivedState["equipment"] = {
    ...state.equipment,
    ...bestArmor,
    weapon: bestWeapon ?? state.equipment.weapon,
    neck: bestNeck ?? state.equipment.neck
  };

  const toEquip: number[] = [];
  const slots = Object.keys(desiredEquipment) as Array<keyof DerivedState["equipment"]>;
  for (const slot of slots) {
    const desired = desiredEquipment[slot];
    const current = state.equipment[slot];
    if (!desired) continue;
    if (current?.id === desired.id) continue;
    if (bagIds.has(desired.id)) {
      toEquip.push(desired.id);
    }
  }

  return { toEquip, desiredEquipment };
}

export function decideChainAction(
  state: DerivedState,
  config: RunnerConfig,
  lootMeta: LootMetaMap,
  context: { considerEquip?: boolean } = {}
): ChainAction {
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
    const current = combatMetrics(state, lootMeta, config);

    // Optional combat loadout swap: equipping in battle triggers a beast counterattack onchain,
    // so we only do it if it meaningfully improves survival vs the current beast.
    if (context.considerEquip !== false && state.bagItems.length > 0 && state.hpPct >= config.policy.minHpToFightPct) {
      const { toEquip, desiredEquipment } = chooseCombatEquipItems(state, lootMeta);
      if (toEquip.length > 0 && toEquip.length <= 8) {
        const altState = { ...state, equipment: desiredEquipment };
        const alt = combatMetrics(altState, lootMeta, config);

        // Equipping costs one extra beast attack (counterattack), but uses the new equipment for
        // that hit. Approximate "equip + fight" expected damage as N beast attacks where N is the
        // number of attacks required to kill.
        const altDamageWithEquip = alt.estIncoming * alt.turnsToKill;
        const currentDamageNoEquip = current.expectedFightDamage;

        const hasHpBuffer = state.hp > alt.estIncoming * 1.2;
        const improvesEnough =
          (!current.shouldFlee && altDamageWithEquip < currentDamageNoEquip * 0.85) ||
          (current.shouldFlee && !alt.shouldFlee && altDamageWithEquip < state.hp * 0.8);

        if (hasHpBuffer && improvesEnough) {
          return {
            type: "equip",
            reason: `combat loadout swap vs beast ${state.beast.id} (turns ${current.turnsToKill}→${alt.turnsToKill}, incoming ${current.estIncoming.toFixed(1)}→${alt.estIncoming.toFixed(1)})`,
            payload: { items: toEquip }
          };
        }
      }
    }

    if (current.shouldFlee) {
      return { type: "flee", reason: current.reason };
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

    const unitPrice = potionPrice(state.level, state.stats.charisma);
    const healTargetPct = marketHealTargetPct(state, config, unitPrice);
    if (state.hpPct < healTargetPct) {
      if (state.hp >= state.maxHp) {
        // Prevent wasteful purchases that can revert with HEALTH_FULL.
      } else if (state.gold >= unitPrice) {
        // Buy enough in a single action to cross the threshold; buying potions is immediate heal onchain.
        const targetHp = Math.ceil(healTargetPct * state.maxHp);
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
        .map((e) => ({
          ...e,
          price: itemPriceForTier(e.meta.tier, state.stats.charisma)
        }))
        .filter((e) => Number.isFinite(e.price) && e.price > 0 && state.gold - e.price >= reserveGold);

      if (candidates.length > 0) {
        // Coverage-first gold management: avoid spending so much on a single slot that we can't
        // reasonably cover the remaining empty slots. Filling 5 mediocre slots reduces damage
        // variance vs filling 1 slot with a high-tier item (attacks are uniform across 5 slots).
        const minFillPrice = itemPriceForTier(5, state.stats.charisma);
        const remainingSlots = Math.max(0, emptyArmorSlots.length - 1);
        const coverageReserve = remainingSlots > 0 && Number.isFinite(minFillPrice) ? minFillPrice * remainingSlots : 0;

        const coverageSafe = candidates.filter((c) => state.gold - c.price >= reserveGold + coverageReserve);
        const pool = coverageSafe.length > 0 ? coverageSafe : candidates;

        const best = pool.sort((a, b) => {
          if (a.price !== b.price) return a.price - b.price; // cheaper first to maximize slot coverage
          return a.meta.tier - b.meta.tier; // tie-break: better tier (T1 < T5)
        })[0]!;

        return {
          type: "buyItems",
          reason: `fill empty armor slot ${best.meta.slot} (price ${best.price}, reserve ${reserveGold})`,
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

  if (context.considerEquip !== false && state.bagItems.length > 0) {
    const equipItems = chooseEquipItems(state, lootMeta, config);
    if (equipItems.length > 0) {
      return { type: "equip", reason: "equip upgraded items", payload: { items: equipItems } };
    }
  }

  // High-level safety: chained explore (`tillBeast=true`) can stack multiple hazards (obstacles/ambush)
  // in one action. This is a major cause of late-run deaths, so disable it past the midgame.
  const allowTillBeast = state.level < 20;
  const tillBeast = allowTillBeast && state.hpPct >= config.policy.exploreTillBeastPct;
  return { type: "explore", reason: "advance dungeon", payload: { tillBeast } };
}
