import { UNIT_DEFINITIONS, getUnitDefinition } from "../data/unitDefs";
import { canOwnerProduceUnit, ownerHasBuilding } from "./buildings";
import {
  getOwnerBaseName,
  getOwnerFaction,
  getOwnerSideName,
  isUnitAvailableToOwnerInState,
  normalizeFactionResearchType
} from "./factions";
import {
  getFieldUnitUpgradeCost,
  getFieldUnitUpgradeGainCost,
  getProductionFinishGainCost,
  getProductionGainCost,
  getProductionCost,
  getProductionDays,
  canUseGainForProduction,
  canUseGainForResearch,
  getResearchFinishGainCost,
  getResearchGainCost,
  getMaxUnitLevel,
  getGateIncomeBonusForEconomy,
  getResearchCost,
  getResearchDays,
  getResearchWorkMultiplier,
  getDestroyedUnitGainReward,
  getUnitDailyGainValue,
  describeResearch
} from "./economy";
import { createEmptySpottedUnits, getVisibleHexIdsForOwner, updateFog } from "./fog";
import { appendLog, formatEnemyUnitLogDetail, formatUnitMovementLog, formatUnitRepairLog } from "./log";
import { displayHexId, getHex, hexDistance, hexId, indexHexMap, sameHex } from "./map";
import { cloneState, createDefaultDebugOptions, createGates, createInitialState } from "./state";
import { getBattlefieldArea } from "./territory";
import { getBaseAttackDamage, getEffectiveUnitStats, getUnitInstanceLevel } from "./unitStats";
import {
  canAttackHex,
  canMoveUnitTo,
  canQueueMoveUnitTo,
  canOwnerMoveAcrossFrontLine,
  canPlaceUnitAt,
  canUnitAttackHex,
  canUnitTargetUnit,
  canUnitEndMovementAt,
  FRONT_LINE_ATTRITION_PERCENT,
  getFrontLineRows,
  isMoveAttackExclusiveUnit,
  findMovementPath,
  getLegalAttackCoordsWithVisibility,
  getLegalMoveCoordsWithVisibility,
  getLegalPlacementCoords,
  getOwnerSupplyTruckPlacementAnchor,
  getOwnerSupplyTruckRepairHealthRatio,
  getQueuedMovementMoveCount,
  getRemainingMovementPoints,
  getOpposingUnitsAt,
  isCoordPastEnemyFrontLine,
  isOwnerBackRow,
  ownerControlsBothGates,
  SUPPLY_TRUCK_REPAIR_RANGE,
} from "./units";
import type {
  AttackEffectiveness,
  BuildingType,
  DebugEconomyField,
  DebugGlobalOption,
  DebugSideOption,
  EnemyMovementTrail,
  EconomyState,
  EngineResult,
  GameCommand,
  GameState,
  GateState,
  LogEntry,
  Owner,
  ProductionJob,
  ResearchJob,
  ResearchType,
  PurchaseCurrency,
  EnemyUnitLogDetail,
  SpottedUnit,
  UnitDomain,
  UnitInstance,
  UnitType
} from "./types";
import { getBestEnemyAttackTarget, runEnemyTurn } from "./ai";
export const MAX_QUEUE_ITEMS = 10;
export const GATE_CAPTURE_DAYS = 2;
export const BASE_CAPTURE_DAYS = 4;
export const CRITICAL_HIT_CHANCE = 0.1;
export const ATTACK_MISS_CHANCE = 0.1;
export const CRITICAL_DAMAGE_MULTIPLIER = 1.5;
export const STEALTH_DAMAGE_MULTIPLIER = 1.2;
export const BACK_ROW_REPAIR_PERCENT = 0.2;
export const JOB_WORK_PER_DAY = 100;
export const SPEED_WORK_GAIN_PER_LEVEL = 20;
export const DEBUG_UNLIMITED_RANGE = 999;

export interface GameEngine {
  getState(): GameState;
  dispatch(command: GameCommand): EngineResult;
}

export interface EngineDispatchContext {
  enemyMovementTrails: EnemyMovementTrail[];
  enemyUnitLogDetails?: Record<string, EnemyUnitLogDetail>;
}

let debugEnemyOwnerLogs = false;

export function setDebugEnemyOwnerLogs(enabled: boolean): void {
  debugEnemyOwnerLogs = enabled;
}

export function createGameEngine(initialState = createInitialState()): GameEngine {
  let state = normalizeState(initialState);

  return {
    getState(): GameState {
      return cloneState(state);
    },
    dispatch(command: GameCommand): EngineResult {
      const beforeLogId = state.nextLogId;
      const context: EngineDispatchContext = {
        enemyMovementTrails: [],
        enemyUnitLogDetails: {}
      };
      state = reduceCommand(cloneState(state), command, context);
      const logEntries = state.log.filter((entry) => entry.id >= beforeLogId);
      return { state: cloneState(state), logEntries, enemyMovementTrails: context.enemyMovementTrails };
    }
  };
}

export function normalizeState(state: GameState): GameState {
  const nextState = cloneState(state);
  nextState.map = indexHexMap(nextState.map);
  const defaultGates = createGates(nextState.map.width, nextState.map.height);

  nextState.gates = defaultGates.map((defaultGate) => {
    const existing = (nextState.gates ?? []).find((gate) => gate.id === defaultGate.id);
    return existing
      ? {
          ...existing,
          coord: defaultGate.coord,
          label: defaultGate.label,
          knownOwner: existing.knownOwner ?? defaultGate.knownOwner,
          occupation: {
            Player: existing.occupation?.Player ?? 0,
            Enemy: existing.occupation?.Enemy ?? 0
          }
        }
      : defaultGate;
  });
  nextState.spottedUnits = {
    ...createEmptySpottedUnits(),
    ...(nextState.spottedUnits ?? {})
  };
  nextState.spottedUnits.Player ??= {};
  nextState.spottedUnits.Enemy ??= {};

  nextState.difficulty = nextState.difficulty ?? "Hard";
  nextState.playerFaction = nextState.playerFaction ?? "Empire";
  nextState.openingEnemyTurnPending = nextState.openingEnemyTurnPending ?? false;
  nextState.enemyActedBeforePlayerThisDay = nextState.enemyActedBeforePlayerThisDay ?? false;
  nextState.debugOptions = normalizeDebugOptions(nextState.debugOptions);
  nextState.debugUnitMissions = nextState.debugUnitMissions ?? {};

  normalizeEconomyState(nextState.economy);
  normalizeEconomyState(nextState.enemyEconomy);

  nextState.units.forEach((unit) => {
    const economy = getEconomy(nextState, unit.owner);
    unit.level = Math.min(getMaxUnitLevel(unit.type), Math.max(1, Math.floor(unit.level ?? economy.unitLevels[unit.type] ?? 1)));
    unit.hasAttackedThisDay = unit.hasAttackedThisDay ?? false;
    if (unit.movementSpentThisDay === undefined) {
      unit.movementSpentThisDay = unit.hasMovedThisDay ? getEffectiveUnitStats(nextState, unit.owner, unit.type, unit.level, unit.coord).moveRange : 0;
    }
    unit.hasMovedThisDay = unit.movementSpentThisDay >= getEffectiveUnitStats(nextState, unit.owner, unit.type, unit.level, unit.coord).moveRange;
    unit.hasProvidedPlacementThisDay = unit.hasProvidedPlacementThisDay ?? false;
  });

  normalizeEconomyQueues(nextState, nextState.economy);
  normalizeEconomyQueues(nextState, nextState.enemyEconomy);

  return nextState;
}

export function normalizeDebugOptions(options: Partial<GameState["debugOptions"]> | undefined): GameState["debugOptions"] {
  const defaults = createDefaultDebugOptions();
  return {
    ...defaults,
    ...(options ?? {}),
    Player: {
      ...defaults.Player,
      ...(options?.Player ?? {})
    },
    Enemy: {
      ...defaults.Enemy,
      ...(options?.Enemy ?? {})
    }
  };
}

export function normalizeEconomyState(economy: EconomyState): void {
  economy.gainPoints = Math.max(0, Math.floor(economy.gainPoints ?? 0));
  economy.productionCapacityLevel = Math.max(1, Math.floor(economy.productionCapacityLevel ?? 1));
  economy.researchCapacityLevel = Math.max(1, Math.floor(economy.researchCapacityLevel ?? 1));
  economy.efficiencyLevel = Math.max(1, Math.floor(economy.efficiencyLevel ?? 1));
  economy.productionSpeedLevel = Math.max(1, Math.floor(economy.productionSpeedLevel ?? 1));
  economy.researchSpeedLevel = Math.max(1, Math.floor(economy.researchSpeedLevel ?? 1));
  for (const unit of UNIT_DEFINITIONS) {
    economy.inventory[unit.type] = Math.max(0, Math.floor(economy.inventory[unit.type] ?? 0));
    economy.unitLevels[unit.type] = Math.min(getMaxUnitLevel(unit.type), Math.max(1, Math.floor(economy.unitLevels[unit.type] ?? 1)));
  }
  normalizeInventoryByLevel(economy);
}

export function normalizeInventoryByLevel(economy: EconomyState): void {
  economy.inventoryByLevel ??= Object.fromEntries(UNIT_DEFINITIONS.map((unit) => [unit.type, {}])) as NonNullable<EconomyState["inventoryByLevel"]>;
  for (const unit of UNIT_DEFINITIONS) {
    const levels = economy.inventoryByLevel[unit.type] ?? {};
    const normalizedLevels: Record<number, number> = {};
    for (const [levelKey, countValue] of Object.entries(levels)) {
      const level = Math.min(getMaxUnitLevel(unit.type), Math.max(1, Math.floor(Number(levelKey))));
      const count = Math.max(0, Math.floor(Number(countValue)));
      if (Number.isFinite(level) && count > 0) {
        normalizedLevels[level] = (normalizedLevels[level] ?? 0) + count;
      }
    }

    const levelTotal = Object.values(normalizedLevels).reduce((total, count) => total + count, 0);
    const inventoryTotal = economy.inventory[unit.type] ?? 0;
    if (levelTotal !== inventoryTotal) {
      const productionLevel = Math.min(getMaxUnitLevel(unit.type), Math.max(1, Math.floor(economy.unitLevels[unit.type] ?? 1)));
      economy.inventoryByLevel[unit.type] = inventoryTotal > 0 ? { [productionLevel]: inventoryTotal } : {};
      continue;
    }

    economy.inventoryByLevel[unit.type] = normalizedLevels;
    economy.inventory[unit.type] = levelTotal;
  }
}

export function normalizeEconomyQueues(state: GameState, economy: EconomyState): void {
  normalizeProductionQueueSchedule(state, economy);
  normalizeResearchQueueSchedule(state, economy);
}

