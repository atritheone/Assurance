import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILDING_DEFINITIONS } from "../src/renderer/data/buildingDefs";
import { UNIT_DEFINITIONS } from "../src/renderer/data/unitDefs";
import { calculateAttackResult, createGameEngine, isStealthAttack, placeUnit, repairBackRowUnits, setDebugEnemyOwnerLogs } from "../src/renderer/game/engine";
import { runAssuranceAiTests } from "../src/renderer/game/ai";
import { getDestroyedUnitGainReward, getProductionFinishGainCost, getProductionGainCost, getResearchFinishGainCost, getResearchGainCost, getUnitDailyGainValue } from "../src/renderer/game/economy";
import { updateFog } from "../src/renderer/game/fog";
import { appendLog, formatUnitMovementLog } from "../src/renderer/game/log";
import { getNeighborCoords, hexDistance, sameHex } from "../src/renderer/game/map";
import { createDefaultStartOptions, createDefaultStartOptionsForPlayerFaction, createInitialState } from "../src/renderer/game/state";
import { getBaseAttackDamage, getBaseEffectiveUnitStats, getEffectiveUnitStats } from "../src/renderer/game/unitStats";
import { canMoveUnitTo, canPlaceUnitAt, canSupplyTruckEnablePlacement, canUnitAttackThisDay, canUnitTargetUnit } from "../src/renderer/game/units";
import type { BuildingType, Difficulty, Faction, GameState, HexCoord, Owner, ResearchType, UnitInstance, UnitType } from "../src/renderer/game/types";

function createScenario(day: number, money = 0, unlockedBuildings: BuildingType[] = [], difficulty: Difficulty = "Hard"): GameState {
  const options = createDefaultStartOptions();
  options.difficulty = difficulty;
  options.Enemy.moneyPoundsBn = money;
  options.Enemy.unlockedBuildings = unlockedBuildings;
  const state = createInitialState(`campaign-test-${day}-${money}`, options);
  state.started = true;
  state.paused = false;
  state.day = day;
  return state;
}

function createPlayerFactionScenario(faction: Faction, unlockedBuildings: BuildingType[] = []): GameState {
  const options = createDefaultStartOptionsForPlayerFaction(faction);
  options.Player.moneyPoundsBn = 100;
  options.Player.unlockedBuildings = unlockedBuildings;
  const state = createInitialState(`campaign-test-player-${faction}`, options);
  state.started = true;
  state.paused = false;
  state.day = 4;
  return state;
}

function clearEnemyInventory(state: GameState): void {
  state.enemyEconomy.productionQueue = [];
  state.enemyEconomy.inventoryByLevel ??= Object.fromEntries(UNIT_DEFINITIONS.map((unit) => [unit.type, {}]));
  for (const unit of UNIT_DEFINITIONS) {
    state.enemyEconomy.inventory[unit.type] = 0;
    state.enemyEconomy.inventoryByLevel[unit.type] = {};
  }
}

function addEnemyInventory(state: GameState, unitType: UnitType, count = 1, level = 1): void {
  state.enemyEconomy.inventoryByLevel ??= Object.fromEntries(UNIT_DEFINITIONS.map((unit) => [unit.type, {}]));
  state.enemyEconomy.inventory[unitType] = (state.enemyEconomy.inventory[unitType] ?? 0) + count;
  state.enemyEconomy.inventoryByLevel[unitType] ??= {};
  state.enemyEconomy.inventoryByLevel[unitType][level] = (state.enemyEconomy.inventoryByLevel[unitType][level] ?? 0) + count;
}

function addUnit(state: GameState, owner: Owner, type: UnitType, coord: HexCoord, health?: number): UnitInstance {
  const stats = getEffectiveUnitStats(state, owner, type);
  const unit: UnitInstance = {
    id: `campaign-test-unit-${state.nextId}`,
    owner,
    type,
    level: owner === "Player" ? state.economy.unitLevels[type] : state.enemyEconomy.unitLevels[type],
    coord: { ...coord },
    health: health ?? stats.health,
    maxHealth: stats.health,
    placedDay: Math.max(1, state.day - 1),
    hasMovedThisDay: false,
    movementSpentThisDay: 0,
    hasAttackedThisDay: false
  };
  state.nextId += 1;
  state.units.push(unit);
  return unit;
}

function rememberForEnemy(state: GameState, unit: UnitInstance, spottedDay = state.day): void {
  state.spottedUnits.Enemy[unit.id] = {
    id: unit.id,
    owner: unit.owner,
    type: unit.type,
    level: unit.level,
    coord: { ...unit.coord },
    health: unit.health,
    maxHealth: unit.maxHealth,
    spottedDay
  };
}

function runEnemyTurn(state: GameState): GameState {
  return createGameEngine(updateFog(state)).dispatch({ type: "END_TURN" }).state;
}

function runEnemyTurns(state: GameState, count: number): GameState {
  let next = state;
  for (let index = 0; index < count; index += 1) {
    next = runEnemyTurn(next);
  }
  return next;
}

