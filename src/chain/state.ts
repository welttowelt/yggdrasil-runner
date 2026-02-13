import { RunnerConfig } from "../config/schema.js";
import { ChainGameState } from "./client.js";

function toNumber(value: any): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    if (value.startsWith("0x")) return parseInt(value, 16);
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function cairoBool(value: any): boolean {
  if (typeof value === "boolean") return value;
  if (value && typeof value === "object") {
    if ("True" in value) return true;
    if ("False" in value) return false;
  }
  return Boolean(value);
}

export type DerivedState = {
  adventurerId: number;
  level: number;
  hp: number;
  maxHp: number;
  hpPct: number;
  gold: number;
  xp: number;
  actionCount: number;
  statUpgrades: number;
  vrfPending: boolean;
  fleeChance: number;
  avoidObstacleChance: number;
  avoidAmbushChance: number;
  stats: {
    strength: number;
    dexterity: number;
    vitality: number;
    intelligence: number;
    wisdom: number;
    charisma: number;
    luck: number;
  };
  beast: {
    id: number;
    health: number;
    level: number;
    isCollectable: boolean;
    seed: string | null;
  };
  inCombat: boolean;
  market: number[];
  bagItems: Array<{ id: number; xp: number }>;
  equipment: {
    weapon: { id: number; xp: number } | null;
    chest: { id: number; xp: number } | null;
    head: { id: number; xp: number } | null;
    waist: { id: number; xp: number } | null;
    foot: { id: number; xp: number } | null;
    hand: { id: number; xp: number } | null;
    neck: { id: number; xp: number } | null;
    ring: { id: number; xp: number } | null;
  };
};

function parseItem(item: any): { id: number; xp: number } | null {
  if (!item) return null;
  const id = toNumber(item.id);
  if (!id) return null;
  return { id, xp: toNumber(item.xp) };
}

export function deriveState(config: RunnerConfig, adventurerId: number, state: ChainGameState): DerivedState {
  const adv = state.adventurer;
  const stats = adv.stats ?? {};
  const hp = toNumber(adv.health);
  const xp = toNumber(adv.xp);
  const liveBeastHealth = toNumber(adv.beast_health);
  const vitality = toNumber(stats.vitality);
  const maxHp = config.policy.hpBase + config.policy.hpPerVitality * vitality;
  const hpPct = maxHp > 0 ? hp / maxHp : 1;
  // Loot Survivor 2 derives level from XP onchain:
  //   level = 1 if xp == 0 else floor(sqrt(xp))
  // Keep this aligned with `ImplCombat::get_level_from_xp`.
  const level = xp <= 0 ? 1 : Math.max(1, Math.floor(Math.sqrt(xp)));
  const fleeChance = Math.min(1, toNumber(stats.dexterity) / Math.max(1, level));
  const avoidObstacleChance = Math.min(1, toNumber(stats.intelligence) / Math.max(1, level));
  const avoidAmbushChance = Math.min(1, toNumber(stats.wisdom) / Math.max(1, level));

  const beast = state.beast ?? {};
  const beastHealth = liveBeastHealth > 0 ? liveBeastHealth : 0;
  const beastLevel = toNumber(beast.level);
  const beastId = toNumber(beast.id);
  const beastSeedRaw = (beast as any).seed ?? null;
  const beastSeed =
    typeof beastSeedRaw === "string"
      ? beastSeedRaw
      : typeof beastSeedRaw === "bigint"
        ? beastSeedRaw.toString()
        : beastSeedRaw != null
          ? String(beastSeedRaw)
          : null;
  // Do not infer VRF readiness from `beast.seed`. That value is persisted entropy used to
  // deterministically derive beasts/market, and can legitimately equal `adventurerId` (starter beast).
  // We instead treat VRF readiness as unknown and rely on preflight/revert signals.
  const vrfPending = false;

  const market = Array.isArray(state.market)
    ? state.market.map((v: any) => toNumber(v)).filter((v) => v > 0)
    : [];

  const bag = state.bag ?? {};
  const bagItems = Object.keys(bag)
    .filter((k) => k.startsWith("item_"))
    .map((k) => parseItem((bag as any)[k]))
    .filter((v): v is { id: number; xp: number } => !!v);

  const equipment = adv.equipment ?? {};

  return {
    adventurerId,
    level,
    hp,
    maxHp,
    hpPct,
    gold: toNumber(adv.gold),
    xp,
    actionCount: toNumber(adv.action_count),
    statUpgrades: toNumber(adv.stat_upgrades_available),
    vrfPending,
    fleeChance,
    avoidObstacleChance,
    avoidAmbushChance,
    stats: {
      strength: toNumber(stats.strength),
      dexterity: toNumber(stats.dexterity),
      vitality: toNumber(stats.vitality),
      intelligence: toNumber(stats.intelligence),
      wisdom: toNumber(stats.wisdom),
      charisma: toNumber(stats.charisma),
      luck: toNumber(stats.luck)
    },
    beast: {
      id: beastId,
      health: beastHealth,
      level: beastLevel,
      isCollectable: cairoBool(beast.is_collectable),
      seed: beastSeed
    },
    inCombat: liveBeastHealth > 0,
    market,
    bagItems,
    equipment: {
      weapon: parseItem(equipment.weapon),
      chest: parseItem(equipment.chest),
      head: parseItem(equipment.head),
      waist: parseItem(equipment.waist),
      foot: parseItem(equipment.foot),
      hand: parseItem(equipment.hand),
      neck: parseItem(equipment.neck),
      ring: parseItem(equipment.ring)
    }
  };
}