export function normalizeProductionQueueSchedule(state: GameState, economy: EconomyState): void {
  economy.productionQueue.forEach((job) => {
    job.unitLevel = Math.min(getMaxUnitLevel(job.unitType), Math.max(1, Math.floor(job.unitLevel ?? economy.unitLevels[job.unitType] ?? 1)));
  });

  const lanes = getInitialWorkLanes(
    economy.productionQueue
      .filter((job) => job.startedDay < state.day && job.availableDay > state.day)
      .map((job) => job.availableDay),
    economy.productionCapacityLevel,
    state.day
  );
  const workPerDay = getProductionWorkPerDay(economy);

  economy.productionQueue
    .filter((job) => job.availableDay > state.day && !(job.startedDay < state.day && job.availableDay > state.day))
    .sort((first, second) => first.startedDay - second.startedDay || first.availableDay - second.availableDay)
    .forEach((job) => {
      const laneIndex = getEarliestWorkLaneIndex(lanes);
      const schedule = scheduleWorkOnLane(lanes[laneIndex], getProductionDays(job.unitType) * JOB_WORK_PER_DAY, workPerDay);
      job.startedDay = schedule.startedDay;
      job.availableDay = schedule.completeDay;
      lanes[laneIndex] = schedule.lane;
    });
}

export function normalizeResearchQueueSchedule(state: GameState, economy: EconomyState): void {
  economy.researchQueue = economy.researchQueue.filter(
    (job) => job.type !== "UnitUpgrade" || !job.unitType || (getResearchJobStartLevel(job, economy) ?? 1) < getMaxUnitLevel(job.unitType)
  );
  economy.researchQueue.forEach((job) => {
    if (job.type === "UnitUpgrade" && job.unitType && job.targetLevel) {
      job.targetLevel = Math.min(getMaxUnitLevel(job.unitType), job.targetLevel);
    }
  });

  const lanes = getInitialWorkLanes(
    economy.researchQueue
      .filter((job) => job.startedDay < state.day && job.completeDay > state.day)
      .map((job) => job.completeDay),
    economy.researchCapacityLevel,
    state.day
  );
  const workPerDay = getResearchWorkPerDay(economy);

  economy.researchQueue
    .filter((job) => job.completeDay > state.day && !(job.startedDay < state.day && job.completeDay > state.day))
    .sort((first, second) => first.startedDay - second.startedDay || first.completeDay - second.completeDay)
    .forEach((job) => {
      const laneIndex = getEarliestWorkLaneIndex(lanes);
      const startLevel = getResearchJobStartLevel(job, economy);
      const schedule = scheduleWorkOnLane(lanes[laneIndex], getResearchRequiredWork(job.type, job.unitType, economy, startLevel), workPerDay);
      job.startedDay = schedule.startedDay;
      job.completeDay = schedule.completeDay;
      lanes[laneIndex] = schedule.lane;
    });
}

export function reduceCommand(state: GameState, command: GameCommand, context: EngineDispatchContext): GameState {
  switch (command.type) {
    case "START_SIMULATION": {
      const nextState = command.seed ? createInitialState(command.seed) : state;
      nextState.started = true;
      nextState.paused = false;
      appendLog(nextState, "Simulation started.");
      if (nextState.playerFaction === "Alliance") {
        nextState.openingEnemyTurnPending = true;
      }
      return updateFog(nextState);
    }

    case "RUN_OPENING_ENEMY_TURN": {
      if (!state.started || state.winner || !state.openingEnemyTurnPending) {
        return state;
      }

      state.openingEnemyTurnPending = false;
      appendOwnerLog(state, "Enemy", "Enemy opened the campaign.");
      runEnemyTurn(state, context);
      state.enemyActedBeforePlayerThisDay = true;
      return updateFog(state);
    }

    case "END_TURN": {
      if (!state.started || state.winner) {
        return state;
      }

      state.spottedUnits.Player = {};
      appendLog(state, "Player ended turn.");
      advanceQueuedMovements(state, "Player", context);
      if (state.enemyActedBeforePlayerThisDay) {
        state.enemyActedBeforePlayerThisDay = false;
      } else {
        runEnemyTurn(state, context);
      }
      advanceEnemyTurnAndStartNextDay(state, context);
      return updateFog(state);
    }

    case "DESELECT": {
      state.selection = {
        selectedHexId: null,
        selectedUnitId: null
      };
      return state;
    }

    case "SELECT_HEX": {
      const hex = getHex(state.map, command.coord);
      if (!hex) {
        return state;
      }

      const selectableUnits = getUnitsSelectableByPlayer(state, command.coord);
      state.selection = {
        selectedHexId: hex.id,
        selectedUnitId: selectableUnits.length === 1 ? selectableUnits[0].id : null
      };
      return state;
    }

    case "SELECT_UNIT": {
      const unit = getUnitSelectableByPlayerId(state, command.unitId);
      if (!unit) {
        return state;
      }

      state.selection = {
        selectedHexId: hexId(unit.coord),
        selectedUnitId: unit.id
      };
      return state;
    }

    case "MOVE_UNIT": {
      const unit = state.units.find((candidate) => candidate.id === command.unitId && candidate.owner === "Player");
      if (!unit) {
        appendLog(state, "Move rejected - unit unavailable.");
        return state;
      }

      if (!canMoveUnitTo(state, unit, command.to)) {
        return queueUnitMovement(state, unit, command.to, context);
      }

      unit.queuedMovement = undefined;
      return moveUnitTo(state, unit, command.to, "clear", context);
    }

    case "CANCEL_QUEUED_MOVEMENT": {
      const unit = state.units.find((candidate) => candidate.id === command.unitId && candidate.owner === "Player");
      if (!unit?.queuedMovement) {
        appendLog(state, "Movement cancellation rejected - no queued movement.");
        return state;
      }

      const destination = displayHexId(state.map, unit.queuedMovement.destination);
      unit.queuedMovement = undefined;
      appendLog(state, `${unit.type} movement to ${destination} cancelled.`);
      return state;
    }

    case "ATTACK_HEX": {
      const unit = state.units.find((candidate) => candidate.id === command.unitId && candidate.owner === "Player");
      if (!unit) {
        appendLog(state, "Attack rejected - unit unavailable.");
        return state;
      }

      if (unit.hasAttackedThisDay) {
        appendLog(state, "Attack rejected - unit already attacked this day.");
        return state;
      }

      if (!canAttackHex(state, unit, command.at)) {
        appendLog(state, "Attack rejected - target outside range.");
        return state;
      }

      return attackHexWithUnit(state, unit, command.at);
    }

    case "PLACE_UNIT": {
      return placeUnit(state, "Player", command.unitType, command.at, "clear", command.unitLevel);
    }

    case "UPGRADE_FIELD_UNIT": {
      const unit = state.units.find((candidate) => candidate.id === command.unitId && candidate.owner === "Player");
      if (!unit) {
        appendLog(state, "Field upgrade rejected - unit unavailable.");
        return state;
      }

      return upgradeFieldUnit(state, unit, command.currency ?? "funds") ? updateFog(state) : state;
    }

    case "START_PRODUCTION": {
      startProduction(state, "Player", command.unitType);
      return state;
    }

    case "START_RESEARCH": {
      startResearch(state, "Player", command.researchType, command.unitType);
      return state;
    }

    case "INSTANT_PRODUCTION": {
      instantProduction(state, "Player", command.unitType);
      return state;
    }

    case "INSTANT_RESEARCH": {
      instantResearch(state, "Player", command.researchType, command.unitType);
      return state;
    }

    case "FINISH_PRODUCTION": {
      finishProduction(state, "Player", command.jobId);
      return state;
    }

    case "FINISH_RESEARCH": {
      finishResearch(state, "Player", command.jobId);
      return state;
    }

    case "CANCEL_PRODUCTION": {
      cancelProduction(state, "Player", command.jobId);
      return state;
    }

    case "CANCEL_RESEARCH": {
      cancelResearch(state, "Player", command.jobId);
      return state;
    }

    case "TOGGLE_PAUSE": {
      if (!state.started) {
        return state;
      }

      state.paused = !state.paused;
      appendLog(state, state.paused ? "Simulation paused." : "Simulation resumed.");
      return state;
    }

    case "SET_DEBUG_GLOBAL_OPTION": {
      state.debugOptions = normalizeDebugOptions(state.debugOptions);
      state.debugOptions[command.option] = command.enabled;
      appendLog(state, `Debug ${formatDebugGlobalOption(command.option)} ${command.enabled ? "enabled" : "disabled"}.`);
      return command.option === "noFogOfWar" ? updateFog(state) : state;
    }

    case "SET_DEBUG_SIDE_OPTION": {
      state.debugOptions = normalizeDebugOptions(state.debugOptions);
      state.debugOptions[command.owner][command.option] = command.enabled;
      appendLog(state, `Debug ${command.owner} ${formatDebugSideOption(command.option)} ${command.enabled ? "enabled" : "disabled"}.`);
      return state;
    }

    case "DEBUG_ADJUST_FUNDS": {
      const economy = getEconomy(state, command.owner);
      const amount = Math.floor(command.amount);
      if (!Number.isFinite(amount) || amount === 0) {
        return state;
      }

      economy.moneyPoundsBn = Math.max(0, economy.moneyPoundsBn + amount);
      appendLog(state, `Debug ${command.owner} funds ${formatMoneyDelta(amount)}.`);
      return state;
    }

    case "DEBUG_SET_ECONOMY_FIELD": {
      setDebugEconomyField(state, command.owner, command.field, command.value);
      return state;
    }

    case "DEBUG_SET_UNIT_LEVEL": {
      setDebugUnitLevel(state, command.owner, command.unitType, command.level);
      return state;
    }

    case "DEBUG_ADD_UNIT_MATERIAL": {
      addDebugUnitMaterial(state, command.owner, command.unitType, command.level, command.count);
      return state;
    }
  }
}

function awardDailyUnitGain(state: GameState, owner: Owner): void {
  const economy = getEconomy(state, owner);
  const gain = state.units
    .filter((unit) => unit.owner === owner)
    .reduce((total, unit) => total + getUnitDailyGainValue(unit.type, getUnitInstanceLevel(state, unit)), 0);
  if (gain <= 0) {
    return;
  }

  economy.gainPoints += gain;
  appendOwnerLog(state, owner, `${owner} command units generated ${gain} gain.`);
}

function formatDebugGlobalOption(option: DebugGlobalOption): string {
  return option === "showAiUnits" ? "AI unit display" : "no fog-of-war";
}

function formatDebugSideOption(option: DebugSideOption): string {
  if (option === "noDamage") {
    return "no damage";
  }

  if (option === "unlimitedMovement") {
    return "unlimited movement";
  }

  return "unlimited attack range";
}

export function getEconomy(state: GameState, owner: Owner): EconomyState {
  return owner === "Player" ? state.economy : state.enemyEconomy;
}

export function getEffectiveUnitHealth(state: GameState, owner: Owner, unitType: UnitType, level?: number): number {
  return getEffectiveUnitStats(state, owner, unitType, level).health;
}

export function isCoordVisibleToPlayer(state: GameState, coord: UnitInstance["coord"]): boolean {
  return state.fog[hexId(coord)] === "visible";
}