function isInEffectiveAttackRange(state: GameState, attacker: UnitInstance, targetCoord: HexCoord): boolean {
  const range = getEffectiveUnitStats(state, attacker.owner, attacker.type, attacker.level, attacker.coord, targetCoord).attackRange;
  return hexDistance(attacker.coord, targetCoord) <= range;
}

test("bundled runAssuranceAiTests suite is imported by the TypeScript runner", () => {
  assert.equal(typeof runAssuranceAiTests, "function");
});

test("player last-seen enemy intel preserves unit level after the tile returns to fog", () => {
  const state = createScenario(6);
  state.units = [];

  const scout = addUnit(state, "Player", "Infantry", { q: 5, r: 6 });
  const enemy = addUnit(state, "Enemy", "Tank", { q: 5, r: 5 });
  enemy.level = 3;

  const visibleState = updateFog(state);
  assert.equal(visibleState.fog["5,5"], "visible");
  assert.equal(visibleState.spottedUnits.Player[enemy.id]?.level, 3);

  const visibleScout = visibleState.units.find((unit) => unit.id === scout.id);
  assert(visibleScout);
  visibleScout.coord = { q: 0, r: state.map.height - 1 };
  const foggedState = updateFog(visibleState);

  assert.equal(foggedState.fog["5,5"], "fogged");
  assert.equal(foggedState.spottedUnits.Player[enemy.id]?.level, 3);
});

test("enemy stealth attacks depend on player fog-of-war for the attacker hex", () => {
  const state = createScenario(6);
  state.units = [];

  const target = addUnit(state, "Player", "Infantry", { q: 5, r: 6 });
  const attacker = addUnit(state, "Enemy", "Tank", { q: 5, r: 5 });

  const visibleState = updateFog(state);
  assert.equal(visibleState.fog["5,5"], "visible");
  assert.equal(isStealthAttack(visibleState, attacker, target), false);

  const foggedState = {
    ...visibleState,
    fog: {
      ...visibleState.fog,
      "5,5": "fogged" as const
    }
  };

  assert.equal(isStealthAttack(foggedState, attacker, target), true);
});

test("enemy movement logs only include visible endpoint coordinates", () => {
  const state = createScenario(6);
  state.units = [];
  const enemy = addUnit(state, "Enemy", "Supply Truck", { q: 15, r: 26 });

  assert.equal(
    formatUnitMovementLog(enemy, "15,26", "11,28", { fromVisible: true, toVisible: false }),
    "Enemy Supply Truck moved from 15,26."
  );
  assert.equal(
    formatUnitMovementLog(enemy, "15,26", "11,28", { fromVisible: false, toVisible: true }),
    "Enemy Supply Truck moved to 11,28."
  );
  assert.equal(
    formatUnitMovementLog(enemy, "15,26", "11,28", { fromVisible: true, toVisible: true }),
    "Enemy Supply Truck moved from 15,26 to 11,28."
  );
  assert.equal(formatUnitMovementLog(enemy, "15,26", "11,28", { fromVisible: false, toVisible: false }), null);
});

test("game log keeps the full record beyond the old visible entry cap", () => {
  const state = createScenario(1);
  state.log = [];

  for (let index = 0; index < 120; index += 1) {
    appendLog(state, `Audit entry ${index + 1}.`);
  }

  assert.equal(state.log.length, 120);
  assert.equal(state.log[0].text, "Audit entry 1.");
  assert.equal(state.log.at(-1)?.text, "Audit entry 120.");
});

test("enemy income is applied every day and only logged in debug owner logs", () => {
  const createIncomeState = (): GameState => {
    const options = createDefaultStartOptions();
    options.Player.moneyPoundsBn = 0;
    options.Player.incomePoundsBn = 7;
    options.Enemy.moneyPoundsBn = 0;
    options.Enemy.incomePoundsBn = 6;
    const state = createInitialState("income-debug-audit", options);
    state.started = true;
    state.units = [];
    state.log = [];
    return state;
  };

  try {
    setDebugEnemyOwnerLogs(false);
    const normalResult = createGameEngine(createIncomeState()).dispatch({ type: "END_TURN" });
    assert.equal(normalResult.state.economy.moneyPoundsBn, 7);
    assert.equal(normalResult.state.enemyEconomy.moneyPoundsBn, 6);
    assert(normalResult.logEntries.some((entry) => entry.text === "Day 2 started. Player +£7B."));
    assert(!normalResult.logEntries.some((entry) => entry.text === "Enemy +£6B."));

    setDebugEnemyOwnerLogs(true);
    const debugResult = createGameEngine(createIncomeState()).dispatch({ type: "END_TURN" });
    assert.equal(debugResult.state.economy.moneyPoundsBn, 7);
    assert.equal(debugResult.state.enemyEconomy.moneyPoundsBn, 6);
    assert(debugResult.logEntries.some((entry) => entry.text === "Day 2 started. Player +£7B."));
    assert(debugResult.logEntries.some((entry) => entry.text === "Enemy +£6B."));
  } finally {
    setDebugEnemyOwnerLogs(false);
  }
});

