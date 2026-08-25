import { UNIT_DEFINITIONS, getUnitDefinition } from "../data/unitDefs";
import { getMaxUnitLevel } from "./economy";
import { getTerritoryRangePenalty as getAreaRangePenalty, getTerritoryRangePenaltyForRange as getAreaRangePenaltyForRange } from "./territory";
import type { GameState, HexCoord, Owner, UnitDefinition, UnitInstance, UnitType } from "./types";

type ScaledStat = "health" | "moveRange" | "attackRange" | "visibilityRange";

export interface EffectiveUnitStats {
  health: number;
  moveRange: number;
  attackRange: number;
  visibilityRange: number;
}

const SPECIALIZED_STAT_PERCENTILE = 2 / 3;
const RANGE_SCALE = 1.3;
const JET_BOMBER_RANGE_BOOST = 1.3;
const FIRE_SUPPORT_DAMAGE_GAIN_PER_UPGRADE_LEVEL = 2;
const FIRE_SUPPORT_DAMAGE_UNITS = new Set<UnitType>(["Anti-Air", "Artillery"]);
const BOOSTED_RANGE_UNITS = new Set<UnitType>(["Jet", "Bomber"]);
const ATTACK_RANGE_MULTIPLIERS: Partial<Record<UnitType, number>> = {
  Operator: 0.7,
  Spectral: 1.3
};
const ATTACK_RANGE_BONUSES: Partial<Record<UnitType, number>> = {
  "Anti-Air": 2,
  Artillery: 2
};
const ATTACK_DAMAGE_MULTIPLIERS: Partial<Record<UnitType, number>> = {
  "Anti-Air": 0.6,
  Artillery: 0.6,
  IFV: 0.7
};
const SPECIALIZED_THRESHOLDS: Record<ScaledStat, number> = {
  health: calculateSpecializedThreshold("health"),
  moveRange: calculateSpecializedThreshold("moveRange"),
  attackRange: calculateSpecializedThreshold("attackRange"),
  visibilityRange: calculateSpecializedThreshold("visibilityRange")
};
const BASE_EFFECTIVE_STATS_CACHE = Object.fromEntries(
  UNIT_DEFINITIONS.map((unit) => [unit.type, []])
) as unknown as Record<UnitType, EffectiveUnitStats[]>;

export function getUnitLevel(state: GameState, owner: Owner, unitType: UnitType, levelOverride?: number): number {
  if (levelOverride !== undefined) {
    return Math.min(getMaxUnitLevel(unitType), Math.max(1, Math.floor(levelOverride)));
  }

  const economy = owner === "Player" ? state.economy : state.enemyEconomy;
  return Math.min(getMaxUnitLevel(unitType), Math.max(1, Math.floor(economy.unitLevels[unitType] ?? 1)));
}

export function getUnitInstanceLevel(state: GameState, unit: UnitInstance): number {
  return getUnitLevel(state, unit.owner, unit.type, unit.level);
}

export function getEffectiveUnitStats(
  state: GameState,
  owner: Owner,
  unitType: UnitType,
  levelOverride?: number,
  coordOverride?: HexCoord,
  targetCoordOverride?: HexCoord
): EffectiveUnitStats {
  const level = getUnitLevel(state, owner, unitType, levelOverride);
  const stats = getBaseEffectiveUnitStats(unitType, level);

  return applyTerritoryRangePenalty(
    stats,
    getTerritoryRangePenaltyForRange(state, owner, coordOverride, targetCoordOverride)
  );
}

export function getBaseEffectiveUnitStats(unitType: UnitType, level = 1): EffectiveUnitStats {
  const normalizedLevel = Math.max(1, Math.floor(level));
  const unitCache = BASE_EFFECTIVE_STATS_CACHE[unitType];
  const cached = unitCache[normalizedLevel];
  if (cached) {
    return cached;
  }

  const definition = getUnitDefinition(unitType);
  const upgradeSteps = normalizedLevel - 1;
  const stats = applyUnitStatModifiers(unitType, {
    health: definition.health + getUpgradeGain(definition, "health", upgradeSteps),
    moveRange: getBoostedRange(unitType, getScaledRange(definition.moveRange + getUpgradeGain(definition, "moveRange", upgradeSteps))),
    attackRange: definition.cannotAttack
      ? 0
      : applyUnitMultiplier(
          getBoostedRange(unitType, getScaledRange(definition.attackRange + getUpgradeGain(definition, "attackRange", upgradeSteps))),
          ATTACK_RANGE_MULTIPLIERS[unitType]
        ),
    visibilityRange: getBoostedRange(unitType, definition.visibilityRange + getUpgradeGain(definition, "visibilityRange", upgradeSteps))
  });
  unitCache[normalizedLevel] = stats;
  return stats;
}