export function canPlayerSeeAction(state: GameState, coords: UnitInstance["coord"][]): boolean {
  return coords.some((coord) => isCoordVisibleToPlayer(state, coord));
}

export function canPlayerSelectUnit(state: GameState, unit: UnitInstance): boolean {
  return unit.owner === "Player" || isCoordVisibleToPlayer(state, unit.coord) || Boolean(state.debugOptions?.showAiUnits);
}

export function getUnitsSelectableByPlayer(state: GameState, coord: UnitInstance["coord"]): UnitInstance[] {
  const liveUnits = state.units.filter((unit) => sameHex(unit.coord, coord) && canPlayerSelectUnit(state, unit));
  const visibleLiveUnitIds = new Set(liveUnits.map((unit) => unit.id));
  const spottedUnits = Object.values(state.spottedUnits?.Player ?? {})
    .filter((unit) => sameHex(unit.coord, coord) && !visibleLiveUnitIds.has(unit.id))
    .map((unit) => spottedUnitToInspectableUnit(state, unit));
  return [...liveUnits, ...spottedUnits];
}

export function getUnitSelectableByPlayerId(state: GameState, unitId: string): UnitInstance | undefined {
  const liveUnit = state.units.find((candidate) => candidate.id === unitId && canPlayerSelectUnit(state, candidate));
  if (liveUnit) {
    return liveUnit;
  }

  const spottedUnit = state.spottedUnits?.Player?.[unitId];
  return spottedUnit ? spottedUnitToInspectableUnit(state, spottedUnit) : undefined;
}

export function spottedUnitToInspectableUnit(state: GameState, unit: SpottedUnit): UnitInstance {
  return {
    id: unit.id,
    owner: unit.owner,
    type: unit.type,
    level: unit.level ?? 1,
    coord: { ...unit.coord },
    health: unit.health,
    maxHealth: unit.maxHealth,
    placedDay: Math.max(0, state.day - 1),
    hasMovedThisDay: false,
    movementSpentThisDay: 0,
    hasAttackedThisDay: false,
    hasProvidedPlacementThisDay: false
  };
}

export function appendOwnerLog(state: GameState, owner: Owner, text: string): void {
  if (canRevealOwnerAction(owner)) {
    appendLog(state, text);
  }
}

function canRevealOwnerAction(owner: Owner): boolean {
  return owner === "Player" || (owner === "Enemy" && debugEnemyOwnerLogs);
}

function shouldWriteDebugUnitLogDetails(): boolean {
  return debugEnemyOwnerLogs;
}

function getDebugUnitLogDetail(unit: UnitInstance, detail?: EnemyUnitLogDetail): EnemyUnitLogDetail | undefined {
  if (!shouldWriteDebugUnitLogDetails()) {
    return detail;
  }

  return {
    ...detail,
    unitId: unit.id
  };
}

function getDebugCombatLogDetail(attacker: UnitInstance, target: UnitInstance, detail?: EnemyUnitLogDetail): EnemyUnitLogDetail | undefined {
  if (!shouldWriteDebugUnitLogDetails()) {
    return detail;
  }

  return {
    ...detail,
    unitId: attacker.id,
    targetId: target.id
  };
}

function formatDebugUnitLogDetail(unit: UnitInstance, detail?: EnemyUnitLogDetail): string {
  return formatEnemyUnitLogDetail(getDebugUnitLogDetail(unit, detail));
}

function formatDebugCombatLogDetail(attacker: UnitInstance, target: UnitInstance, detail?: EnemyUnitLogDetail): string {
  return formatEnemyUnitLogDetail(getDebugCombatLogDetail(attacker, target, detail));
}

function formatMoneyDelta(amount: number): string {
  return `${amount >= 0 ? "+" : "-"}£${Math.abs(amount)}B`;
}

function setDebugEconomyField(state: GameState, owner: Owner, field: DebugEconomyField, value: number): void {
  const economy = getEconomy(state, owner);
  const minimum = field === "moneyPoundsBn" || field === "gainPoints" || field === "incomePoundsBn" ? 0 : 1;
  const normalizedValue = clampInteger(value, minimum);
  economy[field] = normalizedValue;
  normalizeEconomyQueues(state, economy);
  appendLog(state, `Debug ${owner} ${formatDebugEconomyField(field)} set to ${normalizedValue}.`);
}

function setDebugUnitLevel(state: GameState, owner: Owner, unitType: UnitType, value: number): void {
  const economy = getEconomy(state, owner);
  const level = Math.min(getMaxUnitLevel(unitType), clampInteger(value, 1));
  economy.unitLevels[unitType] = level;
  normalizeEconomyQueues(state, economy);
  appendLog(state, `Debug ${owner} ${unitType} future production level set to ${level}.`);
}

function addDebugUnitMaterial(state: GameState, owner: Owner, unitType: UnitType, requestedLevel?: number, requestedCount?: number): void {
  const economy = getEconomy(state, owner);
  const level = Math.min(getMaxUnitLevel(unitType), clampInteger(requestedLevel ?? economy.unitLevels[unitType] ?? 1, 1));
  const count = Math.min(99, clampInteger(requestedCount ?? 1, 1));
  for (let index = 0; index < count; index += 1) {
    addInventoryUnitAtLevel(economy, unitType, level);
  }
  appendLog(state, `Debug ${owner} added ${count} ${unitType} L${level} material.`);
}

function clampInteger(value: number, minimum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }

  return Math.max(minimum, Math.floor(value));
}

function formatDebugEconomyField(field: DebugEconomyField): string {
  if (field === "moneyPoundsBn") {
    return "funds";
  }

  if (field === "gainPoints") {
    return "gain";
  }

  if (field === "incomePoundsBn") {
    return "income";
  }

  if (field === "efficiencyLevel") {
    return "efficiency";
  }

  if (field === "productionCapacityLevel") {
    return "production capacity";
  }

  if (field === "productionSpeedLevel") {
    return "production speed";
  }

  if (field === "researchCapacityLevel") {
    return "research capacity";
  }

  return "research speed";
}

export function startProduction(state: GameState, owner: Owner, unitType: UnitType): boolean {
  const economy = getEconomy(state, owner);
  const cost = getProductionCost(unitType);
  if (economy.productionQueue.length >= MAX_QUEUE_ITEMS) {
    appendOwnerLog(state, owner, `${owner} production rejected - queue is full.`);
    return false;
  }

  if (!canOwnerProduceUnit(state, owner, unitType)) {
    appendOwnerLog(state, owner, `${owner} production rejected - no building can produce ${unitType}.`);
    return false;
  }

  if (economy.moneyPoundsBn < cost) {
    appendOwnerLog(state, owner, `${owner} production rejected - ${unitType} requires £${cost}B.`);
    return false;
  }

  economy.moneyPoundsBn -= cost;
  economy.productionQueue.push({
    id: `production-${state.nextId}`,
    owner,
    unitType,
    unitLevel: economy.unitLevels[unitType],
    startedDay: state.day,
    availableDay: state.day + getProductionDays(unitType)
  });
  economy.lastProductionUnitType = unitType;
  state.nextId += 1;
  normalizeProductionQueueSchedule(state, economy);
  const job = economy.productionQueue[economy.productionQueue.length - 1];
  appendOwnerLog(state, owner, `${owner} ${job.startedDay > state.day ? "queued" : "started"} ${unitType} production.`);
  return true;
}

export function startResearch(state: GameState, owner: Owner, researchType: ResearchType, unitType?: UnitType): boolean {
  researchType = normalizeFactionResearchType(state, owner, researchType);
  const economy = getEconomy(state, owner);
  if (economy.researchQueue.length >= MAX_QUEUE_ITEMS) {
    appendOwnerLog(state, owner, `${owner} research rejected - queue is full.`);
    return false;
  }

  if (!canStartResearch(state, owner, researchType, unitType)) {
    return false;
  }

  const startLevel = getNextResearchStartLevel(economy, researchType, unitType);
  const targetLevel = getResearchTargetLevel(researchType, startLevel);
  const cost = getResearchCost(researchType, unitType, economy, startLevel);
  economy.moneyPoundsBn -= cost;
  const job: ResearchJob = {
    id: `research-${state.nextId}`,
    owner,
    type: researchType,
    unitType,
    targetLevel,
    startedDay: state.day,
    completeDay: state.day + getResearchDays(researchType, unitType, economy, startLevel)
  };
  state.nextId += 1;
  economy.researchQueue.push(job);
  normalizeResearchQueueSchedule(state, economy);
  appendOwnerLog(state, owner, `${owner} ${job.startedDay > state.day ? "queued" : "started"} ${describeResearch(job)} research.`);
  return true;
}

export function instantProduction(state: GameState, owner: Owner, unitType: UnitType): boolean {
  const economy = getEconomy(state, owner);
  if (!canUseGainForProduction(unitType)) {
    appendOwnerLog(state, owner, `${owner} gain production rejected - ${unitType} cannot be produced with gain.`);
    return false;
  }

  if (!canOwnerProduceUnit(state, owner, unitType)) {
    appendOwnerLog(state, owner, `${owner} gain production rejected - no building can produce ${unitType}.`);
    return false;
  }

  const unitLevel = economy.unitLevels[unitType];
  const cost = getProductionGainCost(unitType, unitLevel);
  if (economy.gainPoints < cost) {
    appendOwnerLog(state, owner, `${owner} gain production rejected - ${unitType} L${unitLevel} requires ${cost} gain.`);
    return false;
  }

  economy.gainPoints -= cost;
  addInventoryUnitAtLevel(economy, unitType, unitLevel);
  economy.lastProductionUnitType = unitType;
  appendOwnerLog(state, owner, `${owner} instantly produced ${unitType} L${unitLevel} for ${cost} gain.`);
  return true;
}

export function instantResearch(state: GameState, owner: Owner, researchType: ResearchType, unitType?: UnitType): boolean {
  researchType = normalizeFactionResearchType(state, owner, researchType);
  const economy = getEconomy(state, owner);
  if (!canUseGainForResearch(researchType)) {
    appendOwnerLog(state, owner, `${owner} gain research rejected - ${describeResearch({ type: researchType, owner, unitType, id: "", startedDay: state.day, completeDay: state.day })} cannot be researched with gain.`);
    return false;
  }

  if (economy.researchQueue.some((job) => isSameResearchLine(job, researchType, unitType))) {
    appendOwnerLog(state, owner, `${owner} gain research rejected - finish queued research first.`);
    return false;
  }

  if (!canStartResearch(state, owner, researchType, unitType, { ignoreMoney: true })) {
    return false;
  }

  const startLevel = getCurrentResearchLevel(economy, researchType, unitType);
  const targetLevel = getResearchTargetLevel(researchType, startLevel);
  const cost = getResearchGainCost(researchType, unitType, economy, startLevel);
  if (economy.gainPoints < cost) {
    appendOwnerLog(state, owner, `${owner} gain research rejected - ${describeResearch({ type: researchType, owner, unitType, targetLevel, id: "", startedDay: state.day, completeDay: state.day })} requires ${cost} gain.`);
    return false;
  }

  economy.gainPoints -= cost;
  applyCompletedResearchJob(state, owner, economy, {
    id: `instant-research-${state.nextId}`,
    owner,
    type: researchType,
    unitType,
    targetLevel,
    startedDay: state.day,
    completeDay: state.day
  });
  state.nextId += 1;
  return true;
}