test("Supply Truck starts available to both sides", () => {
  const options = createDefaultStartOptions();
  assert.equal(options.Player.inventory["Supply Truck"], 1);
  assert.equal(options.Enemy.inventory["Supply Truck"], 1);

  const state = createInitialState("supply-truck-defaults", options);
  assert.equal(state.economy.inventory["Supply Truck"], 1);
  assert.equal(state.enemyEconomy.inventory["Supply Truck"], 1);
  assert.equal(state.economy.inventoryByLevel?.["Supply Truck"]?.[1], 1);
  assert.equal(state.enemyEconomy.inventoryByLevel?.["Supply Truck"]?.[1], 1);
});

test("destroying an opposing unit awards reduced gain based on destroyed unit value and level", () => {
  let state = createScenario(4);
  for (let index = 0; index < 50; index += 1) {
    const candidate = createScenario(4);
    candidate.seed = `gain-kill-${index}`;
    candidate.units = [];
    const attacker = addUnit(candidate, "Player", "Tank", { q: 5, r: 35 });
    const target = addUnit(candidate, "Enemy", "Infantry", { q: 5, r: 34 }, 1);
    target.level = 2;
    if (!calculateAttackResult(candidate, attacker, target).missed) {
      state = candidate;
      break;
    }
  }

  const result = createGameEngine(updateFog(state)).dispatch({ type: "ATTACK_HEX", unitId: state.units[0].id, at: state.units[1].coord }).state;

  assert.equal(result.economy.gainPoints, getDestroyedUnitGainReward("Infantry", 2));
  assert.equal(result.units.some((unit) => unit.owner === "Enemy" && unit.type === "Infantry"), false);
});

test("gain can instantly produce unit material without spending funds", () => {
  const state = createScenario(4);
  state.economy.moneyPoundsBn = 0;
  state.economy.gainPoints = getProductionGainCost("Tank");
  state.economy.inventory.Tank = 0;
  state.economy.inventoryByLevel!.Tank = {};

  const result = createGameEngine(state).dispatch({ type: "INSTANT_PRODUCTION", unitType: "Tank" }).state;

  assert.equal(result.economy.moneyPoundsBn, 0);
  assert.equal(result.economy.gainPoints, 0);
  assert.equal(result.economy.inventory.Tank, 1);
});

test("gain can instantly complete research without spending funds", () => {
  const state = createScenario(4);
  state.economy.moneyPoundsBn = 0;
  state.economy.gainPoints = getResearchGainCost("Efficiency", undefined, state.economy, state.economy.efficiencyLevel);

  const result = createGameEngine(state).dispatch({ type: "INSTANT_RESEARCH", researchType: "Efficiency" }).state;

  assert.equal(result.economy.moneyPoundsBn, 0);
  assert.equal(result.economy.gainPoints, 0);
  assert.equal(result.economy.efficiencyLevel, 2);
});

test("gain cannot instantly produce player faction elite units", () => {
  const cases: { faction: Faction; unitType: UnitType; building: BuildingType }[] = [
    { faction: "Empire", unitType: "Spectral", building: "The Room" },
    { faction: "Alliance", unitType: "Reaper", building: "Drone Factory" }
  ];

  for (const { faction, unitType, building } of cases) {
    const state = createPlayerFactionScenario(faction, [building]);
    state.economy.moneyPoundsBn = 0;
    state.economy.gainPoints = getProductionGainCost(unitType, state.economy.unitLevels[unitType]);
    state.economy.inventory[unitType] = 0;
    state.economy.inventoryByLevel![unitType] = {};

    const result = createGameEngine(state).dispatch({ type: "INSTANT_PRODUCTION", unitType }).state;

    assert.equal(result.economy.gainPoints, state.economy.gainPoints);
    assert.equal(result.economy.inventory[unitType], 0);
    assert.equal(result.economy.inventoryByLevel?.[unitType]?.[state.economy.unitLevels[unitType]] ?? 0, 0);
  }
});

test("gain cannot instantly research player faction elite facilities", () => {
  const cases: { faction: Faction; researchType: ResearchType; building: BuildingType }[] = [
    { faction: "Empire", researchType: "UnlockRoom", building: "The Room" },
    { faction: "Alliance", researchType: "UnlockDroneFactory", building: "Drone Factory" }
  ];

  for (const { faction, researchType, building } of cases) {
    const state = createPlayerFactionScenario(faction, ["Special Services"]);
    state.economy.moneyPoundsBn = 0;
    state.economy.gainPoints = getResearchGainCost(researchType, undefined, state.economy);

    const result = createGameEngine(state).dispatch({ type: "INSTANT_RESEARCH", researchType }).state;

    assert.equal(result.economy.gainPoints, state.economy.gainPoints);
    assert.equal(result.buildings.some((candidate) => candidate.owner === "Player" && candidate.type === building), false);
  }
});

