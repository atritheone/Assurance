import { UNIT_DEFINITIONS, getUnitDefinition } from "../data/unitDefs";
import type { EconomyState, Owner, ResearchJob, ResearchType, UnitInventory, UnitLevelInventory, UnitLevels, UnitType } from "./types";

export const GATE_INCOME_BONUS = 1;
export const ECONOMY_RESEARCH_WORK_MULTIPLIER = 0.8;
export const DESTROYED_UNIT_GAIN_REWARD_DIVISOR = 3;
export const GAIN_RESTRICTED_RESEARCH_TYPES: readonly ResearchType[] = ["UnlockRoom", "UnlockDroneFactory"];
export const GAIN_RESTRICTED_PRODUCTION_UNITS: readonly UnitType[] = ["Spectral", "Reaper"];
const DAILY_UNIT_GAIN_MULTIPLIER = 2;

export function getGateIncomeBonusForEconomy(_economy: EconomyState): number {
  return GATE_INCOME_BONUS;
}

export function canUseGainForResearch(researchType: ResearchType): boolean {
  return !GAIN_RESTRICTED_RESEARCH_TYPES.includes(researchType);
}

export function canUseGainForProduction(unitType: UnitType): boolean {
  return !GAIN_RESTRICTED_PRODUCTION_UNITS.includes(unitType);
}

export function createEmptyInventory(): UnitInventory {
  return Object.fromEntries(UNIT_DEFINITIONS.map((unit) => [unit.type, 0])) as UnitInventory;
}

export function createEmptyUnitLevelInventory(): UnitLevelInventory {
  return Object.fromEntries(UNIT_DEFINITIONS.map((unit) => [unit.type, {}])) as UnitLevelInventory;
}

export function createStartingInventory(owner: Owner = "Player"): UnitInventory {
  return {
    ...createEmptyInventory(),
    Infantry: 6,
    "Anti-Air": 1,
    IFV: 2,
    "Supply Truck": 1,
    Artillery: 1,
    Tank: owner === "Enemy" ? 2 : 1,
    "Attack Heli": 1,
    "Command Heli": 0,
    Spectral: owner === "Player" ? 0 : 0,
    Reaper: owner === "Enemy" ? 0 : 0
  };
}

export function createStartingUnitLevelInventory(owner: Owner = "Player"): UnitLevelInventory {
  const inventory = createStartingInventory(owner);
  const inventoryByLevel = createEmptyUnitLevelInventory();
  for (const unit of UNIT_DEFINITIONS) {
    const count = inventory[unit.type] ?? 0;
    if (count > 0) {
      inventoryByLevel[unit.type][1] = count;
    }
  }
  return inventoryByLevel;
}

export function createUnitLevels(): UnitLevels {
  return Object.fromEntries(UNIT_DEFINITIONS.map((unit) => [unit.type, 1])) as UnitLevels;
}

export function createStartingEconomy(owner: Owner = "Player"): EconomyState {
  return {
    moneyPoundsBn: 50,
    gainPoints: 0,
    incomePoundsBn: 5,
    inventory: createStartingInventory(owner),
    inventoryByLevel: createStartingUnitLevelInventory(owner),
    productionQueue: [],
    lastProductionUnitType: undefined,
    researchQueue: [],
    unitLevels: createUnitLevels(),
    efficiencyLevel: 1,
    productionCapacityLevel: 1,
    researchCapacityLevel: 1,
    productionSpeedLevel: 1,
    researchSpeedLevel: 1
  };
}

export function getProductionCost(unitType: UnitType): number {
  return getUnitDefinition(unitType).costPoundsBn;
}

export function getUnitGainValue(unitType: UnitType, level = 1): number {
  const normalizedLevel = Math.max(1, Math.floor(level));
  const levelMultiplier = 1 + (normalizedLevel - 1) * 0.5;
  return Math.max(1, Math.ceil(getUnitDefinition(unitType).gainValue * levelMultiplier));
}