export function getBaseAttackDamage(unitType: UnitType, level = 1): number {
  const definition = getUnitDefinition(unitType);
  if (definition.cannotAttack) {
    return 0;
  }

  const fireSupportUpgradeBonus = FIRE_SUPPORT_DAMAGE_UNITS.has(unitType) ? Math.max(0, level - 1) * FIRE_SUPPORT_DAMAGE_GAIN_PER_UPGRADE_LEVEL : 0;
  const damage = Math.round((4 + (definition.damageBonus ?? 0) + level * 2) * 1.5) + fireSupportUpgradeBonus;
  return applyUnitMultiplier(damage, ATTACK_DAMAGE_MULTIPLIERS[unitType]);
}

export function getScaledRange(range: number): number {
  return Math.max(1, Math.round(range * RANGE_SCALE));
}

function getBoostedRange(unitType: UnitType, range: number): number {
  return BOOSTED_RANGE_UNITS.has(unitType) ? Math.max(1, Math.round(range * JET_BOMBER_RANGE_BOOST)) : range;
}

function applyUnitMultiplier(value: number, multiplier: number | undefined): number {
  return Math.max(1, Math.round(value * (multiplier ?? 1)));
}

function applyUnitStatModifiers(unitType: UnitType, stats: EffectiveUnitStats): EffectiveUnitStats {
  const attackRangeBonus = ATTACK_RANGE_BONUSES[unitType] ?? 0;
  const boostedStats =
    attackRangeBonus > 0
      ? {
          ...stats,
          attackRange: stats.attackRange <= 0 ? 0 : stats.attackRange + attackRangeBonus
        }
      : stats;

  if (unitType === "Supply Truck" || unitType === "Command Heli") {
    return {
      ...boostedStats,
      moveRange: Math.max(1, boostedStats.moveRange - 2)
    };
  }

  if (unitType !== "Tank") {
    return boostedStats;
  }

  return {
    ...boostedStats,
    moveRange: Math.max(1, boostedStats.moveRange - 1),
    attackRange: boostedStats.attackRange <= 0 ? 0 : Math.max(1, boostedStats.attackRange - 2),
    visibilityRange: Math.max(1, boostedStats.visibilityRange - 2)
  };
}

function applyTerritoryRangePenalty(stats: EffectiveUnitStats, penalty: number): EffectiveUnitStats {
  if (penalty <= 0) {
    return stats;
  }

  return {
    ...stats,
    moveRange: Math.max(1, stats.moveRange - penalty),
    attackRange: stats.attackRange <= 0 ? 0 : Math.max(1, stats.attackRange - penalty),
    visibilityRange: Math.max(1, stats.visibilityRange - penalty)
  };
}

export function getTerritoryRangePenalty(state: GameState, owner: Owner, coord: HexCoord | undefined): number {
  return getAreaRangePenalty(state, owner, coord);
}

export function getTerritoryRangePenaltyForRange(
  state: GameState,
  owner: Owner,
  origin: HexCoord | undefined,
  target: HexCoord | undefined
): number {
  return getAreaRangePenaltyForRange(state, owner, origin, target);
}

function getUpgradeGain(definition: UnitDefinition, stat: ScaledStat, upgradeSteps: number): number {
  if (upgradeSteps <= 0) {
    return 0;
  }

  const baseGain = stat === "health" ? 4 : 1;
  const specialistGain = isSpecializedStat(definition, stat) ? baseGain : 0;
  return (baseGain + specialistGain) * upgradeSteps;
}

function isSpecializedStat(definition: UnitDefinition, stat: ScaledStat): boolean {
  return definition[stat] >= getSpecializedThreshold(stat);
}

function getSpecializedThreshold(stat: ScaledStat): number {
  return SPECIALIZED_THRESHOLDS[stat];
}

function calculateSpecializedThreshold(stat: ScaledStat): number {
  const values = UNIT_DEFINITIONS.map((unit) => unit[stat]).sort((first, second) => first - second);
  const index = Math.min(values.length - 1, Math.floor(values.length * SPECIALIZED_STAT_PERCENTILE));
  return values[index];
}