test("gain finish cost scales to remaining production time", () => {
  const state = createScenario(4);
  state.economy.moneyPoundsBn = 100;
  const queued = createGameEngine(state).dispatch({ type: "START_PRODUCTION", unitType: "Tank" }).state;
  const job = queued.economy.productionQueue[0];
  queued.day = job.startedDay + 1;
  const finishCost = getProductionFinishGainCost(job, queued.day);
  queued.economy.gainPoints = finishCost;

  const result = createGameEngine(queued).dispatch({ type: "FINISH_PRODUCTION", jobId: job.id }).state;

  assert.equal(finishCost, Math.ceil(getProductionGainCost("Tank") * 2 / 3));
  assert.equal(result.economy.gainPoints, 0);
  assert.equal(result.economy.productionQueue.length, 0);
  assert.equal(result.economy.inventory.Tank, queued.economy.inventory.Tank + 1);
});

test("gain cannot complete started player faction elite production", () => {
  const cases: { faction: Faction; unitType: UnitType; building: BuildingType }[] = [
    { faction: "Empire", unitType: "Spectral", building: "The Room" },
    { faction: "Alliance", unitType: "Reaper", building: "Drone Factory" }
  ];

  for (const { faction, unitType, building } of cases) {
    const state = createPlayerFactionScenario(faction, [building]);
    const queued = createGameEngine(state).dispatch({ type: "START_PRODUCTION", unitType }).state;
    const job = queued.economy.productionQueue[0];
    queued.economy.gainPoints = getProductionFinishGainCost(job, queued.day);

    const result = createGameEngine(queued).dispatch({ type: "FINISH_PRODUCTION", jobId: job.id }).state;

    assert.equal(result.economy.gainPoints, queued.economy.gainPoints);
    assert.equal(result.economy.productionQueue.some((candidate) => candidate.id === job.id), true);
    assert.equal(result.economy.inventory[unitType], queued.economy.inventory[unitType]);
  }
});

test("gain cannot complete started player faction elite facility research", () => {
  const cases: { faction: Faction; researchType: ResearchType; building: BuildingType }[] = [
    { faction: "Empire", researchType: "UnlockRoom", building: "The Room" },
    { faction: "Alliance", researchType: "UnlockDroneFactory", building: "Drone Factory" }
  ];

  for (const { faction, researchType, building } of cases) {
    const state = createPlayerFactionScenario(faction, ["Special Services"]);
    const queued = createGameEngine(state).dispatch({ type: "START_RESEARCH", researchType }).state;
    const job = queued.economy.researchQueue[0];
    queued.economy.gainPoints = getResearchFinishGainCost(job, queued.economy, queued.day);

    const result = createGameEngine(queued).dispatch({ type: "FINISH_RESEARCH", jobId: job.id }).state;

    assert.equal(result.economy.gainPoints, queued.economy.gainPoints);
    assert.equal(result.economy.researchQueue.some((candidate) => candidate.id === job.id), true);
    assert.equal(result.buildings.some((candidate) => candidate.owner === "Player" && candidate.type === building), false);
  }
});

test("enemy AI uses gain-only resources for its chosen production", () => {
  const state = createScenario(10, 0);
  clearEnemyInventory(state);
  state.enemyEconomy.gainPoints = getProductionGainCost("Tank", state.enemyEconomy.unitLevels.Tank);
  state.units = [];
  const threat = addUnit(state, "Player", "Infantry", { q: state.bases.Enemy.q, r: state.bases.Enemy.r + 1 });
  rememberForEnemy(state, threat);

  const result = createGameEngine(updateFog(state)).dispatch({ type: "END_TURN" }).state;
  const producedInventory = UNIT_DEFINITIONS.reduce((total, unit) => total + result.enemyEconomy.inventory[unit.type], 0);

  assert(result.enemyEconomy.gainPoints < getProductionGainCost("Tank", state.enemyEconomy.unitLevels.Tank));
  assert(producedInventory > 0);
});

test("enemy AI uses gain-only resources for its chosen research", () => {
  const state = createScenario(8, 0);
  clearEnemyInventory(state);
  state.enemyEconomy.productionQueue = [{
    id: "gain-ai-production-blocker",
    owner: "Enemy",
    unitType: "Tank",
    unitLevel: 1,
    startedDay: state.day,
    availableDay: state.day + 10
  }];
  state.enemyEconomy.gainPoints = getResearchGainCost("Efficiency", undefined, state.enemyEconomy, state.enemyEconomy.efficiencyLevel);

  const result = createGameEngine(updateFog(state)).dispatch({ type: "END_TURN" }).state;

  assert.equal(result.enemyEconomy.efficiencyLevel, 2);
  assert.equal(result.enemyEconomy.gainPoints, 0);
});

test("enemy AI uses gain to finish queued production when it can", () => {
  const state = createScenario(8, 0);
  clearEnemyInventory(state);
  state.enemyEconomy.productionQueue = [{
    id: "gain-ai-finish-production",
    owner: "Enemy",
    unitType: "Tank",
    unitLevel: 1,
    startedDay: state.day,
    availableDay: state.day + 3
  }];
  state.enemyEconomy.gainPoints = getProductionGainCost("Tank", 1);

  const result = createGameEngine(updateFog(state)).dispatch({ type: "END_TURN" }).state;

  assert.equal(result.enemyEconomy.productionQueue.some((job) => job.id === "gain-ai-finish-production"), false);
  assert.equal(result.enemyEconomy.inventory.Tank, 1);
  assert.equal(result.enemyEconomy.gainPoints, 0);
});