export function getDestroyedUnitGainReward(unitType: UnitType, level = 1): number {
  return Math.max(1, Math.ceil(getUnitGainValue(unitType, level) / DESTROYED_UNIT_GAIN_REWARD_DIVISOR));
}

export function getUnitDailyGainValue(unitType: UnitType, level = 1): number {
  const dailyGain = getUnitDefinition(unitType).dailyGain ?? 0;
  if (dailyGain <= 0) {
    return 0;
  }

  return Math.max(0, Math.floor(dailyGain + Math.max(0, Math.floor(level) - 1)) * DAILY_UNIT_GAIN_MULTIPLIER);
}

export function getProductionGainCost(unitType: UnitType, level = 1): number {
  return getUnitGainValue(unitType, level);
}

export function getProductionDays(unitType: UnitType): number {
  return getUnitDefinition(unitType).productionDays;
}

export function getResearchCost(researchType: ResearchType, unitType: UnitType | undefined, economy: EconomyState, level?: number): number {
  if (researchType === "UnlockSpecialServices") {
    return 16;
  }

  if (researchType === "UnlockRoom") {
    return 30;
  }

  if (researchType === "UnlockDroneFactory") {
    return 34;
  }

  if (researchType === "Efficiency") {
    return 8 + (level ?? economy.efficiencyLevel) * 4;
  }

  if (researchType === "ProductionCapacity") {
    return 8 + (level ?? economy.productionCapacityLevel) * 4;
  }

  if (researchType === "ResearchCapacity") {
    return 8 + (level ?? economy.researchCapacityLevel) * 4;
  }

  if (researchType === "ProductionSpeed") {
    return 10 + (level ?? economy.productionSpeedLevel) * 5;
  }

  if (researchType === "ResearchSpeed") {
    return 10 + (level ?? economy.researchSpeedLevel) * 5;
  }

  if (!unitType) {
    return 0;
  }

  return getUnitUpgradeCost(unitType, level ?? economy.unitLevels[unitType]);
}

export function getResearchGainCost(researchType: ResearchType, unitType: UnitType | undefined, economy: EconomyState, level?: number): number {
  return getResearchCost(researchType, unitType, economy, level);
}

export function getQueueFinishGainCost(totalGainCost: number, startedDay: number, completeDay: number, currentDay: number): number {
  if (currentDay >= completeDay) {
    return 0;
  }

  const totalDays = Math.max(1, completeDay - startedDay);
  const elapsedDays = Math.max(0, Math.min(totalDays, currentDay - startedDay));
  const remainingDays = Math.max(0, totalDays - elapsedDays);
  return Math.max(1, Math.ceil(Math.max(1, totalGainCost) * (remainingDays / totalDays)));
}

export function getProductionFinishGainCost(job: { unitType: UnitType; unitLevel?: number; startedDay: number; availableDay: number }, currentDay: number): number {
  return getQueueFinishGainCost(getProductionGainCost(job.unitType, job.unitLevel ?? 1), job.startedDay, job.availableDay, currentDay);
}

export function getResearchFinishGainCost(job: ResearchJob, economy: EconomyState, currentDay: number): number {
  return getQueueFinishGainCost(getResearchGainCost(job.type, job.unitType, economy, getResearchJobStartLevel(job, economy)), job.startedDay, job.completeDay, currentDay);
}

export function getResearchJobStartLevel(job: ResearchJob, economy: EconomyState): number | undefined {
  if (!isLevelResearchType(job.type)) {
    return undefined;
  }

  if (job.targetLevel) {
    return Math.max(1, job.targetLevel - 1);
  }

  if (job.type === "Efficiency") {
    return economy.efficiencyLevel;
  }

  if (job.type === "ProductionCapacity") {
    return economy.productionCapacityLevel;
  }

  if (job.type === "ResearchCapacity") {
    return economy.researchCapacityLevel;
  }

  if (job.type === "ProductionSpeed") {
    return economy.productionSpeedLevel;
  }

  if (job.type === "ResearchSpeed") {
    return economy.researchSpeedLevel;
  }

  return job.unitType ? economy.unitLevels[job.unitType] : 1;
}