export function finishProduction(state: GameState, owner: Owner, jobId: string): boolean {
  const economy = getEconomy(state, owner);
  const job = economy.productionQueue.find((candidate) => candidate.id === jobId && candidate.owner === owner);
  if (!job) {
    appendOwnerLog(state, owner, `${owner} gain finish rejected - production job unavailable.`);
    return false;
  }

  if (!canUseGainForProduction(job.unitType)) {
    appendOwnerLog(state, owner, `${owner} gain finish rejected - ${job.unitType} production cannot be completed with gain.`);
    return false;
  }

  const cost = getProductionFinishGainCost(job, state.day);
  if (economy.gainPoints < cost) {
    appendOwnerLog(state, owner, `${owner} gain finish rejected - ${job.unitType} production requires ${cost} gain.`);
    return false;
  }

  economy.gainPoints -= cost;
  economy.productionQueue = economy.productionQueue.filter((candidate) => candidate.id !== job.id);
  const unitLevel = Math.min(getMaxUnitLevel(job.unitType), job.unitLevel ?? economy.unitLevels[job.unitType]);
  addInventoryUnitAtLevel(economy, job.unitType, unitLevel);
  economy.lastProductionUnitType = job.unitType;
  normalizeProductionQueueSchedule(state, economy);
  appendOwnerLog(state, owner, `${owner} finished ${job.unitType} L${unitLevel} production for ${cost} gain.`);
  return true;
}

export function finishResearch(state: GameState, owner: Owner, jobId: string): boolean {
  const economy = getEconomy(state, owner);
  const job = economy.researchQueue.find((candidate) => candidate.id === jobId && candidate.owner === owner);
  if (!job) {
    appendOwnerLog(state, owner, `${owner} gain finish rejected - research job unavailable.`);
    return false;
  }

  if (!canUseGainForResearch(job.type)) {
    appendOwnerLog(state, owner, `${owner} gain finish rejected - ${describeResearch(job)} research cannot be completed with gain.`);
    return false;
  }

  if (hasQueuedResearchPrerequisite(economy, job)) {
    appendOwnerLog(state, owner, `${owner} gain finish rejected - finish prerequisite research first.`);
    return false;
  }

  const cost = getResearchFinishGainCost(job, economy, state.day);
  if (economy.gainPoints < cost) {
    appendOwnerLog(state, owner, `${owner} gain finish rejected - ${describeResearch(job)} research requires ${cost} gain.`);
    return false;
  }

  economy.gainPoints -= cost;
  economy.researchQueue = economy.researchQueue.filter((candidate) => candidate.id !== job.id);
  applyCompletedResearchJob(state, owner, economy, job);
  normalizeResearchQueueSchedule(state, economy);
  return true;
}

function hasQueuedResearchPrerequisite(economy: EconomyState, job: ResearchJob): boolean {
  if (!isLevelResearch(job.type) || !job.targetLevel) {
    return false;
  }

  return economy.researchQueue.some(
    (candidate) =>
      candidate.id !== job.id &&
      isSameResearchLine(candidate, job.type, job.unitType) &&
      (candidate.targetLevel ?? 0) < (job.targetLevel ?? 0)
  );
}

export function cancelProduction(state: GameState, owner: Owner, jobId: string): boolean {
  const economy = getEconomy(state, owner);
  const job = economy.productionQueue.find((candidate) => candidate.id === jobId && candidate.owner === owner);
  if (!job) {
    appendOwnerLog(state, owner, `${owner} production cancellation rejected - job unavailable.`);
    return false;
  }

  const cost = getProductionCost(job.unitType);
  const refund = getCancellationRefund(cost, job.startedDay, job.availableDay, state.day);
  economy.moneyPoundsBn += refund.amount;
  economy.productionQueue = economy.productionQueue.filter((candidate) => candidate.id !== job.id);
  normalizeProductionQueueSchedule(state, economy);
  appendOwnerLog(state, owner, formatProductionCancellationLog(owner, job, refund, cost));
  return true;
}

export function cancelResearch(state: GameState, owner: Owner, jobId: string): boolean {
  const economy = getEconomy(state, owner);
  const job = economy.researchQueue.find((candidate) => candidate.id === jobId && candidate.owner === owner);
  if (!job) {
    appendOwnerLog(state, owner, `${owner} research cancellation rejected - job unavailable.`);
    return false;
  }

  const jobsToCancel = getResearchJobsCancelledWith(state, owner, job);
  for (const cancelledJob of jobsToCancel) {
    const cost = getResearchRefundCost(cancelledJob, economy);
    const refund = getCancellationRefund(cost, cancelledJob.startedDay, cancelledJob.completeDay, state.day);
    economy.moneyPoundsBn += refund.amount;
    appendOwnerLog(state, owner, formatResearchCancellationLog(owner, cancelledJob, refund, cost, cancelledJob.id !== job.id));
  }

  const cancelledJobIds = new Set(jobsToCancel.map((candidate) => candidate.id));
  economy.researchQueue = economy.researchQueue.filter((candidate) => !cancelledJobIds.has(candidate.id));
  normalizeResearchQueueSchedule(state, economy);
  return true;
}

export function getResearchJobsCancelledWith(state: GameState, owner: Owner, job: ResearchJob): ResearchJob[] {
  if (!isLevelResearch(job.type) || !job.targetLevel) {
    return [job];
  }

  const targetLevel = job.targetLevel;
  return getEconomy(state, owner).researchQueue
    .filter((candidate) => candidate.owner === owner && isSameResearchLine(candidate, job.type, job.unitType) && (candidate.targetLevel ?? 0) >= targetLevel)
    .sort((first, second) => (first.targetLevel ?? 0) - (second.targetLevel ?? 0));
}

export function getResearchRefundCost(job: ResearchJob, economy: EconomyState): number {
  return getResearchCost(job.type, job.unitType, economy, getResearchJobStartLevel(job, economy));
}

export function getResearchJobStartLevel(job: ResearchJob, economy: EconomyState): number | undefined {
  if (!isLevelResearch(job.type)) {
    return undefined;
  }

  if (job.targetLevel) {
    return Math.max(1, job.targetLevel - 1);
  }

  return getCurrentResearchLevel(economy, job.type, job.unitType);
}

export function getCancellationRefund(
  cost: number,
  startedDay: number,
  completeDay: number,
  currentDay: number
): { amount: number; elapsedDays: number; remainingDays: number; totalDays: number; percent: number } {
  const totalDays = Math.max(1, completeDay - startedDay);
  const elapsedDays = Math.max(0, Math.min(totalDays, currentDay - startedDay));
  const remainingDays = Math.max(0, totalDays - elapsedDays);
  const ratio = remainingDays / totalDays;
  return {
    amount: Math.max(0, Math.floor(cost * ratio)),
    elapsedDays,
    remainingDays,
    totalDays,
    percent: Math.round(ratio * 100)
  };
}

export function formatProductionCancellationLog(
  owner: Owner,
  job: ProductionJob,
  refund: ReturnType<typeof getCancellationRefund>,
  cost: number
): string {
  return `${owner} cancelled ${job.unitType} production after ${refund.elapsedDays}/${refund.totalDays} days; ${refund.remainingDays} days remaining, ${refund.percent}% of £${cost}B refunded (£${refund.amount}B).`;
}

export function formatResearchCancellationLog(
  owner: Owner,
  job: ResearchJob,
  refund: ReturnType<typeof getCancellationRefund>,
  cost: number,
  dependent: boolean
): string {
  return `${owner} cancelled ${dependent ? "dependent " : ""}${describeResearch(job)} research after ${refund.elapsedDays}/${refund.totalDays} days; ${refund.remainingDays} days remaining, ${refund.percent}% of £${cost}B refunded (£${refund.amount}B).`;
}

export function getResearchTargetLevel(researchType: ResearchType, startLevel: number): number | undefined {
  return isLevelResearch(researchType) ? startLevel + 1 : undefined;
}

export function getNextResearchStartLevel(economy: EconomyState, researchType: ResearchType, unitType: UnitType | undefined): number {
  const currentLevel = getCurrentResearchLevel(economy, researchType, unitType);
  if (!isLevelResearch(researchType)) {
    return currentLevel;
  }

  return economy.researchQueue
    .filter((job) => isSameResearchLine(job, researchType, unitType))
    .reduce((level, job) => Math.max(level, job.targetLevel ?? level + 1), currentLevel);
}

export function getCurrentResearchLevel(economy: EconomyState, researchType: ResearchType, unitType: UnitType | undefined): number {
  if (researchType === "Efficiency") {
    return economy.efficiencyLevel;
  }

  if (researchType === "ProductionCapacity") {
    return economy.productionCapacityLevel;
  }

  if (researchType === "ResearchCapacity") {
    return economy.researchCapacityLevel;
  }

  if (researchType === "ProductionSpeed") {
    return economy.productionSpeedLevel;
  }

  if (researchType === "ResearchSpeed") {
    return economy.researchSpeedLevel;
  }

  if (researchType === "UnitUpgrade" && unitType) {
    return economy.unitLevels[unitType];
  }

  return 1;
}

export function isLevelResearch(researchType: ResearchType): boolean {
  return (
    researchType === "UnitUpgrade" ||
    researchType === "Efficiency" ||
    researchType === "ProductionCapacity" ||
    researchType === "ResearchCapacity" ||
    researchType === "ProductionSpeed" ||
    researchType === "ResearchSpeed"
  );
}

export function isSameResearchLine(job: ResearchJob, researchType: ResearchType, unitType: UnitType | undefined): boolean {
  return job.type === researchType && job.unitType === unitType;
}

export interface WorkLane {
  day: number;
  carryWork: number;
}

export function getInitialWorkLanes(activeEndDays: number[], capacity: number, currentDay: number): WorkLane[] {
  const normalizedCapacity = Math.max(1, Math.floor(capacity));
  const lanes = activeEndDays
    .filter((day) => day > currentDay)
    .sort((first, second) => first - second)
    .map((day) => ({ day, carryWork: 0 }));
  while (lanes.length < normalizedCapacity) {
    lanes.push({ day: currentDay, carryWork: 0 });
  }
  return lanes;
}

export function scheduleWorkOnLane(lane: WorkLane, requiredWork: number, workPerDay: number): { startedDay: number; completeDay: number; lane: WorkLane } {
  const startedDay = lane.day;
  const remainingWork = Math.max(0, requiredWork - lane.carryWork);
  const daysNeeded = remainingWork <= 0 ? 0 : Math.ceil(remainingWork / workPerDay);
  const completeDay = startedDay + daysNeeded;
  const generatedWork = daysNeeded * workPerDay;
  const carryWork = Math.max(0, lane.carryWork + generatedWork - requiredWork);
  return {
    startedDay,
    completeDay,
    lane: {
      day: completeDay,
      carryWork
    }
  };
}