test("Supply Truck is first in Tank Factory ordering and costs eleven billion", () => {
  const supplyTruck = UNIT_DEFINITIONS.find((unit) => unit.type === "Supply Truck");
  const tankFactory = BUILDING_DEFINITIONS.find((building) => building.type === "Tank Factory");

  assert.equal(supplyTruck?.costPoundsBn, 11);
  assert.equal(tankFactory?.produces[0], "Supply Truck");
});

test("Command Heli is second in Airfield ordering and costs sixteen billion", () => {
  const attackHelicopter = UNIT_DEFINITIONS.find((unit) => unit.type === "Attack Heli");
  const commandHelicopter = UNIT_DEFINITIONS.find((unit) => unit.type === "Command Heli");
  const airfield = BUILDING_DEFINITIONS.find((building) => building.type === "Airfield");

  assert.equal(attackHelicopter?.label, "AKH");
  assert.equal(commandHelicopter?.label, "CMH");
  assert.equal(commandHelicopter?.costPoundsBn, 16);
  assert.deepEqual(airfield?.produces.slice(0, 2), ["Attack Heli", "Command Heli"]);
});

test("Supply Truck cannot attack", () => {
  const state = createScenario(3);
  state.units = [];
  const supply = addUnit(state, "Player", "Supply Truck", { q: 10, r: 30 });

  assert.equal(canUnitAttackThisDay(state, supply), false);
  assert.equal(canUnitTargetUnit("Supply Truck", "Infantry"), false);
  assert.equal(getEffectiveUnitStats(state, "Player", "Supply Truck", 1, supply.coord).attackRange, 0);
  assert.equal(getBaseAttackDamage("Supply Truck"), 0);
});

test("Command Heli cannot attack", () => {
  const state = createScenario(3);
  state.units = [];
  const command = addUnit(state, "Player", "Command Heli", { q: 10, r: 30 });

  assert.equal(canUnitAttackThisDay(state, command), false);
  assert.equal(canUnitTargetUnit("Command Heli", "Infantry"), false);
  assert.equal(getEffectiveUnitStats(state, "Player", "Command Heli", 1, command.coord).attackRange, 0);
  assert.equal(getBaseAttackDamage("Command Heli"), 0);
});

test("Supply Truck creates adjacent placement tiles", () => {
  const state = createScenario(3);
  state.units = [];
  addUnit(state, "Player", "Supply Truck", { q: 10, r: 30 });

  assert.equal(canPlaceUnitAt(state, "Player", "Infantry", { q: 11, r: 30 }), true);
  assert.equal(canPlaceUnitAt(state, "Player", "Attack Heli", { q: 11, r: 30 }), false);
  assert.equal(canPlaceUnitAt(state, "Player", "Infantry", { q: 12, r: 30 }), false);
});

test("Command Heli creates adjacent ground placement tiles", () => {
  const state = createScenario(3);
  state.units = [];
  const command = addUnit(state, "Player", "Command Heli", { q: 10, r: 30 });

  assert.equal(canSupplyTruckEnablePlacement(state, command), true);
  assert.equal(canPlaceUnitAt(state, "Player", "Infantry", { q: 11, r: 30 }), true);
  assert.equal(canPlaceUnitAt(state, "Player", "Attack Heli", { q: 11, r: 30 }), false);
  assert.equal(canPlaceUnitAt(state, "Player", "Infantry", { q: 12, r: 30 }), false);
});

test("opposing supply providers do not create player placement tiles", () => {
  for (const providerType of ["Supply Truck", "Command Heli"] as const) {
    const state = createScenario(3);
    state.units = [];
    addUnit(state, "Enemy", providerType, { q: 10, r: 30 });

    assert.equal(canPlaceUnitAt(state, "Player", "Infantry", { q: 11, r: 30 }), false);
  }
});

test("newly placed Supply Truck does not create same-day placement tiles", () => {
  const state = createScenario(3);
  state.units = [];
  const supply = addUnit(state, "Player", "Supply Truck", { q: 10, r: 30 });
  supply.placedDay = state.day;

  assert.equal(canPlaceUnitAt(state, "Player", "Infantry", { q: 11, r: 30 }), false);
});

test("moved Supply Truck does not create same-day placement tiles", () => {
  const state = createScenario(3);
  state.units = [];
  const supply = addUnit(state, "Player", "Supply Truck", { q: 10, r: 30 });
  supply.movementSpentThisDay = 1;
  supply.hasMovedThisDay = false;

  assert.equal(canPlaceUnitAt(state, "Player", "Infantry", { q: 11, r: 30 }), false);
  assert.equal(canSupplyTruckEnablePlacement(state, supply), false);
});

test("Supply Truck that anchors placement cannot move until next day", () => {
  const state = createScenario(3);
  state.units = [];
  const supply = addUnit(state, "Player", "Supply Truck", { q: 10, r: 30 });
  const destination = { q: 11, r: 30 };

  assert.equal(canSupplyTruckEnablePlacement(state, supply), true);
  placeUnit(state, "Player", "Infantry", destination, "preserve");

  assert.equal(supply.hasProvidedPlacementThisDay, true);
  assert.equal(canMoveUnitTo(state, supply, { q: 10, r: 29 }), false);
});