export function isLevelResearchType(researchType: ResearchType): boolean {
  return (
    researchType === "UnitUpgrade" ||
    researchType === "Efficiency" ||
    researchType === "ProductionCapacity" ||
    researchType === "ResearchCapacity" ||
    researchType === "ProductionSpeed" ||
    researchType === "ResearchSpeed"
  );
}

export function getFieldUnitUpgradeCost(unitType: UnitType, fromLevel: number): number {
  return getUnitUpgradeCost(unitType, fromLevel);
}

export function getFieldUnitUpgradeGainCost(unitType: UnitType, fromLevel: number): number {
  return getUnitUpgradeCost(unitType, fromLevel);
}

function getUnitUpgradeCost(unitType: UnitType, fromLevel: number): number {
  const level = Math.max(1, Math.floor(fromLevel));
  const baseCost = 4 + level * 3;
  const definition = getUnitDefinition(unitType);
  if (!definition.maxLevel || definition.maxLevel > 3) {
    return Math.max(1, baseCost);
  }

  const productionCostWeight = unitType === "Reaper" || unitType === "Spectral" ? 0.45 : 0.38;
  const eliteSurcharge = unitType === "Reaper" || unitType === "Spectral" ? level * 4 : level * 2;
  return Math.max(1, baseCost + Math.ceil(definition.costPoundsBn * productionCostWeight) + eliteSurcharge);
}

export function getMaxUnitLevel(unitType: UnitType): number {
  return getUnitDefinition(unitType).maxLevel ?? 3;
}

export function getResearchDays(researchType: ResearchType, unitType: UnitType | undefined, economy: EconomyState, level?: number): number {
  if (researchType === "UnlockSpecialServices") {
    return 4;
  }

  if (researchType === "UnlockRoom") {
    return 7;
  }

  if (researchType === "UnlockDroneFactory") {
    return 7;
  }

  if (researchType === "Efficiency") {
    return 2 + (level ?? economy.efficiencyLevel);
  }

  if (researchType === "ProductionCapacity") {
    return 2 + (level ?? economy.productionCapacityLevel);
  }

  if (researchType === "ResearchCapacity") {
    return 2 + (level ?? economy.researchCapacityLevel);
  }

  if (researchType === "ProductionSpeed") {
    return 3 + (level ?? economy.productionSpeedLevel);
  }

  if (researchType === "ResearchSpeed") {
    return 3 + (level ?? economy.researchSpeedLevel);
  }

  if (!unitType) {
    return 0;
  }

  return 2 + (level ?? economy.unitLevels[unitType]);
}

export function getResearchWorkMultiplier(researchType: ResearchType): number {
  return isEconomyResearchType(researchType) ? ECONOMY_RESEARCH_WORK_MULTIPLIER : 1;
}

export function isEconomyResearchType(researchType: ResearchType): boolean {
  return (
    researchType === "Efficiency" ||
    researchType === "ProductionCapacity" ||
    researchType === "ResearchCapacity" ||
    researchType === "ProductionSpeed" ||
    researchType === "ResearchSpeed"
  );
}

export function describeResearch(job: ResearchJob): string {
  if (job.type === "UnlockSpecialServices") {
    return "Special Services";
  }

  if (job.type === "UnlockRoom") {
    return "The Room";
  }

  if (job.type === "UnlockDroneFactory") {
    return "Drone Factory";
  }

  if (job.type === "Efficiency") {
    return "Efficiency";
  }

  if (job.type === "ProductionCapacity") {
    return "Production Capacity";
  }

  if (job.type === "ResearchCapacity") {
    return "Research Capacity";
  }

  if (job.type === "ProductionSpeed") {
    return "Production Speed";
  }

  if (job.type === "ResearchSpeed") {
    return "Research Speed";
  }

  return `${job.unitType ?? "Unit"} Upgrade`;
}