export function getEarliestWorkLaneIndex(lanes: WorkLane[]): number {
  return lanes.reduce((bestIndex, lane, index) => {
    const best = lanes[bestIndex];
    return lane.day < best.day || (lane.day === best.day && lane.carryWork > best.carryWork) ? index : bestIndex;
  }, 0);
}

export function getProductionWorkPerDay(economy: EconomyState): number {
  return JOB_WORK_PER_DAY + Math.max(0, economy.productionSpeedLevel - 1) * SPEED_WORK_GAIN_PER_LEVEL;
}

export function getResearchWorkPerDay(economy: EconomyState): number {
  return JOB_WORK_PER_DAY + Math.max(0, economy.researchSpeedLevel - 1) * SPEED_WORK_GAIN_PER_LEVEL;
}

export function getResearchRequiredWork(researchType: ResearchType, unitType: UnitType | undefined, economy: EconomyState, level?: number): number {
  return Math.ceil(getResearchDays(researchType, unitType, economy, level) * JOB_WORK_PER_DAY * getResearchWorkMultiplier(researchType));
}

export function placeUnit(
  state: GameState,
  owner: Owner,
  unitType: UnitType,
  coord: UnitInstance["coord"],
  selectionMode: "select" | "clear" | "preserve",
  requestedUnitLevel?: number
): GameState {
  return placeUnitWithOptions(state, owner, unitType, coord, selectionMode, requestedUnitLevel, { refreshFog: true });
}

export function placeUnitWithoutFog(
  state: GameState,
  owner: Owner,
  unitType: UnitType,
  coord: UnitInstance["coord"],
  selectionMode: "select" | "clear" | "preserve",
  requestedUnitLevel?: number
): GameState {
  return placeUnitWithOptions(state, owner, unitType, coord, selectionMode, requestedUnitLevel, { refreshFog: false });
}

function placeUnitWithOptions(
  state: GameState,
  owner: Owner,
  unitType: UnitType,
  coord: UnitInstance["coord"],
  selectionMode: "select" | "clear" | "preserve",
  requestedUnitLevel: number | undefined,
  options: { refreshFog: boolean }
): GameState {
  if (!canPlaceUnitAt(state, owner, unitType, coord)) {
    appendOwnerLog(state, owner, `${owner} placement rejected - choose a valid back-row or supply unit tile with available material.`);
    return state;
  }

  const economy = getEconomy(state, owner);
  const unitLevel = takeInventoryUnitLevel(economy, unitType, requestedUnitLevel);
  if (!unitLevel) {
    appendOwnerLog(state, owner, `${owner} placement rejected - no ${unitType} material available.`);
    return state;
  }

  const placementAnchor =
    getUnitDefinition(unitType).domain === "Ground" && !isOwnerBackRow(state, owner, coord)
      ? getOwnerSupplyTruckPlacementAnchor(state, owner, coord)
      : undefined;
  const maxHealth = getEffectiveUnitHealth(state, owner, unitType, unitLevel);
  const id = `unit-${state.nextId}`;
  state.nextId += 1;
  const placedUnit: UnitInstance = {
    id,
    owner,
    type: unitType,
    level: unitLevel,
    coord: { ...coord },
    health: maxHealth,
    maxHealth,
    placedDay: state.day,
    hasMovedThisDay: false,
    movementSpentThisDay: 0,
    hasAttackedThisDay: false,
    hasProvidedPlacementThisDay: false
  };
  state.units.push(placedUnit);
  if (placementAnchor) {
    placementAnchor.hasProvidedPlacementThisDay = true;
    placementAnchor.queuedMovement = undefined;
  }
  if (selectionMode === "select") {
    state.selection = {
      selectedHexId: hexId(coord),
      selectedUnitId: id
    };
  } else if (selectionMode === "clear") {
    state.selection = {
      selectedHexId: null,
      selectedUnitId: null
    };
  }
  if (canRevealOwnerAction(owner) || isCoordVisibleToPlayer(state, coord)) {
    appendLog(state, `${owner} placed ${unitType} L${unitLevel} at ${displayHexId(state.map, coord)}.${formatDebugUnitLogDetail(placedUnit)}`);
  }
  return options.refreshFog ? updateFog(state) : state;
}

export function getBestInventoryUnitLevel(economy: EconomyState, unitType: UnitType): number | undefined {
  const levels = economy.inventoryByLevel?.[unitType] ?? {};
  return Object.entries(levels)
    .filter(([, count]) => Number(count) > 0)
    .map(([level]) => Number(level))
    .filter((level) => Number.isFinite(level))
    .sort((first, second) => second - first)[0];
}

export function takeInventoryUnitLevel(economy: EconomyState, unitType: UnitType, requestedUnitLevel?: number): number | undefined {
  const level = requestedUnitLevel ? getAvailableInventoryUnitLevel(economy, unitType, requestedUnitLevel) : getBestInventoryUnitLevel(economy, unitType);
  if (!level) {
    return undefined;
  }

  economy.inventoryByLevel ??= Object.fromEntries(UNIT_DEFINITIONS.map((unit) => [unit.type, {}])) as NonNullable<EconomyState["inventoryByLevel"]>;
  const levels = economy.inventoryByLevel[unitType] ?? {};
  levels[level] = Math.max(0, (levels[level] ?? 0) - 1);
  if (levels[level] <= 0) {
    delete levels[level];
  }
  economy.inventoryByLevel[unitType] = levels;
  economy.inventory[unitType] = Math.max(0, (economy.inventory[unitType] ?? 0) - 1);
  return level;
}

function getAvailableInventoryUnitLevel(economy: EconomyState, unitType: UnitType, requestedUnitLevel: number): number | undefined {
  const level = Math.floor(requestedUnitLevel);
  if (!Number.isFinite(level) || level <= 0) {
    return undefined;
  }

  return Number(economy.inventoryByLevel?.[unitType]?.[level] ?? 0) > 0 ? level : undefined;
}

export function addInventoryUnitAtLevel(economy: EconomyState, unitType: UnitType, level: number): void {
  economy.inventoryByLevel ??= Object.fromEntries(UNIT_DEFINITIONS.map((unit) => [unit.type, {}])) as NonNullable<EconomyState["inventoryByLevel"]>;
  economy.inventoryByLevel[unitType] ??= {};
  const normalizedLevel = Math.min(getMaxUnitLevel(unitType), Math.max(1, Math.floor(level)));
  economy.inventoryByLevel[unitType][normalizedLevel] = (economy.inventoryByLevel[unitType][normalizedLevel] ?? 0) + 1;
  economy.inventory[unitType] = (economy.inventory[unitType] ?? 0) + 1;
}

export function moveUnitTo(
  state: GameState,
  unit: UnitInstance,
  coord: UnitInstance["coord"],
  selectionMode: "select" | "clear" | "preserve",
  context?: EngineDispatchContext,
  options: { refreshFog?: boolean } = {}
): GameState {
  if (!canMoveUnitTo(state, unit, coord)) {
    appendOwnerLog(state, unit.owner, `${unit.owner} move rejected - destination invalid.${formatDebugUnitLogDetail(unit)}`);
    return state;
  }

  const fromCoord = { ...unit.coord };
  recordEnemyMovementTrail(state, unit, getMovementTrailCoords(state, unit, coord), context);
  const moveCost = hexDistance(unit.coord, coord);
  const from = displayHexId(state.map, unit.coord);
  const movementLog = formatUnitMovementLog(unit, from, displayHexId(state.map, coord), {
    fromVisible: canRevealOwnerAction(unit.owner) || isCoordVisibleToPlayer(state, fromCoord),
    toVisible: canRevealOwnerAction(unit.owner) || isCoordVisibleToPlayer(state, coord)
  }, getDebugUnitLogDetail(unit, getEnemyUnitLogDetail(unit, context)));
  unit.coord = { ...coord };
  unit.movementSpentThisDay = (unit.movementSpentThisDay ?? 0) + moveCost;
  unit.hasMovedThisDay = unit.movementSpentThisDay >= getEffectiveUnitStats(state, unit.owner, unit.type, unit.level, unit.coord).moveRange;
  if (selectionMode === "select") {
    state.selection = {
      selectedHexId: hexId(unit.coord),
      selectedUnitId: unit.id
    };
  } else if (selectionMode === "clear") {
    state.selection = {
      selectedHexId: null,
      selectedUnitId: null
    };
  }
  if (movementLog) {
    appendLog(state, movementLog);
  }
  return options.refreshFog === false ? state : updateFog(state);
}

export function queueUnitMovement(state: GameState, unit: UnitInstance, destination: UnitInstance["coord"], context?: EngineDispatchContext): GameState {
  if (!canQueueMoveUnitTo(state, unit, destination)) {
    appendOwnerLog(state, unit.owner, `${unit.owner} movement rejected - no valid route to destination.${formatDebugUnitLogDetail(unit)}`);
    return state;
  }

  const path = findMovementPath(state, unit, destination, { allowFutureMovement: true });
  if (!path?.length) {
    appendOwnerLog(state, unit.owner, `${unit.owner} movement rejected - no valid route to destination.${formatDebugUnitLogDetail(unit)}`);
    return state;
  }

  const remainingMovement = getRemainingMovementPoints(state, unit);
  const advanceSteps = getQueuedAdvanceStepCount(state, unit, path, remainingMovement);

  if (advanceSteps >= path.length) {
    unit.queuedMovement = undefined;
    return moveQueuedUnitTo(state, unit, path[path.length - 1], advanceSteps, "clear", path.slice(0, advanceSteps), context);
  }

  if (advanceSteps > 0) {
    moveQueuedUnitTo(state, unit, path[advanceSteps - 1], advanceSteps, "clear", path.slice(0, advanceSteps), context);
  }

  unit.queuedMovement = {
    destination: { ...destination },
    path: path.slice(advanceSteps).map((coord) => ({ ...coord })),
    createdDay: state.day
  };
  appendLog(
    state,
    `${unit.type} queued movement to ${displayHexId(state.map, destination)} (${getQueuedMovementMoveCount(state, unit)} moves remaining).${formatDebugUnitLogDetail(unit)}`
  );
  return updateFog(state);
}

export function advanceQueuedMovements(state: GameState, owner: Owner, context?: EngineDispatchContext): void {
  for (const unit of state.units.filter((candidate) => candidate.owner === owner && candidate.queuedMovement)) {
    advanceQueuedMovement(state, unit, context);
  }
}