test("Supply Truck placement does not project into the opposing Area", () => {
  const state = createScenario(3);
  state.units = [];
  addUnit(state, "Player", "Supply Truck", { q: 14, r: 0 });

  assert.equal(canPlaceUnitAt(state, "Player", "Infantry", { q: 15, r: 0 }), false);
});

test("Tank base movement is increased by one at every level", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((level) => getBaseEffectiveUnitStats("Tank", level).moveRange),
    [4, 6, 7, 8, 9]
  );
});

test("Supply Truck movement is reduced by two at every level", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((level) => getBaseEffectiveUnitStats("Supply Truck", level).moveRange),
    [5, 6, 7, 8, 10]
  );
});

test("Command Heli moves two less than Attack Heli at every level", () => {
  for (const level of [1, 2, 3]) {
    assert.equal(
      getBaseEffectiveUnitStats("Command Heli", level).moveRange,
      getBaseEffectiveUnitStats("Attack Heli", level).moveRange - 2
    );
  }
});

test("Artillery and Anti-Air gain two effective attack range at every level", () => {
  const expectedRanges = [9, 11, 14];

  assert.deepEqual(
    [1, 2, 3].map((level) => getBaseEffectiveUnitStats("Artillery", level).attackRange),
    expectedRanges
  );
  assert.deepEqual(
    [1, 2, 3].map((level) => getBaseEffectiveUnitStats("Anti-Air", level).attackRange),
    expectedRanges
  );
});

test("Anti-Air health matches Artillery health at every level", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((level) => getBaseEffectiveUnitStats("Anti-Air", level).health),
    [1, 2, 3, 4, 5].map((level) => getBaseEffectiveUnitStats("Artillery", level).health)
  );
});

test("Supply Truck repairs friendly units within two tiles", () => {
  const state = createScenario(3);
  state.units = [];
  addUnit(state, "Player", "Supply Truck", { q: 10, r: 30 });
  const nearby = addUnit(state, "Player", "IFV", { q: 12, r: 30 }, 10);
  const nearbyAir = addUnit(state, "Player", "Attack Heli", { q: 11, r: 30 }, 10);
  const distant = addUnit(state, "Player", "Tank", { q: 13, r: 30 }, 10);

  repairBackRowUnits(state);

  assert.equal(nearby.health, 14);
  assert.equal(nearbyAir.health, 10);
  assert.equal(distant.health, 10);
});

test("Command Heli repairs friendly ground units within two tiles", () => {
  const state = createScenario(3);
  state.units = [];
  addUnit(state, "Player", "Command Heli", { q: 10, r: 30 });
  const nearby = addUnit(state, "Player", "IFV", { q: 12, r: 30 }, 10);
  const nearbyAir = addUnit(state, "Player", "Attack Heli", { q: 11, r: 30 }, 10);
  const distant = addUnit(state, "Player", "Tank", { q: 13, r: 30 }, 10);

  repairBackRowUnits(state);

  assert.equal(nearby.health, 14);
  assert.equal(nearbyAir.health, 10);
  assert.equal(distant.health, 10);
});

test("Command Heli produces level-scaled daily gain", () => {
  const state = createScenario(3);
  state.units = [];
  state.economy.gainPoints = 0;
  state.enemyEconomy.moneyPoundsBn = 0;
  state.enemyEconomy.incomePoundsBn = 0;
  const command = addUnit(state, "Player", "Command Heli", { q: 10, r: state.map.height - 1 });
  command.level = 3;

  const result = createGameEngine(state).dispatch({ type: "END_TURN" }).state;

  assert.equal(getUnitDailyGainValue("Command Heli", 1), 2);
  assert.equal(getUnitDailyGainValue("Command Heli", 3), 6);
  assert.equal(result.economy.gainPoints, 6);
});

test("damaged Supply Truck repairs in proportion to its health", () => {
  const state = createScenario(3);
  state.units = [];
  addUnit(state, "Player", "Supply Truck", { q: 10, r: 30 }, 10);
  const nearby = addUnit(state, "Player", "IFV", { q: 12, r: 30 }, 10);

  repairBackRowUnits(state);

  assert.equal(nearby.health, 12);
});

test("Supply Truck does not repair itself away from back row", () => {
  const state = createScenario(3);
  state.units = [];
  const unsupported = addUnit(state, "Player", "Supply Truck", { q: 10, r: 30 }, 10);
  const supported = addUnit(state, "Player", "Supply Truck", { q: 13, r: 30 }, 10);
  addUnit(state, "Player", "Supply Truck", { q: 15, r: 30 });
  const backRow = addUnit(state, "Player", "Supply Truck", { q: 10, r: state.map.height - 1 }, 10);

  repairBackRowUnits(state);

  assert.equal(unsupported.health, 10);
  assert.equal(supported.health, 14);
  assert.equal(backRow.health, 14);
});

