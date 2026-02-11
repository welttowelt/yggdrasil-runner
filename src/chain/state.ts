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
  hp: number;
  maxHp: number;
  hpPct: number;
  gold: number;
  xp: number;
  actionCount: number;
  statUpgrades: number;
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
  };
  inCombat: boolean;
  market: number[];
  bagItems: number[];
};

export function deriveState(config: RunnerConfig, adventurerId: number, state: ChainGameState): DerivedState {
  const adv = state.adventurer;
  const stats = adv.stats ?? {};
  const hp = toNumber(adv.health);
  const vitality = toNumber(stats.vitality);
  const maxHp = config.policy.hpBase + config.policy.hpPerVitality * vitality;
  const hpPct = maxHp > 0 ? hp / maxHp : 1;

  const beast = state.beast ?? {};
  const beastHealth = toNumber(beast.health);
  const beastLevel = toNumber(beast.level);
  const beastId = toNumber(beast.id);

  const market = Array.isArray(state.market)
    ? state.market.map((v: any) => toNumber(v)).filter((v) => v > 0)
    : [];

  const bag = state.bag ?? {};
  const bagItems = Object.keys(bag)
    .filter((k) => k.startsWith("item_"))
    .map((k) => toNumber((bag as any)[k]?.id))
    .filter((v) => v > 0);

  return {
    adventurerId,
    hp,
    maxHp,
    hpPct,
    gold: toNumber(adv.gold),
    xp: toNumber(adv.xp),
    actionCount: toNumber(adv.action_count),
    statUpgrades: toNumber(adv.stat_upgrades_available),
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
      isCollectable: cairoBool(beast.is_collectable)
    },
    inCombat: beastHealth > 0,
    market,
    bagItems
  };
}