export function advanceQueuedMovement(state: GameState, unit: UnitInstance, context?: EngineDispatchContext): void {
  const queued = unit.queuedMovement;
  if (!queued) {
    return;
  }

  const path = queued.path;
  if (!path.length) {
    appendOwnerLog(state, unit.owner, `${unit.owner} ${unit.type} queued movement cancelled - route blocked.${formatDebugUnitLogDetail(unit)}`);
    unit.queuedMovement = undefined;
    return;
  }

  const remainingMovement = getRemainingMovementPoints(state, unit);
  if (remainingMovement <= 0) {
    return;
  }

  const advanceSteps = getQueuedAdvanceStepCount(state, unit, path, remainingMovement);
  if (advanceSteps <= 0) {
    appendOwnerLog(state, unit.owner, `${unit.owner} ${unit.type} queued movement paused - route blocked.${formatDebugUnitLogDetail(unit)}`);
    unit.queuedMovement = {
      ...queued,
      path: path.map((coord) => ({ ...coord }))
    };
    return;
  }

  moveQueuedUnitTo(state, unit, path[advanceSteps - 1], advanceSteps, "preserve", path.slice(0, advanceSteps), context);
  if (advanceSteps >= path.length) {
    appendOwnerLog(state, unit.owner, `${unit.owner} ${unit.type} completed queued movement to ${displayHexId(state.map, unit.coord)}.${formatDebugUnitLogDetail(unit)}`);
    unit.queuedMovement = undefined;
    return;
  }

  unit.queuedMovement = {
    ...queued,
    path: path.slice(advanceSteps)
  };
  appendOwnerLog(
    state,
    unit.owner,
    `${unit.owner} ${unit.type} advanced toward ${displayHexId(state.map, queued.destination)} (${getQueuedMovementMoveCount(state, unit)} moves remaining).${formatDebugUnitLogDetail(unit)}`
  );
}

export function getQueuedAdvanceStepCount(state: GameState, unit: UnitInstance, path: UnitInstance["coord"][], movementPoints: number): number {
  const maxSteps = Math.min(path.length, Math.max(0, movementPoints));
  for (let steps = maxSteps; steps >= 1; steps -= 1) {
    let from = unit.coord;
    const stepPath = path.slice(0, steps);
    const destinationMovementPoints = state.debugOptions?.[unit.owner]?.unlimitedMovement
      ? DEBUG_UNLIMITED_RANGE
      : getEffectiveUnitStats(state, unit.owner, unit.type, unit.level, unit.coord, stepPath[stepPath.length - 1]).moveRange - (unit.movementSpentThisDay ?? 0);
    if (steps > destinationMovementPoints) {
      continue;
    }
    if (
      stepPath.every((coord) => {
        const valid = canUnitEndMovementAt(state, unit, coord) && canOwnerMoveAcrossFrontLine(state, unit.owner, from, coord);
        from = coord;
        return valid;
      })
    ) {
      return steps;
    }
  }

  return 0;
}

export function moveQueuedUnitTo(
  state: GameState,
  unit: UnitInstance,
  coord: UnitInstance["coord"],
  moveCost: number,
  selectionMode: "clear" | "preserve",
  path: UnitInstance["coord"][],
  context?: EngineDispatchContext
): GameState {
  const fromCoord = { ...unit.coord };
  recordEnemyMovementTrail(state, unit, [fromCoord, ...path.map((pathCoord) => ({ ...pathCoord }))], context);
  const from = displayHexId(state.map, unit.coord);
  const movementLog = formatUnitMovementLog(unit, from, displayHexId(state.map, coord), {
    fromVisible: canRevealOwnerAction(unit.owner) || isCoordVisibleToPlayer(state, fromCoord),
    toVisible: canRevealOwnerAction(unit.owner) || isCoordVisibleToPlayer(state, coord)
  }, getDebugUnitLogDetail(unit, getEnemyUnitLogDetail(unit, context)));
  unit.coord = { ...coord };
  unit.movementSpentThisDay = (unit.movementSpentThisDay ?? 0) + moveCost;
  unit.hasMovedThisDay = unit.movementSpentThisDay >= getEffectiveUnitStats(state, unit.owner, unit.type, unit.level, unit.coord).moveRange;
  if (selectionMode === "clear") {
    state.selection = {
      selectedHexId: null,
      selectedUnitId: null
    };
  }
  if (movementLog) {
    appendLog(state, movementLog);
  }
  return updateFog(state);
}

export function getMovementTrailCoords(state: GameState, unit: UnitInstance, destination: UnitInstance["coord"]): UnitInstance["coord"][] {
  const path = findMovementPath(state, unit, destination);
  if (!path?.length) {
    return [{ ...unit.coord }, { ...destination }];
  }

  return [{ ...unit.coord }, ...path.map((coord) => ({ ...coord }))];
}

export function recordEnemyMovementTrail(
  state: GameState,
  unit: UnitInstance,
  path: UnitInstance["coord"][],
  context?: EngineDispatchContext
): void {
  if (!context || unit.owner !== "Enemy" || path.length < 2) {
    return;
  }

  const visibleCoords = debugEnemyOwnerLogs
    ? path
    : path.filter((coord) => getVisibleHexIdsForOwner(state, "Player").has(hexId(coord)));
  if (!visibleCoords.length) {
    return;
  }

  context.enemyMovementTrails.push({
    unitId: unit.id,
    unitType: unit.type,
    coords: visibleCoords.map((coord) => ({ ...coord }))
  });
}

export function attackHexWithUnit(
  state: GameState,
  unit: UnitInstance,
  coord: UnitInstance["coord"],
  context?: EngineDispatchContext,
  options: { refreshFog?: boolean } = {}
): GameState {
  if (unit.hasAttackedThisDay) {
    appendOwnerLog(state, unit.owner, `${unit.owner} attack rejected - unit already attacked this day.${formatDebugUnitLogDetail(unit, getEnemyUnitLogDetail(unit, context))}`);
    return state;
  }

  if (!canUnitAttackHex(state, unit, coord)) {
    appendOwnerLog(state, unit.owner, `${unit.owner} attack rejected - target outside range.${formatDebugUnitLogDetail(unit, getEnemyUnitLogDetail(unit, context))}`);
    return state;
  }

  const targetLabel = displayHexId(state.map, coord);
  const seen = canRevealOwnerAction(unit.owner) || canPlayerSeeAction(state, [unit.coord, coord]);
  const attackerLogDetail = getEnemyUnitLogDetail(unit, context);
  unit.hasAttackedThisDay = true;
  const opposingUnits = getOpposingUnitsAt(state, unit.owner, coord);
  const target = unit.owner === "Enemy" ? getBestEnemyAttackTarget(state, unit, opposingUnits) : getBestAttackTarget(state, unit, opposingUnits);
  if (!target) {
    if (seen) {
      appendLog(state, `${unit.owner} ${unit.type} attacked ${targetLabel}; no eligible target hit.${formatDebugUnitLogDetail(unit, attackerLogDetail)}`);
    }
    return state;
  }

  const attackResult = calculateAttackResult(state, unit, target);
  if (attackResult.missed) {
    if (seen) {
      appendLog(state, `${unit.owner} ${unit.type} missed ${target.owner} ${target.type} at ${targetLabel}${formatAttackModifiers(attackResult)}.${formatDebugCombatLogDetail(unit, target, attackerLogDetail)}`);
    }
    return state;
  }

  const damage = state.debugOptions?.[target.owner]?.noDamage ? 0 : attackResult.damage;
  target.health -= damage;
  if (target.health <= 0) {
    const gainAward = awardGainForDestroyedUnit(state, unit.owner, target);
    state.units = state.units.filter((candidate) => candidate.id !== target.id);
    if (seen) {
      appendLog(
        state,
        `${unit.owner} ${unit.type} destroyed ${target.owner} ${target.type} at ${targetLabel} for ${damage}${formatAttackModifiers(attackResult)} and secured ${gainAward} gain.${formatDebugCombatLogDetail(unit, target, attackerLogDetail)}`
      );
    }
    return options.refreshFog === false ? state : updateFog(state);
  }

  if (seen) {
    appendLog(
      state,
      `${unit.owner} ${unit.type} hit ${target.owner} ${target.type} at ${targetLabel} for ${damage}${formatAttackModifiersWithDebugDamage(state, target.owner, attackResult)}.`
        + formatDebugCombatLogDetail(unit, target, attackerLogDetail)
    );
  }
  return options.refreshFog === false ? state : updateFog(state);
}

function awardGainForDestroyedUnit(state: GameState, owner: Owner, destroyedUnit: UnitInstance): number {
  const gainAward = getDestroyedUnitGainReward(destroyedUnit.type, getUnitInstanceLevel(state, destroyedUnit));
  const economy = getEconomy(state, owner);
  economy.gainPoints += gainAward;
  return gainAward;
}

function formatAttackModifiersWithDebugDamage(state: GameState, owner: Owner, result: AttackDamageResult): string {
  if (!state.debugOptions?.[owner]?.noDamage) {
    return formatAttackModifiers(result);
  }

  const modifiers = [
    "debug no damage",
    result.critical ? "critical hit" : null,
    result.stealth ? "stealth attack" : null
  ].filter((modifier): modifier is string => Boolean(modifier));
  return ` (${modifiers.join(", ")})`;
}

function getEnemyUnitLogDetail(unit: UnitInstance, context?: EngineDispatchContext): EnemyUnitLogDetail | undefined {
  if (!debugEnemyOwnerLogs || unit.owner !== "Enemy") {
    return undefined;
  }

  return context?.enemyUnitLogDetails?.[unit.id];
}

export function completeProduction(state: GameState, owner: Owner): void {
  const economy = getEconomy(state, owner);
  const completed = economy.productionQueue.filter((job) => job.owner === owner && job.availableDay <= state.day);
  economy.productionQueue = economy.productionQueue.filter((job) => job.availableDay > state.day);

  for (const job of completed) {
    const unitLevel = Math.min(getMaxUnitLevel(job.unitType), job.unitLevel ?? economy.unitLevels[job.unitType]);
    addInventoryUnitAtLevel(economy, job.unitType, unitLevel);
    economy.lastProductionUnitType = job.unitType;
    appendOwnerLog(state, owner, `${owner} ${job.unitType} L${unitLevel} available.`);
  }
}

export function completeResearch(state: GameState, owner: Owner): void {
  const economy = getEconomy(state, owner);
  const completed = economy.researchQueue.filter((job) => job.owner === owner && job.completeDay <= state.day);
  economy.researchQueue = economy.researchQueue.filter((job) => job.completeDay > state.day);

  for (const job of completed) {
    applyCompletedResearchJob(state, owner, economy, job);
  }
}