test("enemy damaged ground units can retreat to a Command Heli repair aura", () => {
  const state = createScenario(12);
  clearEnemyInventory(state);
  state.units = [];
  const command = addUnit(state, "Enemy", "Command Heli", { q: state.bases.Enemy.q, r: 15 });
  command.hasMovedThisDay = true;
  command.movementSpentThisDay = 99;
  const damaged = addUnit(state, "Enemy", "Tank", { q: state.bases.Enemy.q, r: 20 }, 5);
  const beforeDistance = hexDistance(damaged.coord, command.coord);

  const next = runEnemyTurn(state);
  const moved = next.units.find((unit) => unit.id === damaged.id);
  const support = next.units.find((unit) => unit.id === command.id);

  assert(moved && support, "repair scenario units should survive the enemy turn");
  assert(hexDistance(moved.coord, support.coord) <= 2, `damaged Tank should enter Command Heli repair range, got distance ${hexDistance(moved.coord, support.coord)}`);
  assert(hexDistance(moved.coord, support.coord) < beforeDistance, "damaged Tank should move closer to the Command Heli");
});

test("enemy Command Heli can drop a capture unit directly on a gate", () => {
  const state = createScenario(12);
  clearEnemyInventory(state);
  state.units = [];
  const gate = state.gates.find((candidate) => candidate.id === "West");
  assert(gate, "West Gate fixture should exist");
  gate.owner = "Player";
  gate.knownOwner = "Player";
  gate.occupation.Player = 0;
  gate.occupation.Enemy = 0;
  addEnemyInventory(state, "Infantry");
  const commandCoord = getNeighborCoords(state.map, gate.coord)
    .filter((coord) => coord.r <= gate.coord.r)
    .sort((first, second) => hexDistance(first, state.bases.Enemy) - hexDistance(second, state.bases.Enemy))[0];
  assert(commandCoord, "gate should have an enemy-side neighbor for the Command Heli");
  const command = addUnit(state, "Enemy", "Command Heli", commandCoord);

  assert.equal(canSupplyTruckEnablePlacement(state, command), true);
  assert.equal(canPlaceUnitAt(state, "Enemy", "Infantry", gate.coord), true);

  const next = runEnemyTurn(state);
  const dropped = next.units.find((unit) => unit.owner === "Enemy" && unit.type === "Infantry" && sameHex(unit.coord, gate.coord));

  assert(dropped, "AI should use the Command Heli to place Infantry directly on the contested Gate");
});

test(
  "bundled runAssuranceAiTests suite passes under the TypeScript runner",
  { skip: process.env.ASSURANCE_RUN_BUNDLED_AI_TESTS !== "1" ? "Set ASSURANCE_RUN_BUNDLED_AI_TESTS=1 to run the bundled AI diagnostics." : false },
  () => {
    const results = runAssuranceAiTests();
    const failed = results.filter((result) => !result.passed);
    assert.equal(failed.length, 0, `bundled AI diagnostic suite should pass; failed: ${failed.map((result) => result.name).join(", ")}`);
    assert(results.length > 0, "bundled AI diagnostic suite should return test results");
  }
);

test("campaign sequence: opening Gate race commits Infantry into both lanes", () => {
  const state = createScenario(1, 0);
  const placed = runEnemyTurn(state);
  const next = runEnemyTurns(placed, 4);
  const center = next.bases.Enemy.q;
  const infantry = next.units.filter((unit) => unit.owner === "Enemy" && unit.type === "Infantry");
  const westLane = infantry.filter((unit) => unit.coord.q <= center);
  const eastLane = infantry.filter((unit) => unit.coord.q > center);
  const gatePressure = infantry.filter((unit) => Math.min(...next.gates.map((gate) => hexDistance(unit.coord, gate.coord))) <= 7);
  const progressed = infantry.filter((unit) => {
    const original = placed.units.find((candidate) => candidate.id === unit.id);
    if (!original) {
      return false;
    }
    return Math.min(...next.gates.map((gate) => hexDistance(unit.coord, gate.coord))) < Math.min(...placed.gates.map((gate) => hexDistance(original.coord, gate.coord)));
  });

  assert(infantry.length >= 6, `opening should keep all starting Infantry committed; found ${infantry.length}`);
  assert(westLane.length >= 2 && eastLane.length >= 2, `opening should form west/east lane pressure; west ${westLane.length}, east ${eastLane.length}`);
  assert(progressed.length >= 6, `opening should move all starting Infantry closer to Gates; progressed ${progressed.length}`);
  assert(gatePressure.length >= 4 || next.gates.some((gate) => gate.occupation.Enemy > 0 || gate.owner === "Enemy"), "opening sequence should create concrete Gate pressure");
});

test("campaign sequence: one Gate lost recovery moves a capturer toward the lost Gate", () => {
  const state = createScenario(12, 0);
  clearEnemyInventory(state);
  state.units = [];
  const westGate = state.gates.find((gate) => gate.id === "West");
  const eastGate = state.gates.find((gate) => gate.id === "East");
  assert(westGate && eastGate);
  westGate.owner = "Player";
  westGate.knownOwner = "Player";
  eastGate.owner = "Enemy";
  eastGate.knownOwner = "Enemy";
  const capturer = addUnit(state, "Enemy", "Ghost", { q: westGate.coord.q + 4, r: westGate.coord.r - 7 });
  addUnit(state, "Enemy", "Tank", { q: westGate.coord.q + 2, r: westGate.coord.r - 8 });
  const beforeDistance = hexDistance(capturer.coord, westGate.coord);

  const next = runEnemyTurns(state, 2);
  const moved = next.units.find((unit) => unit.id === capturer.id);
  assert(moved, "recovery capturer should survive");
  assert(hexDistance(moved.coord, westGate.coord) < beforeDistance, `recovery should move toward lost Gate; distance ${beforeDistance} -> ${hexDistance(moved.coord, westGate.coord)}`);
});

test("campaign sequence: both Gates owned starts base assault movement", () => {
  const state = createScenario(16, 0);
  clearEnemyInventory(state);
  state.units = [];
  for (const gate of state.gates) {
    gate.owner = "Enemy";
    gate.knownOwner = "Enemy";
  }
  const capturer = addUnit(state, "Enemy", "Ghost", { q: state.bases.Player.q - 5, r: state.bases.Player.r - 12 });
  addUnit(state, "Enemy", "Tank", { q: capturer.coord.q - 1, r: capturer.coord.r });
  const beforeDistance = hexDistance(capturer.coord, state.bases.Player);

  const next = runEnemyTurns(state, 2);
  const moved = next.units.find((unit) => unit.id === capturer.id);
  assert(moved, "base assault capturer should survive");
  assert(hexDistance(moved.coord, next.bases.Player) < beforeDistance, `base assault should close on player base; distance ${beforeDistance} -> ${hexDistance(moved.coord, next.bases.Player)}`);
});

test("campaign sequence: BaseHold protects the occupying capturer", () => {
  const state = createScenario(20, 0);
  clearEnemyInventory(state);
  state.units = [];
  for (const gate of state.gates) {
    gate.owner = "Enemy";
    gate.knownOwner = "Enemy";
  }
  state.baseOccupation.Player = 1;
  const capturer = addUnit(state, "Enemy", "Ghost", state.bases.Player);
  const escort = addUnit(state, "Enemy", "Tank", { q: state.bases.Player.q - 2, r: state.bases.Player.r - 3 });
  const threat = addUnit(state, "Player", "Infantry", { q: state.bases.Player.q + 1, r: state.bases.Player.r - 2 });
  rememberForEnemy(state, threat);

  const next = runEnemyTurn(state);
  const holdingCapturer = next.units.find((unit) => unit.id === capturer.id);
  const movedEscort = next.units.find((unit) => unit.id === escort.id);
  const remainingThreat = next.units.find((unit) => unit.id === threat.id);

  assert(holdingCapturer && sameHex(holdingCapturer.coord, next.bases.Player), "base hold capturer should keep occupying the player base");
  assert(
    !remainingThreat || remainingThreat.health < threat.health || (movedEscort && hexDistance(movedEscort.coord, next.bases.Player) < hexDistance(escort.coord, state.bases.Player)),
    "base hold should damage the next-turn threat or move protection closer"
  );
});

test("campaign sequence: Anti-Air denial keeps fallback air movement out of range", () => {
  const state = createScenario(18, 0);
  clearEnemyInventory(state);
  state.units = [];
  const antiAir = addUnit(state, "Player", "Anti-Air", { q: state.bases.Player.q, r: state.bases.Player.r - 11 });
  const helicopter = addUnit(state, "Enemy", "Attack Heli", { q: antiAir.coord.q, r: antiAir.coord.r - 8 });
  rememberForEnemy(state, antiAir);

  const next = runEnemyTurn(state);
  const moved = next.units.find((unit) => unit.id === helicopter.id);
  const knownAntiAir = next.units.find((unit) => unit.id === antiAir.id);
  assert(moved, "air unit should survive fallback movement");
  assert(knownAntiAir, "Anti-Air fixture should remain available after fallback");
  assert(!isInEffectiveAttackRange(next, knownAntiAir, moved.coord), `air fallback should end outside effective Anti-Air range; distance ${hexDistance(moved.coord, knownAntiAir.coord)}`);
});

test("campaign sequence: losing both Gates pulls overextended units back from the front line", () => {
  const state = createScenario(20, 0, ["Special Services"]);
  clearEnemyInventory(state);
  state.units = [];
  for (const gate of state.gates) {
    gate.owner = "Player";
    gate.knownOwner = "Player";
  }
  const stranded = addUnit(state, "Enemy", "Ghost", { q: state.bases.Player.q, r: state.bases.Player.r - 3 });
  const beforeRow = stranded.coord.r;

  const next = runEnemyTurn(state);
  const moved = next.units.find((unit) => unit.id === stranded.id);
  assert(moved, "overextended unit should survive its pullback turn");
  assert(moved.coord.r < beforeRow, `overextended unit should retreat toward enemy territory after both Gates are lost; row ${beforeRow} -> ${moved.coord.r}`);
});