function applyCompletedResearchJob(state: GameState, owner: Owner, economy: EconomyState, job: ResearchJob): void {
  if (job.type === "UnitUpgrade" && job.unitType) {
    economy.unitLevels[job.unitType] = Math.min(getMaxUnitLevel(job.unitType), Math.max(economy.unitLevels[job.unitType] + 1, job.targetLevel ?? economy.unitLevels[job.unitType] + 1));
    appendOwnerLog(state, owner, `${owner} ${job.unitType} future production upgraded to level ${economy.unitLevels[job.unitType]}.`);
    return;
  }

  if (job.type === "UnlockSpecialServices") {
    addBuilding(state, owner, "Special Services");
    appendOwnerLog(state, owner, `${owner} completed Special Services.`);
    return;
  }

  if (job.type === "UnlockRoom") {
    addBuilding(state, owner, "The Room");
    appendOwnerLog(state, owner, `${owner} completed The Room.`);
    return;
  }

  if (job.type === "UnlockDroneFactory") {
    addBuilding(state, owner, "Drone Factory");
    appendOwnerLog(state, owner, `${owner} completed Drone Factory.`);
    return;
  }

  if (job.type === "Efficiency") {
    const oldLevel = economy.efficiencyLevel;
    economy.efficiencyLevel = Math.max(economy.efficiencyLevel + 1, job.targetLevel ?? economy.efficiencyLevel + 1);
    economy.incomePoundsBn += Math.max(1, economy.efficiencyLevel - oldLevel) * 2;
    appendOwnerLog(state, owner, `${owner} Efficiency level ${economy.efficiencyLevel}.`);
    return;
  }

  if (job.type === "ProductionCapacity") {
    economy.productionCapacityLevel = Math.max(economy.productionCapacityLevel + 1, job.targetLevel ?? economy.productionCapacityLevel + 1);
    normalizeProductionQueueSchedule(state, economy);
    appendOwnerLog(state, owner, `${owner} Production Capacity level ${economy.productionCapacityLevel}.`);
    return;
  }

  if (job.type === "ResearchCapacity") {
    economy.researchCapacityLevel = Math.max(economy.researchCapacityLevel + 1, job.targetLevel ?? economy.researchCapacityLevel + 1);
    normalizeResearchQueueSchedule(state, economy);
    appendOwnerLog(state, owner, `${owner} Research Capacity level ${economy.researchCapacityLevel}.`);
    return;
  }

  if (job.type === "ProductionSpeed") {
    economy.productionSpeedLevel = Math.max(economy.productionSpeedLevel + 1, job.targetLevel ?? economy.productionSpeedLevel + 1);
    normalizeProductionQueueSchedule(state, economy);
    appendOwnerLog(state, owner, `${owner} Production Speed level ${economy.productionSpeedLevel}.`);
    return;
  }

  economy.researchSpeedLevel = Math.max(economy.researchSpeedLevel + 1, job.targetLevel ?? economy.researchSpeedLevel + 1);
  normalizeResearchQueueSchedule(state, economy);
  appendOwnerLog(state, owner, `${owner} Research Speed level ${economy.researchSpeedLevel}.`);
}

export function canUpgradeFieldUnit(state: GameState, unit: UnitInstance, currency: PurchaseCurrency = "funds"): boolean {
  const economy = getEconomy(state, unit.owner);
  const unitLevel = getUnitInstanceLevel(state, unit);
  const cost = currency === "gain" ? getFieldUnitUpgradeGainCost(unit.type, unitLevel) : getFieldUnitUpgradeCost(unit.type, unitLevel);
  return unitLevel < economy.unitLevels[unit.type] && (currency === "gain" ? economy.gainPoints >= cost : economy.moneyPoundsBn >= cost);
}

export function upgradeFieldUnit(state: GameState, unit: UnitInstance, currency: PurchaseCurrency = "funds"): boolean {
  const economy = getEconomy(state, unit.owner);
  const oldLevel = getUnitInstanceLevel(state, unit);
  const targetLevel = oldLevel + 1;
  const maxAvailableLevel = economy.unitLevels[unit.type];
  if (targetLevel > maxAvailableLevel) {
    appendOwnerLog(state, unit.owner, `${unit.owner} field upgrade rejected - ${unit.type} production is only level ${maxAvailableLevel}.${formatDebugUnitLogDetail(unit)}`);
    return false;
  }

  const cost = currency === "gain" ? getFieldUnitUpgradeGainCost(unit.type, oldLevel) : getFieldUnitUpgradeCost(unit.type, oldLevel);
  if (currency === "gain" && economy.gainPoints < cost) {
    appendOwnerLog(state, unit.owner, `${unit.owner} field upgrade rejected - ${unit.type} L${oldLevel} -> L${targetLevel} requires ${cost} gain.${formatDebugUnitLogDetail(unit)}`);
    return false;
  }

  if (currency === "funds" && economy.moneyPoundsBn < cost) {
    appendOwnerLog(state, unit.owner, `${unit.owner} field upgrade rejected - ${unit.type} L${oldLevel} -> L${targetLevel} requires £${cost}B.${formatDebugUnitLogDetail(unit)}`);
    return false;
  }

  if (currency === "gain") {
    economy.gainPoints -= cost;
  } else {
    economy.moneyPoundsBn -= cost;
  }
  const oldMaxHealth = unit.maxHealth;
  unit.level = targetLevel;
  const newMaxHealth = getEffectiveUnitHealth(state, unit.owner, unit.type, unit.level);
  const healthGain = Math.max(0, newMaxHealth - oldMaxHealth);
  unit.maxHealth = newMaxHealth;
  unit.health = Math.min(newMaxHealth, unit.health + healthGain);
  appendOwnerLog(state, unit.owner, `${unit.owner} upgraded field ${unit.type} to level ${unit.level} for ${currency === "gain" ? `${cost} gain` : `£${cost}B`}.${formatDebugUnitLogDetail(unit)}`);
  return true;
}

export function repairBackRowUnits(state: GameState): void {
  for (const unit of state.units) {
    const repairRatio = isOwnerBackRow(state, unit.owner, unit.coord)
      ? 1
      : getUnitDefinition(unit.type).domain === "Ground"
        ? getOwnerSupplyTruckRepairHealthRatio(state, unit.owner, unit.coord, SUPPLY_TRUCK_REPAIR_RANGE)
        : undefined;
    if (
      unit.health >= unit.maxHealth ||
      repairRatio === undefined
    ) {
      continue;
    }

    const previousHealth = unit.health;
    const repairAmount = Math.max(1, Math.ceil(unit.maxHealth * BACK_ROW_REPAIR_PERCENT * repairRatio));
    unit.health = Math.min(unit.maxHealth, unit.health + repairAmount);
    appendOwnerLog(state, unit.owner, formatUnitRepairLog(unit, displayHexId(state.map, unit.coord), unit.health - previousHealth, getDebugUnitLogDetail(unit)));
  }
}

export function addBuilding(state: GameState, owner: Owner, type: BuildingType): void {
  if (ownerHasBuilding(state, owner, type)) {
    return;
  }

  state.buildings.push({
    id: `building-${state.nextId}`,
    owner,
    type
  });
  state.nextId += 1;
}

export const EFFECTIVENESS_MULTIPLIERS: Record<AttackEffectiveness, number> = {
  weak: 0.5,
  medium: 1,
  good: 1.5
};

export function getAttackEffectiveness(attackerType: UnitType, targetType: UnitType): AttackEffectiveness {
  return getUnitDefinition(attackerType).attackProfile[targetType] ?? "weak";
}

export interface AttackDamageResult {
  damage: number;
  critical: boolean;
  stealth: boolean;
  missed: boolean;
}

export function calculateAttackResult(state: GameState, attacker: UnitInstance, target: UnitInstance): AttackDamageResult {
  const missed = getCombatRoll(state, attacker, target, "miss") < ATTACK_MISS_CHANCE;
  const critical = !missed && getCombatRoll(state, attacker, target, "critical") < CRITICAL_HIT_CHANCE;
  const stealth = isStealthAttack(state, attacker, target);
  return {
    damage: missed ? 0 : calculateAttackDamage(state, attacker, target.type, { critical, stealth }),
    critical,
    stealth,
    missed
  };
}

export function getCombatRoll(state: GameState, attacker: UnitInstance, target: UnitInstance, salt: string): number {
  const input = `${state.seed}|${state.day}|${state.nextLogId}|${attacker.id}|${target.id}|${salt}`;
  return getStableHashRatio(input);
}

export function getStableHashRatio(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x100000000;
}

export function estimateAttackDamage(state: GameState, attacker: UnitInstance, target: UnitInstance): number {
  return calculateAttackDamage(state, attacker, target.type, {
    critical: false,
    stealth: isStealthAttack(state, attacker, target)
  });
}

export function calculateAttackDamage(
  state: GameState,
  attacker: UnitInstance,
  targetType: UnitType,
  modifiers: { critical: boolean; stealth: boolean } = { critical: false, stealth: false }
): number {
  const baseDamage = getBaseAttackDamage(attacker.type, getUnitInstanceLevel(state, attacker));
  const effectiveness = getAttackEffectiveness(attacker.type, targetType);
  const healthRatio = Math.max(0.01, Math.min(1, attacker.health / Math.max(1, attacker.maxHealth)));
  const criticalMultiplier = modifiers.critical ? CRITICAL_DAMAGE_MULTIPLIER : 1;
  const stealthMultiplier = modifiers.stealth ? STEALTH_DAMAGE_MULTIPLIER : 1;
  return Math.max(1, Math.ceil(baseDamage * EFFECTIVENESS_MULTIPLIERS[effectiveness] * healthRatio * criticalMultiplier * stealthMultiplier));
}

export function isStealthAttack(state: GameState, attacker: UnitInstance, target: UnitInstance): boolean {
  const opposingOwner = getOpposingOwner(attacker.owner);
  return target.owner === opposingOwner && isCoordInFogOfWarForOwner(state, opposingOwner, attacker.coord);
}

export function getOpposingOwner(owner: Owner): Owner {
  return owner === "Player" ? "Enemy" : "Player";
}

export function isCoordInFogOfWarForOwner(state: GameState, owner: Owner, coord: UnitInstance["coord"]): boolean {
  if (owner === "Player") {
    return state.fog[hexId(coord)] !== "visible";
  }

  return !getVisibleHexIdsForOwner(state, owner).has(hexId(coord));
}

export function formatAttackModifiers(result: AttackDamageResult): string {
  const modifiers = [
    result.missed ? "miss" : null,
    result.critical ? "critical hit" : null,
    result.stealth ? "stealth attack" : null
  ].filter((modifier): modifier is string => Boolean(modifier));
  return modifiers.length ? ` (${modifiers.join(", ")})` : "";
}

export function scoreAttackTarget(state: GameState, attacker: UnitInstance, target: UnitInstance, damage: number): number {
  const targetDefinition = getUnitDefinition(target.type);
  const targetStats = getEffectiveUnitStats(state, target.owner, target.type, target.level, target.coord);
  const targetValue = targetStats.health + getBaseAttackDamage(target.type, getUnitInstanceLevel(state, target)) * 2 + targetStats.moveRange * 8 + targetStats.attackRange * 8;
  const lethal = damage >= target.health;
  const ownBaseDistance = hexDistance(target.coord, state.bases[attacker.owner]);
  const targetCanReturnFire =
    canUnitTargetUnit(target.type, attacker.type) &&
    hexDistance(attacker.coord, target.coord) <= getEffectiveUnitStats(state, target.owner, target.type, target.level, target.coord, attacker.coord).attackRange;

  let score = damage * 8 + targetValue * 0.75 + (lethal ? 110 : 0) - Math.max(0, damage - target.health) * 0.35;

  if (targetDefinition.humanBased && sameHex(target.coord, state.bases[attacker.owner])) {
    score += 260;
  }

  if (targetDefinition.humanBased) {
    score += Math.max(0, 11 - ownBaseDistance) * 30;
  }

  if (targetCanReturnFire) {
    score += 36;
  }

  return score;
}

export function getBestAttackTarget(state: GameState, attacker: UnitInstance, enemies: UnitInstance[]): UnitInstance | undefined {
  return enemies
    .filter((enemy) => canUnitTargetUnit(attacker.type, enemy.type))
    .sort((first, second) => {
      const firstDamage = estimateAttackDamage(state, attacker, first);
      const secondDamage = estimateAttackDamage(state, attacker, second);
      return (
        scoreAttackTarget(state, attacker, second, secondDamage) - scoreAttackTarget(state, attacker, first, firstDamage) ||
        secondDamage - firstDamage ||
        first.health - second.health
      );
    })[0];
}

export function canStartResearch(
  state: GameState,
  owner: Owner,
  type: ResearchJob["type"],
  unitType: UnitType | undefined,
  options: { ignoreMoney?: boolean } = {}
): boolean {
  type = normalizeFactionResearchType(state, owner, type);
  const economy = getEconomy(state, owner);
  if (!isLevelResearch(type) && economy.researchQueue.some((job) => isSameResearchLine(job, type, unitType))) {
    appendOwnerLog(state, owner, `${owner} research rejected - already in progress.`);
    return false;
  }

  if (type === "UnitUpgrade") {
    if (!unitType) {
      appendOwnerLog(state, owner, `${owner} research rejected - choose a unit type.`);
      return false;
    }

    if (!isUnitAvailableToOwnerInState(state, owner, unitType)) {
      appendOwnerLog(state, owner, `${owner} research rejected - unit unavailable.`);
      return false;
    }

    const maxLevel = getMaxUnitLevel(unitType);
    if (getNextResearchStartLevel(economy, type, unitType) >= maxLevel) {
      appendOwnerLog(state, owner, `${owner} research rejected - unit already level ${maxLevel}.`);
      return false;
    }
  }

  if (type === "UnlockSpecialServices" && ownerHasBuilding(state, owner, "Special Services")) {
    appendOwnerLog(state, owner, `${owner} research rejected - Special Services already exists.`);
    return false;
  }

  if (type === "UnlockRoom" && getOwnerFaction(state, owner) !== "Empire") {
    appendOwnerLog(state, owner, `${owner} research rejected - The Room is unavailable.`);
    return false;
  }

  if (type === "UnlockRoom" && !ownerHasBuilding(state, owner, "Special Services")) {
    appendOwnerLog(state, owner, `${owner} research rejected - Special Services required.`);
    return false;
  }

  if (type === "UnlockRoom" && ownerHasBuilding(state, owner, "The Room")) {
    appendOwnerLog(state, owner, `${owner} research rejected - The Room already exists.`);
    return false;
  }

  if (type === "UnlockDroneFactory" && getOwnerFaction(state, owner) !== "Alliance") {
    appendOwnerLog(state, owner, `${owner} research rejected - Drone Factory is unavailable.`);
    return false;
  }

  if (type === "UnlockDroneFactory" && !ownerHasBuilding(state, owner, "Special Services")) {
    appendOwnerLog(state, owner, `${owner} research rejected - Special Services required.`);
    return false;
  }

  if (type === "UnlockDroneFactory" && ownerHasBuilding(state, owner, "Drone Factory")) {
    appendOwnerLog(state, owner, `${owner} research rejected - Drone Factory already exists.`);
    return false;
  }

  const startLevel = getNextResearchStartLevel(economy, type, unitType);
  const cost = getResearchCost(type, unitType, economy, startLevel);
  if (!options.ignoreMoney && economy.moneyPoundsBn < cost) {
    appendOwnerLog(state, owner, `${owner} research rejected - requires £${cost}B.`);
    return false;
  }

  return true;
}

export function getOwnerGateIncomeBonus(state: GameState, owner: Owner): number {
  const economy = getEconomy(state, owner);
  return (state.gates ?? []).filter((gate) => gate.owner === owner).length * getGateIncomeBonusForEconomy(economy);
}

export function updateGateOccupation(state: GameState): void {
  const controlsBothGatesBefore: Record<Owner, boolean> = {
    Player: ownerControlsBothGates(state, "Player"),
    Enemy: ownerControlsBothGates(state, "Enemy")
  };

  for (const gate of state.gates ?? []) {
    updateSingleGateOccupation(state, gate);
  }

  appendBarrierTransitionLogs(state, controlsBothGatesBefore);
}

export function appendBarrierTransitionLogs(state: GameState, controlsBothGatesBefore: Record<Owner, boolean>): void {
  appendBarrierTransitionLog(state, "Player", getOwnerSideName(state, "Player"), getOwnerSideName(state, "Enemy"), controlsBothGatesBefore.Player);
  appendBarrierTransitionLog(state, "Enemy", getOwnerSideName(state, "Enemy"), getOwnerSideName(state, "Player"), controlsBothGatesBefore.Enemy);
}

export function appendBarrierTransitionLog(
  state: GameState,
  owner: Owner,
  controllerName: "The Empire" | "The Alliance",
  barrierName: "The Alliance" | "The Empire",
  controlledBefore: boolean
): void {
  const controlledAfter = ownerControlsBothGates(state, owner);
  if (controlledBefore === controlledAfter) {
    return;
  }

  appendLog(
    state,
    controlledAfter
      ? `${controllerName} has captured both Gates. ${barrierName}'s Barrier has fallen.`
      : `${controllerName} no longer controls both Gates. ${barrierName}'s Barrier has been restored.`
  );
}

export function updateSingleGateOccupation(state: GameState, gate: GateState): void {
  const occupier = getGateOccupier(state, gate);

  if (occupier === "Contested") {
    return;
  }

  if (!occupier) {
    gate.occupation.Player = 0;
    gate.occupation.Enemy = 0;
    return;
  }

  const otherOwner: Owner = occupier === "Player" ? "Enemy" : "Player";
  gate.occupation[occupier] = Math.min(GATE_CAPTURE_DAYS, gate.occupation[occupier] + 1);
  gate.occupation[otherOwner] = 0;

  if (gate.owner !== occupier && gate.occupation[occupier] >= GATE_CAPTURE_DAYS) {
    gate.owner = occupier;
    if (state.fog[hexId(gate.coord)] === "visible") {
      const gateCost = getGateIncomeBonusForEconomy(getEconomy(state, occupier));
      appendLog(state, `${occupier} captured ${gate.label}. Current daily gate cost -£${gateCost}B and side-map sight secured.`);
    }
  }
}

export function getGateOccupier(state: GameState, gate: GateState): Owner | "Contested" | null {
  const occupiers = state.units
    .filter((unit) => sameHex(unit.coord, gate.coord) && getUnitDefinition(unit.type).humanBased)
    .map((unit) => unit.owner);

  const playerOccupies = occupiers.includes("Player");
  const enemyOccupies = occupiers.includes("Enemy");
  if (playerOccupies && enemyOccupies) {
    return "Contested";
  }

  if (enemyOccupies) {
    return "Enemy";
  }

  if (playerOccupies) {
    return "Player";
  }

  return null;
}

export function updateBaseOccupation(state: GameState): void {
  const playerCapturing = state.units.some(
    (unit) =>
      unit.owner === "Player" &&
      ownerControlsBothGates(state, "Player") &&
      sameHex(unit.coord, state.bases.Enemy) &&
      getUnitDefinition(unit.type).humanBased
  );
  const enemyCapturing = state.units.some(
    (unit) =>
      unit.owner === "Enemy" &&
      ownerControlsBothGates(state, "Enemy") &&
      sameHex(unit.coord, state.bases.Player) &&
      getUnitDefinition(unit.type).humanBased
  );

  state.baseOccupation.Enemy = playerCapturing ? state.baseOccupation.Enemy + 1 : 0;
  state.baseOccupation.Player = enemyCapturing ? state.baseOccupation.Player + 1 : 0;

  if (state.baseOccupation.Enemy >= BASE_CAPTURE_DAYS) {
    state.winner = "Player";
    appendLog(state, `${getOwnerSideName(state, "Player").replace("The ", "")} wins. ${getOwnerBaseName(state, "Enemy")} occupied for four days.`);
  } else if (state.baseOccupation.Player >= BASE_CAPTURE_DAYS) {
    state.winner = "Enemy";
    appendLog(state, `${getOwnerSideName(state, "Enemy").replace("The ", "")} wins. ${getOwnerBaseName(state, "Player")} occupied for four days.`);
  }
}

function advanceEnemyTurnAndStartNextDay(state: GameState, context: EngineDispatchContext): void {
  updateGateOccupation(state);
  applyFrontLineAttrition(state);
  updateBaseOccupation(state);
  if (state.winner) {
    return;
  }

  const playerGateCost = getOwnerGateIncomeBonus(state, "Player");
  const enemyGateCost = getOwnerGateIncomeBonus(state, "Enemy");
  state.day += 1;
  state.economy.moneyPoundsBn += state.economy.incomePoundsBn - playerGateCost;
  state.enemyEconomy.moneyPoundsBn += state.enemyEconomy.incomePoundsBn - enemyGateCost;
  awardDailyUnitGain(state, "Player");
  awardDailyUnitGain(state, "Enemy");
  state.units.forEach((unit) => {
    unit.hasMovedThisDay = false;
    unit.movementSpentThisDay = 0;
    unit.hasAttackedThisDay = false;
    unit.hasProvidedPlacementThisDay = false;
  });
  repairBackRowUnits(state);

  completeProduction(state, "Player");
  completeProduction(state, "Enemy");
  completeResearch(state, "Player");
  completeResearch(state, "Enemy");
  appendLog(
    state,
    `Day ${state.day} started. Player ${formatMoneyDelta(state.economy.incomePoundsBn - playerGateCost)}.`
  );
  appendOwnerLog(state, "Enemy", `Enemy ${formatMoneyDelta(state.enemyEconomy.incomePoundsBn - enemyGateCost)}.`);
}

export function applyFrontLineAttrition(state: GameState): void {
  const losses: string[] = [];
  for (const unit of state.units) {
    if (state.debugOptions?.[unit.owner]?.noDamage || !isCoordPastEnemyFrontLine(state, unit.owner, unit.coord) || ownerControlsBothGates(state, unit.owner)) {
      continue;
    }

    const damage = Math.max(1, Math.ceil(unit.health * FRONT_LINE_ATTRITION_PERCENT));
    unit.health -= damage;
    const unitLabel = `${unit.owner} ${unit.type} at ${displayHexId(state.map, unit.coord)}`;
    losses.push(unit.health <= 0 ? `${unitLabel} was destroyed by attrition after losing ${damage} HP` : `${unitLabel} lost ${damage} HP`);
  }

  if (!losses.length) {
    return;
  }

  state.units = state.units.filter((unit) => unit.health > 0);
  appendLog(state, `Area attrition - ${losses.join("; ")}.`);
}
