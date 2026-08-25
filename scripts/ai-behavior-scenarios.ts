import assert from "node:assert/strict";

import { UNIT_DEFINITIONS } from "../src/renderer/data/unitDefs";
import { createGameEngine } from "../src/renderer/game/engine";
import { createEmptyUnitLevelInventory, getFieldUnitUpgradeCost, getFieldUnitUpgradeGainCost, getResearchCost } from "../src/renderer/game/economy";
import { getBaseAttackDamage, getEffectiveUnitStats } from "../src/renderer/game/unitStats";
import { getFrontLineRows, getReachableHexIdsWithVisibility } from "../src/renderer/game/units";
import { updateFog } from "../src/renderer/game/fog";
import { hexDistance, hexId } from "../src/renderer/game/map";
import { createDefaultStartOptions, createInitialState } from "../src/renderer/game/state";
import type { BuildingType, Difficulty, GameState, ResearchJob, UnitInstance, UnitType } from "../src/renderer/game/types";

const DIFFICULTIES: Difficulty[] = ["Easy", "Medium", "Hard"];

function createScenario(day: number, money: number, unlockedBuildings: BuildingType[] = [], difficulty: Difficulty = "Hard"): GameState {
  const options = createDefaultStartOptions();
  options.difficulty = difficulty;
  options.Enemy.moneyPoundsBn = money;
  options.Enemy.unlockedBuildings = unlockedBuildings;
  const state = createInitialState(`ai-check-${difficulty}-${day}-${money}`, options);
  state.started = true;
  state.paused = false;
  state.day = day;
  return state;
}

function addUnit(state: GameState, owner: "Player" | "Enemy", type: UnitType, q: number, r: number): UnitInstance {
  const stats = getEffectiveUnitStats(state, owner, type);
  const unit: UnitInstance = {
    id: `check-unit-${state.nextId}`,
    owner,
    type,
    level: owner === "Player" ? state.economy.unitLevels[type] : state.enemyEconomy.unitLevels[type],
    coord: { q, r },
    health: stats.health,
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

function clearEnemyUnitCommitments(state: GameState): void {
  state.units = state.units.filter((unit) => unit.owner !== "Enemy");
  state.enemyEconomy.productionQueue = [];
  state.enemyEconomy.inventoryByLevel ??= {} as NonNullable<GameState["enemyEconomy"]["inventoryByLevel"]>;
  for (const unit of UNIT_DEFINITIONS) {
    state.enemyEconomy.inventory[unit.type] = 0;
    state.enemyEconomy.inventoryByLevel[unit.type] = {};
  }
}

function freezeEnemyProduction(state: GameState): void {
  state.enemyEconomy.moneyPoundsBn = 0;
  state.enemyEconomy.incomePoundsBn = 0;
  state.enemyEconomy.productionQueue = [];
  state.enemyEconomy.inventoryByLevel ??= createEmptyUnitLevelInventory();
  for (const unit of UNIT_DEFINITIONS) {
    state.enemyEconomy.inventory[unit.type] = 0;
    state.enemyEconomy.inventoryByLevel[unit.type] = {};
  }
}

function enemyHasBuilding(state: GameState, type: BuildingType): boolean {
  return state.buildings.some((building) => building.owner === "Enemy" && building.type === type);
}

function fillEnemyResearchQueue(state: GameState): void {
  for (let index = state.enemyEconomy.researchQueue.length; index < 10; index += 1) {
    state.enemyEconomy.researchQueue.push({
      id: `check-research-${state.nextId}`,
      owner: "Enemy",
      type: "Efficiency",
      targetLevel: state.enemyEconomy.efficiencyLevel + index + 1,
      startedDay: state.day,
      completeDay: state.day + 40 + index
    } satisfies ResearchJob);
    state.nextId += 1;
  }
}

function rememberPlayerUnitForEnemy(state: GameState, unit: UnitInstance): void {
  state.spottedUnits.Enemy[unit.id] = {
    id: unit.id,
    owner: unit.owner,
    type: unit.type,
    coord: { ...unit.coord },
    health: unit.health,
    maxHealth: unit.maxHealth,
    spottedDay: state.day
  };
}

function runEnemyTurn(state: GameState): GameState {
  const engine = createGameEngine(updateFog(state));
  return engine.dispatch({ type: "END_TURN" }).state;
}

function producedUnits(state: GameState): UnitType[] {
  return state.enemyEconomy.productionQueue.map((job) => job.unitType);
}

function assertProducedAny(state: GameState, expected: UnitType[], scenario: string): void {
  const produced = producedUnits(state);
  assert(
    produced.some((unitType) => expected.includes(unitType)),
    `${scenario}: expected one of ${expected.join(", ")}; produced ${produced.join(", ") || "nothing"}`
  );
}

function checkArtilleryDamageReduced(): void {
  assert.equal(getBaseAttackDamage("Artillery", 1), 5, "Artillery level 1 damage should be reduced by 40%");
  assert.equal(getBaseAttackDamage("Artillery", 5), 17, "Artillery level 5 damage should be reduced by 40%");
  assert.equal(getBaseAttackDamage("Anti-Air", 1), getBaseAttackDamage("Artillery", 1), "Anti-Air level 1 damage should match Artillery");
  assert.equal(getBaseAttackDamage("Anti-Air", 5), getBaseAttackDamage("Artillery", 5), "Anti-Air level 5 damage should match Artillery");
}

function checkRegularProductionTimesReduced(): void {
  const days = Object.fromEntries(UNIT_DEFINITIONS.map((unit) => [unit.type, unit.productionDays])) as Record<UnitType, number>;
  assert.equal(days.Infantry, 1, "Infantry should remain at the minimum 1 day production time");
  assert.equal(days["Anti-Air"], 2, "Anti-Air should remain 2 days rather than becoming an instant 1 day counter");
  assert.equal(days.IFV, 2, "IFV should remain 2 days rather than becoming a 1 day regular unit");
  assert.equal(days.Artillery, 2, "Artillery production should be reduced from 3 to 2 days");
  assert.equal(days.Tank, 3, "Tank production should be reduced from 4 to 3 days");
  assert.equal(days["Attack Heli"], 2, "Attack Heli production should be reduced from 3 to 2 days");
  assert.equal(days.Jet, 3, "Jet production should be reduced from 4 to 3 days");
  assert.equal(days.Bomber, 4, "Bomber production should be reduced from 5 to 4 days");
  assert.equal(days.Operator, 3, "Operator production should be reduced from 4 to 3 days");
  assert.equal(days.Ghost, 4, "Ghost production should be reduced from 5 to 4 days");
  assert.equal(days.Spectral, 5, "Spectral production should be reduced from 6 to 5 days");
  assert.equal(days.Reaper, 6, "Reaper production should be reduced from 7 to 6 days");
}

function checkTerritoryRangePenalties(): void {
  const state = createScenario(8, 0);
  const { enemyLineRow, playerLineRow } = getFrontLineRows(state);
  const ownCoord = { q: state.bases.Player.q, r: playerLineRow };
  const middleCoord = { q: state.bases.Player.q, r: enemyLineRow };
  const farCoord = { q: state.bases.Player.q, r: enemyLineRow - 1 };
  const own = getEffectiveUnitStats(state, "Player", "Tank", 1, ownCoord);
  const middle = getEffectiveUnitStats(state, "Player", "Tank", 1, middleCoord);
  const far = getEffectiveUnitStats(state, "Player", "Tank", 1, farCoord);
  const ownToMiddle = getEffectiveUnitStats(state, "Player", "Tank", 1, ownCoord, middleCoord);
  const ownToFar = getEffectiveUnitStats(state, "Player", "Tank", 1, ownCoord, farCoord);
  const enemyFar = getEffectiveUnitStats(state, "Enemy", "Tank", 1, { q: state.bases.Enemy.q, r: playerLineRow });

  assert.equal(middle.moveRange, own.moveRange - 1, "Player units should lose 1 movement in the middle third");
  assert.equal(middle.attackRange, own.attackRange - 1, "Player units should lose 1 attack range in the middle third");
  assert.equal(middle.visibilityRange, own.visibilityRange - 1, "Player units should lose 1 vision range in the middle third");
  assert.equal(far.moveRange, own.moveRange - 2, "Player units should lose 2 movement in the far third");
  assert.equal(far.attackRange, own.attackRange - 2, "Player units should lose 2 attack range in the far third");
  assert.equal(far.visibilityRange, own.visibilityRange - 2, "Player units should lose 2 vision range in the far third");
  assert.equal(ownToMiddle.moveRange, own.moveRange - 1, "Movement into the middle third should use the target tile penalty");
  assert.equal(ownToFar.attackRange, own.attackRange - 2, "Attacks into the far third should use the target tile penalty");
  assert.equal(ownToFar.visibilityRange, own.visibilityRange - 2, "Sight into the far third should use the target tile penalty");
  assert.equal(enemyFar.moveRange, own.moveRange - 2, "Enemy units should use the mirrored far-third penalty");

  state.units = [];
  const edgeTank = addUnit(state, "Player", "Tank", state.bases.Player.q, playerLineRow);
  const visible = new Set(state.map.hexes.map((hex) => hex.id));
  const deniedMiddleCoord = { q: edgeTank.coord.q, r: edgeTank.coord.r - own.moveRange };
  assert(
    !getReachableHexIdsWithVisibility(state, edgeTank, visible).has(hexId(deniedMiddleCoord)),
    "A unit on the edge of its own third should not reach the full origin range into a penalized third"
  );
}

function checkSpecialUnitUpgradeCostsScaleWithUnitValue(): void {
  const state = createScenario(8, 0, [], "Easy");
  const tankResearchCost = getResearchCost("UnitUpgrade", "Tank", state.economy, 1);
  const operatorResearchCost = getResearchCost("UnitUpgrade", "Operator", state.economy, 1);
  const ghostResearchCost = getResearchCost("UnitUpgrade", "Ghost", state.economy, 1);
  const reaperResearchCost = getResearchCost("UnitUpgrade", "Reaper", state.economy, 1);

  assert.equal(tankResearchCost, 7, "Normal unit upgrade costs should keep the old baseline price");
  assert(operatorResearchCost > tankResearchCost * 2, `Operator upgrades should cost more than normal upgrades; Operator ${operatorResearchCost}, Tank ${tankResearchCost}`);
  assert(ghostResearchCost > operatorResearchCost, `Ghost upgrades should cost more than Operator upgrades; Ghost ${ghostResearchCost}, Operator ${operatorResearchCost}`);
  assert(reaperResearchCost >= 27, `Reaper upgrades should remain elite-priced; Reaper ${reaperResearchCost}, Tank ${tankResearchCost}`);
  assert.equal(getFieldUnitUpgradeGainCost("Reaper", 1), reaperResearchCost, "Field upgrade and research upgrade costs should stay aligned for Reapers");
}

function checkGroundWithoutAntiAirDrawsAirPower(difficulty: Difficulty): void {
  const state = createScenario(16, 240, [], difficulty);
  fillEnemyResearchQueue(state);
  const center = state.bases.Enemy.q;
  addUnit(state, "Player", "Infantry", center - 2, 4);
  addUnit(state, "Player", "Tank", center - 1, 4);
  addUnit(state, "Player", "Artillery", center, 5);
  addUnit(state, "Player", "IFV", center + 1, 4);
  addUnit(state, "Player", "Infantry", center + 2, 5);

  assertProducedAny(runEnemyTurn(state), ["Bomber", "Attack Heli"], `${difficulty} ground-heavy player without anti-air should draw enemy air power`);
}

function checkArtilleryLineDrawsBombers(): void {
  const state = createScenario(18, 260, [], "Hard");
  fillEnemyResearchQueue(state);
  const center = state.bases.Enemy.q;
  const artillery = [
    addUnit(state, "Player", "Artillery", center - 2, 8),
    addUnit(state, "Player", "Artillery", center, 9),
    addUnit(state, "Player", "Artillery", center + 2, 8)
  ];
  for (const unit of artillery) {
    rememberPlayerUnitForEnemy(state, unit);
  }

  assertProducedAny(runEnemyTurn(state), ["Bomber"], "Hard should answer a known artillery line with bombers");
}

function checkAirHeavyPlayerDrawsAirCounters(difficulty: Difficulty): void {
  const state = createScenario(14, 220, [], difficulty);
  fillEnemyResearchQueue(state);
  const center = state.bases.Enemy.q;
  addUnit(state, "Player", "Attack Heli", center - 2, 4);
  addUnit(state, "Player", "Bomber", center - 1, 5);
  addUnit(state, "Player", "Jet", center + 1, 4);
  addUnit(state, "Player", "Bomber", center + 2, 5);

  assertProducedAny(runEnemyTurn(state), ["Anti-Air", "Jet"], `${difficulty} air-heavy player should draw enemy anti-air or jets`);
}

function checkReaperEndgamePriority(difficulty: Difficulty): void {
  const state = createScenario(30, 300, ["Special Services", "Drone Factory"], difficulty);
  fillEnemyResearchQueue(state);
  const center = state.bases.Enemy.q;
  addUnit(state, "Player", "Spectral", center - 1, 6);
  addUnit(state, "Player", "Ghost", center + 1, 6);

  assertProducedAny(runEnemyTurn(state), ["Reaper"], `${difficulty} late-game enemy with Drone Factory should produce Reapers`);
}

function checkPersistentIntelMemory(): void {
  const state = createScenario(10, 80);
  const remembered = addUnit(state, "Player", "Ghost", 9, 22);
  state.spottedUnits.Enemy[remembered.id] = {
    id: remembered.id,
    owner: "Player",
    type: "Ghost",
    coord: { q: 8, r: 21 },
    health: remembered.health,
    maxHealth: remembered.maxHealth,
    spottedDay: state.day - 3
  };

  const retained = updateFog(state);
  assert(retained.spottedUnits.Enemy[remembered.id], "enemy should retain useful last-known unit intel for several days");

  retained.day += 9;
  const expired = updateFog(retained);
  assert(!expired.spottedUnits.Enemy[remembered.id], "enemy should eventually expire stale last-known unit intel");
}

function checkEconomyAndThroughputResearch(difficulty: Difficulty): void {
  const state = createScenario(13, 220, ["Special Services", "Drone Factory"], difficulty);
  const next = runEnemyTurn(state);
  const researchTypes = new Set(next.enemyEconomy.researchQueue.map((job) => job.type));
  assert(
    ["Efficiency", "ProductionCapacity", "ResearchCapacity", "ProductionSpeed", "ResearchSpeed"].some((type) => researchTypes.has(type as ResearchJob["type"])),
    `${difficulty} enemy should invest in economy or throughput research; queued ${Array.from(researchTypes).join(", ") || "nothing"}`
  );
}

function checkHardProductionBudgetComesBeforeResearch(): void {
  const state = createScenario(12, 72, [], "Hard");
  const next = runEnemyTurn(state);
  const produced = producedUnits(next);
  assert(produced.length > 0, `Hard should start production before spending surplus on research; produced ${produced.join(", ") || "nothing"}`);
  assert(
    next.enemyEconomy.researchQueue.length <= 1 || produced.length >= 2,
    `Hard should not fill research ahead of its unit pipeline; production ${produced.join(", ") || "nothing"}, research ${next.enemyEconomy.researchQueue.map((job) => job.type).join(", ") || "nothing"}`
  );
}

function checkEmergencyBaseDefense(difficulty: Difficulty): void {
  const state = createScenario(18, 120, [], difficulty);
  fillEnemyResearchQueue(state);
  const attacker = addUnit(state, "Player", "Infantry", state.bases.Enemy.q, state.bases.Enemy.r);
  addUnit(state, "Enemy", "Tank", state.bases.Enemy.q + 1, state.bases.Enemy.r + 1);

  const next = runEnemyTurn(state);
  const survivingAttacker = next.units.find((unit) => unit.id === attacker.id);
  assert(!survivingAttacker || survivingAttacker.health < attacker.health, `${difficulty} enemy should attack a player unit occupying its base`);
}

function checkDamagedHighValueUnitRetreats(difficulty: Difficulty): void {
  const state = createScenario(20, 60, ["Special Services", "Drone Factory"], difficulty);
  const reaper = addUnit(state, "Enemy", "Reaper", state.bases.Enemy.q, 11);
  reaper.health = Math.ceil(reaper.maxHealth * 0.3);
  addUnit(state, "Player", "Jet", state.bases.Enemy.q - 1, 15);
  addUnit(state, "Player", "Anti-Air", state.bases.Enemy.q + 1, 15);

  const next = runEnemyTurn(state);
  const movedReaper = next.units.find((unit) => unit.id === reaper.id);
  assert(movedReaper, `${difficulty} damaged Reaper should survive the retreat scenario`);
  assert(movedReaper.coord.r < reaper.coord.r, `${difficulty} damaged Reaper should retreat toward repair row; moved from r${reaper.coord.r} to r${movedReaper.coord.r}`);
}

function checkCapturedGateIsDefended(difficulty: Difficulty): void {
  const state = createScenario(17, 90, [], difficulty);
  freezeEnemyProduction(state);
  const westGate = state.gates.find((gate) => gate.id === "West");
  assert(westGate, "West gate should exist");
  westGate.owner = "Enemy";
  westGate.occupation.Enemy = 2;
  const defender = addUnit(state, "Enemy", "Operator", westGate.coord.q + 3, westGate.coord.r - 4);
  addUnit(state, "Player", "Ghost", westGate.coord.q, westGate.coord.r + 6);
  state.spottedUnits.Enemy["predicted-gate-raider"] = {
    id: "predicted-gate-raider",
    owner: "Player",
    type: "Ghost",
    coord: { q: westGate.coord.q, r: westGate.coord.r + 6 },
    health: 20,
    maxHealth: 20,
    spottedDay: state.day - 1
  };

  const beforeDistance = Math.abs(defender.coord.q - westGate.coord.q) + Math.abs(defender.coord.r - westGate.coord.r);
  const next = runEnemyTurn(state);
  const movedDefender = next.units.find((unit) => unit.id === defender.id);
  assert(movedDefender, `${difficulty} gate defender should remain alive`);
  const afterDistance = Math.abs(movedDefender.coord.q - westGate.coord.q) + Math.abs(movedDefender.coord.r - westGate.coord.r);
  assert(afterDistance < beforeDistance, `${difficulty} enemy should move a human special unit toward a threatened captured gate; distance ${beforeDistance} -> ${afterDistance}`);
}

function checkReaperBudgetDiscipline(difficulty: Difficulty): void {
  const state = createScenario(27, 46, ["Special Services", "Drone Factory"], difficulty);
  fillEnemyResearchQueue(state);
  const next = runEnemyTurn(state);
  const produced = producedUnits(next);
  assert(
    produced.length === 0 || produced.includes("Reaper"),
    `${difficulty} enemy should preserve a near-Reaper war chest instead of spending on ordinary units; produced ${produced.join(", ") || "nothing"}`
  );
}

function checkBaseCaptureProgressAdvancesOncePerTurn(): void {
  const state = createScenario(12, 0, [], "Easy");
  state.units = [];
  state.enemyEconomy.incomePoundsBn = 0;
  state.enemyEconomy.moneyPoundsBn = 0;
  state.enemyEconomy.productionQueue = [];
  state.enemyEconomy.researchQueue = [];
  for (const unitType of Object.keys(state.enemyEconomy.inventory) as UnitType[]) {
    state.enemyEconomy.inventory[unitType] = 0;
  }
  state.gates.forEach((gate) => {
    gate.owner = "Player";
    gate.knownOwner = "Player";
  });
  addUnit(state, "Player", "Infantry", state.bases.Enemy.q, state.bases.Enemy.r);

  const first = runEnemyTurn(state);
  assert.equal(first.baseOccupation.Enemy, 1, `Base capture should show first quarter after one turn; got ${first.baseOccupation.Enemy}/4`);
  assert.equal(first.winner, null, "Base capture should not complete on the first occupied turn");

  const second = runEnemyTurn(first);
  assert.equal(second.baseOccupation.Enemy, 2, `Base capture should show second quarter after two turns; got ${second.baseOccupation.Enemy}/4`);
  assert.equal(second.winner, null, "Base capture should not complete on the second occupied turn");

  const third = runEnemyTurn(second);
  assert.equal(third.baseOccupation.Enemy, 3, `Base capture should show third quarter after three turns; got ${third.baseOccupation.Enemy}/4`);
  assert.equal(third.winner, null, "Base capture should not complete on the third occupied turn");

  const fourth = runEnemyTurn(third);
  assert.equal(fourth.baseOccupation.Enemy, 4, `Base capture should complete on the fourth occupied turn; got ${fourth.baseOccupation.Enemy}/4`);
  assert.equal(fourth.winner, "Player", "Player should win after holding the enemy base for four occupied turns");
}

function checkMoveAttackExclusiveUnit(unitType: "Artillery" | "Anti-Air", targetType: UnitType): void {
  const moveThenAttack = createScenario(10, 0, [], "Easy");
  moveThenAttack.units = [];
  const mover = addUnit(moveThenAttack, "Player", unitType, 10, 20);
  const firstTarget = addUnit(moveThenAttack, "Enemy", targetType, 11, 20);
  const moveThenAttackEngine = createGameEngine(updateFog(moveThenAttack));
  moveThenAttackEngine.dispatch({ type: "MOVE_UNIT", unitId: mover.id, to: { q: 10, r: 21 } });
  const afterRejectedAttack = moveThenAttackEngine.dispatch({ type: "ATTACK_HEX", unitId: mover.id, at: firstTarget.coord }).state;
  const firstTargetAfter = afterRejectedAttack.units.find((unit) => unit.id === firstTarget.id);
  assert(firstTargetAfter, `${unitType} move-then-attack target should survive`);
  assert.equal(firstTargetAfter.health, firstTarget.health, `${unitType} should not attack after moving`);

  const attackThenMove = createScenario(10, 0, [], "Easy");
  attackThenMove.units = [];
  const attacker = addUnit(attackThenMove, "Player", unitType, 10, 20);
  const secondTarget = addUnit(attackThenMove, "Enemy", targetType, 11, 20);
  const attackThenMoveEngine = createGameEngine(updateFog(attackThenMove));
  attackThenMoveEngine.dispatch({ type: "ATTACK_HEX", unitId: attacker.id, at: secondTarget.coord });
  const afterRejectedMove = attackThenMoveEngine.dispatch({ type: "MOVE_UNIT", unitId: attacker.id, to: { q: 10, r: 21 } }).state;
  const attackerAfter = afterRejectedMove.units.find((unit) => unit.id === attacker.id);
  assert(attackerAfter, `${unitType} attacker should survive`);
  assert.deepEqual(attackerAfter.coord, attacker.coord, `${unitType} should not move after attacking`);
}

function checkFieldUnitUpgradeAndProductionLevels(): void {
  const state = createScenario(8, 0, [], "Easy");
  freezeEnemyProduction(state);
  state.economy.moneyPoundsBn = 220;
  state.units = [];
  state.economy.inventory.Tank = 0;
  state.economy.inventoryByLevel ??= createEmptyUnitLevelInventory();
  state.economy.inventoryByLevel.Tank = {};
  const fieldTank = addUnit(state, "Player", "Tank", state.bases.Player.q, state.bases.Player.r - 1);

  const engine = createGameEngine(updateFog(state));
  let next = engine.dispatch({ type: "START_PRODUCTION", unitType: "Tank" }).state;
  assert.equal(next.economy.productionQueue[0]?.unitLevel, 1, "Tank production started before research should be level 1");
  engine.dispatch({ type: "START_RESEARCH", researchType: "UnitUpgrade", unitType: "Tank" });

  for (let turn = 0; turn < 4; turn += 1) {
    next = engine.dispatch({ type: "END_TURN" }).state;
  }

  const tankAfterResearch = next.units.find((unit) => unit.id === fieldTank.id);
  assert(tankAfterResearch, "Existing field Tank should survive upgrade scenario");
  assert.equal(next.economy.unitLevels.Tank, 2, "Tank future production level should advance to 2");
  assert.equal(tankAfterResearch.level, 1, "Existing field Tank should not auto-upgrade after research");
  assert.equal(next.economy.inventoryByLevel?.Tank?.[1], 1, "Production already in progress should complete as level 1");

  next = engine.dispatch({ type: "PLACE_UNIT", unitType: "Tank", at: state.bases.Player }).state;
  const placedTank = next.units.find((unit) => unit.owner === "Player" && unit.type === "Tank" && unit.id !== fieldTank.id);
  assert(placedTank, "Completed Tank production should be placeable");
  assert.equal(placedTank.level, 1, "Tank production already in progress should place as level 1");

  const fieldUpgradeCost = getFieldUnitUpgradeCost("Tank", 1);
  const moneyBeforeUpgrade = next.economy.moneyPoundsBn;
  next = engine.dispatch({ type: "UPGRADE_FIELD_UNIT", unitId: fieldTank.id }).state;
  const upgradedTank = next.units.find((unit) => unit.id === fieldTank.id);
  assert(upgradedTank, "Field Tank should remain after field upgrade");
  assert.equal(upgradedTank.level, 2, "Field upgrade should advance one deployed unit by one level");
  assert.equal(next.economy.moneyPoundsBn, moneyBeforeUpgrade - fieldUpgradeCost, "Field upgrade should cost funds by default");
}

function checkFieldUnitUpgradeCanUseGainAlternative(): void {
  const state = createScenario(8, 0, [], "Easy");
  state.units = [];
  const fieldTank = addUnit(state, "Player", "Tank", state.bases.Player.q, state.bases.Player.r - 1);
  state.economy.unitLevels.Tank = 2;
  state.economy.moneyPoundsBn = 0;
  state.economy.gainPoints = getFieldUnitUpgradeGainCost("Tank", 1);

  const result = createGameEngine(updateFog(state)).dispatch({ type: "UPGRADE_FIELD_UNIT", unitId: fieldTank.id, currency: "gain" });
  const tankAfter = result.state.units.find((unit) => unit.id === fieldTank.id);
  assert(tankAfter, "Field Tank should remain after gain field upgrade");
  assert.equal(tankAfter.level, 2, "Gain field upgrade should advance one deployed unit by one level");
  assert.equal(result.state.economy.gainPoints, 0, "Gain field upgrade should spend gain");
}

function checkFieldUnitUpgradeRequiresFundsByDefault(): void {
  const state = createScenario(8, 0, [], "Easy");
  state.units = [];
  const fieldTank = addUnit(state, "Player", "Tank", state.bases.Player.q, state.bases.Player.r - 1);
  state.economy.unitLevels.Tank = 2;
  state.economy.moneyPoundsBn = 0;
  state.economy.gainPoints = getFieldUnitUpgradeGainCost("Tank", 1);

  const result = createGameEngine(updateFog(state)).dispatch({ type: "UPGRADE_FIELD_UNIT", unitId: fieldTank.id });
  const tankAfter = result.state.units.find((unit) => unit.id === fieldTank.id);
  assert(tankAfter, "Field Tank should remain after default rejected field upgrade");
  assert.equal(tankAfter.level, 1, "Default field upgrade should not spend gain unless gain is selected");
  assert(result.logEntries.some((entry) => entry.text.includes("requires £")), "Default field upgrade should be rejected with a funds cost message");
}

function checkFieldUnitUpgradeRequiresGainWhenSelected(): void {
  const state = createScenario(8, 0, [], "Easy");
  state.units = [];
  const fieldTank = addUnit(state, "Player", "Tank", state.bases.Player.q, state.bases.Player.r - 1);
  state.economy.unitLevels.Tank = 2;
  state.economy.moneyPoundsBn = 500;
  state.economy.gainPoints = 0;

  const result = createGameEngine(updateFog(state)).dispatch({ type: "UPGRADE_FIELD_UNIT", unitId: fieldTank.id, currency: "gain" });
  const tankAfter = result.state.units.find((unit) => unit.id === fieldTank.id);
  assert(tankAfter, "Field Tank should remain after rejected field upgrade");
  assert.equal(tankAfter.level, 1, "Unaffordable field upgrade should not change unit level");
  assert(result.logEntries.some((entry) => entry.text.includes("requires") && entry.text.includes("gain")), "Unaffordable field upgrade should be rejected with a gain cost message");
}

function unitUpgradeResearchJobs(state: GameState): ResearchJob[] {
  return state.enemyEconomy.researchQueue.filter((job) => job.type === "UnitUpgrade" && job.unitType);
}

function hasEnemyUnitUpgradeUse(state: GameState, unitType: UnitType): boolean {
  return (
    state.units.some((unit) => unit.owner === "Enemy" && unit.type === unitType) ||
    state.enemyEconomy.inventory[unitType] > 0 ||
    state.enemyEconomy.productionQueue.some((job) => job.unitType === unitType)
  );
}

function checkHardUnitUpgradeResearchFollowsActualUse(): void {
  const state = createScenario(22, 1400, ["Special Services", "Drone Factory"], "Hard");
  clearEnemyUnitCommitments(state);
  const center = state.bases.Enemy.q;
  addUnit(state, "Enemy", "Tank", center - 1, 2);
  addUnit(state, "Enemy", "Tank", center + 1, 2);
  addUnit(state, "Enemy", "IFV", center, 2);
  const artillery = addUnit(state, "Player", "Artillery", center, 9);
  const tank = addUnit(state, "Player", "Tank", center + 1, 9);
  rememberPlayerUnitForEnemy(state, artillery);
  rememberPlayerUnitForEnemy(state, tank);

  const next = runEnemyTurn(state);
  const upgrades = unitUpgradeResearchJobs(next);
  assert(upgrades.length > 0, "Hard should consider unit upgrades when it has committed field units and enough money");
  for (const upgrade of upgrades) {
    assert(upgrade.unitType, "Unit upgrade research should carry a unit type");
    assert(
      hasEnemyUnitUpgradeUse(next, upgrade.unitType),
      `Hard should only research upgrades for fielded, inventoried, or producing unit lines; researched ${upgrade.unitType}`
    );
  }
}

function checkHardDoesNotResearchUnusedReaperUpgrade(): void {
  const state = createScenario(22, 1000, ["Special Services"], "Hard");
  clearEnemyUnitCommitments(state);
  const center = state.bases.Enemy.q;
  const artillery = addUnit(state, "Player", "Artillery", center, 8);
  const spectral = addUnit(state, "Player", "Spectral", center + 1, 8);
  rememberPlayerUnitForEnemy(state, artillery);
  rememberPlayerUnitForEnemy(state, spectral);

  const next = runEnemyTurn(state);
  const reaperUpgrade = unitUpgradeResearchJobs(next).find((job) => job.unitType === "Reaper");
  assert(!reaperUpgrade, "Hard should not research Reaper upgrades before it has Reapers in use or in production");
}

function checkAttackMissLogged(): void {
  const state = createScenario(11, 0, [], "Easy");
  state.seed = "miss-check-21";
  state.units = [];
  const attacker = addUnit(state, "Player", "Tank", 10, 20);
  const target = addUnit(state, "Enemy", "Infantry", 11, 20);
  const engine = createGameEngine(updateFog(state));
  const result = engine.dispatch({ type: "ATTACK_HEX", unitId: attacker.id, at: target.coord });

  assert(result.logEntries.some((entry) => entry.text.includes(" missed ")), "Expected deterministic miss seed to log a missed attack");
  const targetAfter = result.state.units.find((unit) => unit.id === target.id);
  assert(targetAfter, "Missed target should survive");
  assert.equal(targetAfter.health, target.health, "Missed attack should deal no damage");
}

function checkHardPatrolsBothFlanks(): void {
  const state = createScenario(9, 80, [], "Hard");
  fillEnemyResearchQueue(state);
  const center = state.bases.Enemy.q;
  const westScout = addUnit(state, "Enemy", "Attack Heli", center - 1, 1);
  const eastScout = addUnit(state, "Enemy", "Attack Heli", center + 1, 1);
  addUnit(state, "Enemy", "Tank", center, 1);
  addUnit(state, "Enemy", "IFV", center + 2, 1);

  const next = runEnemyTurn(state);
  const movedWest = next.units.find((unit) => unit.id === westScout.id);
  const movedEast = next.units.find((unit) => unit.id === eastScout.id);
  assert(movedWest && movedEast, "Hard flank patrol scouts should survive");
  assert(
    [movedWest.coord.q, movedEast.coord.q].some((q) => q < center) && [movedWest.coord.q, movedEast.coord.q].some((q) => q > center),
    `Hard should split scouts toward both flanks; scouts ended at q${movedWest.coord.q} and q${movedEast.coord.q}`
  );
}

function checkHardKeepsBaseSentry(): void {
  const state = createScenario(12, 120, [], "Hard");
  state.gates.forEach((gate) => {
    gate.owner = "Player";
    gate.knownOwner = "Player";
  });
  fillEnemyResearchQueue(state);
  for (const unitType of Object.keys(state.enemyEconomy.inventory) as UnitType[]) {
    state.enemyEconomy.inventory[unitType] = 0;
  }
  const center = state.bases.Enemy.q;
  addUnit(state, "Enemy", "Tank", center, 1);
  const playerCapturer = addUnit(state, "Player", "Infantry", center, 4);
  rememberPlayerUnitForEnemy(state, playerCapturer);

  const next = runEnemyTurn(runEnemyTurn(state));
  const baseSentries = next.units.filter((unit) => unit.owner === "Enemy" && hexDistance(unit.coord, next.bases.Enemy) <= 6);
  assert(baseSentries.length >= 1, `Hard should keep a base sentry near home base; found ${baseSentries.length}`);
  assert(baseSentries.length <= 3, `Hard should not default to a large base turtle without a real base threat; found ${baseSentries.length}`);
}

function checkHardProducesCaptureWhenCapturersAreDistant(): void {
  const state = createScenario(18, 160, ["Special Services"], "Hard");
  fillEnemyResearchQueue(state);
  const center = state.bases.Enemy.q;
  addUnit(state, "Enemy", "Infantry", center - 2, 26);
  addUnit(state, "Enemy", "Infantry", center - 1, 27);
  addUnit(state, "Enemy", "Infantry", center, 28);
  addUnit(state, "Enemy", "Operator", center + 1, 26);
  addUnit(state, "Enemy", "Ghost", center + 2, 27);

  assertProducedAny(runEnemyTurn(state), ["Infantry", "Operator", "Ghost"], "Hard should produce more capture units when existing capturers are far from objectives");
}

function checkHardDamagedDefenderHoldsBaseEmergency(): void {
  const state = createScenario(20, 80, ["Special Services", "Drone Factory"], "Hard");
  fillEnemyResearchQueue(state);
  const attacker = addUnit(state, "Player", "Infantry", state.bases.Enemy.q, state.bases.Enemy.r);
  const reaper = addUnit(state, "Enemy", "Reaper", state.bases.Enemy.q, 7);
  reaper.health = Math.ceil(reaper.maxHealth * 0.25);

  const next = runEnemyTurn(state);
  const survivingAttacker = next.units.find((unit) => unit.id === attacker.id);
  assert(!survivingAttacker || survivingAttacker.health < attacker.health, "Hard damaged high-value defender should fight during a base emergency instead of retreating");
}

function createWeakGateScenario(difficulty: Difficulty): { state: GameState; capturer: UnitInstance } {
  const state = createScenario(12, 100, [], difficulty);
  fillEnemyResearchQueue(state);
  freezeEnemyProduction(state);
  const westGate = state.gates.find((gate) => gate.id === "West");
  const eastGate = state.gates.find((gate) => gate.id === "East");
  assert(westGate && eastGate, "Both gates should exist");
  const capturer = addUnit(state, "Enemy", "Infantry", state.bases.Enemy.q + 4, 1);
  addUnit(state, "Enemy", "IFV", state.bases.Enemy.q + 1, 1);
  westGate.occupation.Player = 1;
  const defenders = [
    addUnit(state, "Player", "Tank", westGate.coord.q, westGate.coord.r + 1),
    addUnit(state, "Player", "Artillery", westGate.coord.q + 1, westGate.coord.r + 1),
    addUnit(state, "Player", "Infantry", westGate.coord.q - 1, westGate.coord.r + 1)
  ];
  for (const defender of defenders) {
    state.spottedUnits.Enemy[defender.id] = {
      id: defender.id,
      owner: defender.owner,
      type: defender.type,
      coord: { ...defender.coord },
      health: defender.health,
      maxHealth: defender.maxHealth,
      spottedDay: state.day
    };
  }

  return { state, capturer };
}

function getWeakGateProgress(difficulty: Difficulty): { eastProgress: number; westProgress: number; eastDistance: number; westDistance: number; before: UnitInstance["coord"]; after: UnitInstance["coord"]; west: UnitInstance["coord"]; east: UnitInstance["coord"] } {
  const { state, capturer } = createWeakGateScenario(difficulty);
  const westGate = state.gates.find((gate) => gate.id === "West");
  const eastGate = state.gates.find((gate) => gate.id === "East");
  assert(westGate && eastGate, "Both gates should exist");

  const beforeEastDistance = hexDistance(capturer.coord, eastGate.coord);
  const beforeWestDistance = hexDistance(capturer.coord, westGate.coord);
  let next = state;
  next = runEnemyTurn(next);
  const movedCapturer = next.units.find((unit) => unit.id === capturer.id);
  assert(movedCapturer, `${difficulty} gate capturer should survive`);
  const eastDistance = hexDistance(movedCapturer.coord, eastGate.coord);
  const westDistance = hexDistance(movedCapturer.coord, westGate.coord);
  const eastProgress = beforeEastDistance - eastDistance;
  const westProgress = beforeWestDistance - westDistance;

  return { eastProgress, westProgress, eastDistance, westDistance, before: capturer.coord, after: movedCapturer.coord, west: westGate.coord, east: eastGate.coord };
}

function checkHardChoosesWeakGate(): void {
  const progress = getWeakGateProgress("Hard");
  const { eastProgress, westProgress } = progress;
  assert(progress.eastDistance < progress.westDistance, `Hard should prefer the weaker gate; east distance ${progress.eastDistance}, west distance ${progress.westDistance}, east progress ${eastProgress}, west progress ${westProgress}; moved ${JSON.stringify(progress.before)} -> ${JSON.stringify(progress.after)}, west ${JSON.stringify(progress.west)}, east ${JSON.stringify(progress.east)}`);
}

function createExposedBaseScenario(difficulty: Difficulty): { state: GameState; attacker: UnitInstance } {
  const state = createScenario(18, 140, ["Special Services"], difficulty);
  fillEnemyResearchQueue(state);
  const attacker = addUnit(state, "Enemy", "Ghost", state.bases.Player.q - 8, state.bases.Player.r - 10);
  addUnit(state, "Enemy", "Infantry", state.bases.Player.q - 7, state.bases.Player.r - 11);
  addUnit(state, "Enemy", "IFV", state.bases.Player.q - 9, state.bases.Player.r - 10);
  state.gates.forEach((gate) => {
    gate.owner = "Enemy";
    gate.knownOwner = "Enemy";
    gate.occupation.Enemy = 2;
    gate.occupation.Player = 0;
  });

  return { state, attacker };
}

function getExposedBaseProgress(difficulty: Difficulty): number {
  const { state, attacker } = createExposedBaseScenario(difficulty);

  const beforeDistance = hexDistance(attacker.coord, state.bases.Player);
  const next = runEnemyTurn(state);
  const movedAttacker = next.units.find((unit) => unit.id === attacker.id);
  assert(movedAttacker, `${difficulty} exposed-base attacker should survive`);
  const afterDistance = hexDistance(movedAttacker.coord, next.bases.Player);

  return beforeDistance - afterDistance;
}

function checkHardExploitsExposedPlayerBase(): void {
  const { state, attacker } = createExposedBaseScenario("Hard");

  const beforeDistance = hexDistance(attacker.coord, state.bases.Player);
  const next = runEnemyTurn(state);
  const movedAttacker = next.units.find((unit) => unit.id === attacker.id);
  assert(movedAttacker, "Hard exposed-base attacker should survive");
  const afterDistance = hexDistance(movedAttacker.coord, next.bases.Player);
  assert(afterDistance < beforeDistance, `Hard should exploit an exposed player base; distance ${beforeDistance} -> ${afterDistance}`);
}

function checkHardMovesForEarlyGateCapture(): void {
  const state = createScenario(5, 80, [], "Hard");
  fillEnemyResearchQueue(state);
  const capturer = addUnit(state, "Enemy", "Infantry", state.bases.Enemy.q, state.bases.Enemy.r + 1);
  const beforeDistance = Math.min(...state.gates.map((gate) => hexDistance(capturer.coord, gate.coord)));

  const next = runEnemyTurn(state);
  const movedCapturer = next.units.find((unit) => unit.id === capturer.id);
  assert(movedCapturer, "Hard early gate capturer should survive");
  const afterDistance = Math.min(...next.gates.map((gate) => hexDistance(movedCapturer.coord, gate.coord)));
  assert(afterDistance < beforeDistance, `Hard should move early capturers toward neutral gates; distance ${beforeDistance} -> ${afterDistance}`);
}

function checkHardOpeningScoutsAndRushersUseGateLanes(): void {
  const state = createScenario(5, 0, [], "Hard");
  fillEnemyResearchQueue(state);
  freezeEnemyProduction(state);
  state.units = state.units.filter((unit) => unit.owner !== "Enemy");
  const westGate = state.gates.find((gate) => gate.id === "West");
  const eastGate = state.gates.find((gate) => gate.id === "East");
  assert(westGate && eastGate, "Both gates should exist");

  addUnit(state, "Enemy", "Attack Heli", westGate.coord.q + 2, westGate.coord.r - 6);
  addUnit(state, "Enemy", "IFV", eastGate.coord.q - 2, eastGate.coord.r - 6);
  addUnit(state, "Enemy", "Infantry", westGate.coord.q, westGate.coord.r - 3);
  addUnit(state, "Enemy", "Infantry", westGate.coord.q + 1, westGate.coord.r - 3);
  addUnit(state, "Enemy", "Infantry", eastGate.coord.q, eastGate.coord.r - 3);

  const next = runEnemyTurn(state);
  const patrolScouts = next.units.filter((unit) => unit.owner === "Enemy" && (unit.type === "Attack Heli" || unit.type === "IFV"));
  const advancedScouts = patrolScouts.filter((unit) => unit.coord.r >= Math.floor(next.map.height / 4));
  const westScout = patrolScouts.some((unit) => hexDistance(unit.coord, westGate.coord) <= 2);
  const eastScout = patrolScouts.some((unit) => hexDistance(unit.coord, eastGate.coord) <= 2);
  assert(advancedScouts.length >= 2, `Hard opening scouts should get at least a quarter down the board quickly without moving on placement day; scouts at ${patrolScouts.map((unit) => `${unit.type}@q${unit.coord.q},r${unit.coord.r}`).join("; ") || "none"}`);
  assert(westScout && eastScout, `Hard opening scouts should scout both gates quickly; scouts at ${patrolScouts.map((unit) => `${unit.type}@q${unit.coord.q},r${unit.coord.r}`).join("; ") || "none"}`);

  const enemyThirdRow = Math.floor(next.map.height / 3);
  const gateRushers = next.units.filter(
    (unit) =>
      unit.owner === "Enemy" &&
      unit.type === "Infantry" &&
      unit.coord.r > enemyThirdRow &&
      Math.min(...next.gates.map((gate) => hexDistance(unit.coord, gate.coord))) <= 8
  );
  const contestedGates = next.gates.filter((gate) => gate.occupation.Enemy > 0 || gate.owner === "Enemy");
  assert(
    gateRushers.length >= 3,
    `Hard opening should rush multiple infantry past the enemy third toward gates; rushers ${gateRushers.map((unit) => `q${unit.coord.q},r${unit.coord.r}`).join("; ") || "none"}`
  );
  assert(contestedGates.length > 0, "Hard opening should contest at least one gate by the end of the opening rush");
}

function checkHardOpeningSameGateIfvsSpreadOut(): void {
  const state = createScenario(2, 0, [], "Hard");
  fillEnemyResearchQueue(state);
  freezeEnemyProduction(state);
  state.units = [];
  const westGate = state.gates.find((gate) => gate.id === "West");
  const eastGate = state.gates.find((gate) => gate.id === "East");
  assert(westGate && eastGate, "Both gates should exist");

  const laneQ = Math.min(state.map.width - 2, westGate.coord.q + 1);
  const ifvA = addUnit(state, "Enemy", "IFV", laneQ, state.bases.Enemy.r + 1);
  const ifvB = addUnit(state, "Enemy", "IFV", laneQ + 1, state.bases.Enemy.r + 1);
  const beforeA = hexDistance(ifvA.coord, westGate.coord);
  const beforeB = hexDistance(ifvB.coord, westGate.coord);

  const next = runEnemyTurn(state);
  const movedA = next.units.find((unit) => unit.id === ifvA.id);
  const movedB = next.units.find((unit) => unit.id === ifvB.id);
  assert(movedA && movedB, "Hard opening IFVs should survive");
  const afterA = hexDistance(movedA.coord, westGate.coord);
  const afterB = hexDistance(movedB.coord, westGate.coord);
  const pairDistance = hexDistance(movedA.coord, movedB.coord);

  assert(afterA < beforeA && afterB < beforeB, `Both IFVs should advance toward the same gate; distances ${beforeA}->${afterA} and ${beforeB}->${afterB}`);
  assert(
    pairDistance > 1,
    `Same-gate IFVs should not travel in adjacent tiles when there is room to spread; moved to q${movedA.coord.q},r${movedA.coord.r} and q${movedB.coord.q},r${movedB.coord.r}`
  );
}

function checkHardPlacesAllStartingUnitsFirstTurnInGateLanes(): void {
  const state = createScenario(1, 80, [], "Hard");
  fillEnemyResearchQueue(state);
  const startingInventory = { ...state.enemyEconomy.inventory };
  const expectedStartingUnits = Object.values(startingInventory).reduce((total, count) => total + count, 0);

  const next = runEnemyTurn(state);
  const enemyUnits = next.units.filter((unit) => unit.owner === "Enemy");
  const infantry = next.units.filter((unit) => unit.owner === "Enemy" && unit.type === "Infantry");
  const center = next.bases.Enemy.q;
  const westLane = infantry.filter((unit) => unit.coord.q <= center);
  const eastLane = infantry.filter((unit) => unit.coord.q > center);

  assert.equal(enemyUnits.length, expectedStartingUnits, `Hard should place every starting unit on its first turn; placed ${enemyUnits.length}/${expectedStartingUnits}`);
  for (const [unitType, count] of Object.entries(startingInventory) as Array<[UnitType, number]>) {
    const placed = next.units.filter((unit) => unit.owner === "Enemy" && unit.type === unitType).length;
    assert.equal(placed, count, `Hard should place all starting ${unitType} on its first turn; placed ${placed}/${count}`);
  }
  assert(Object.values(next.enemyEconomy.inventory).every((count) => count === 0), "Hard should not hold any starting inventory in reserve after first-turn placement");
  assert.equal(infantry.length, 6, `Hard should place all six starting Infantry on its first turn; placed ${infantry.map((unit) => `q${unit.coord.q},r${unit.coord.r}`).join("; ") || "none"}`);
  assert.equal(westLane.length, 3, `Hard should place three opening Infantry above the west gate lane; infantry at ${infantry.map((unit) => `q${unit.coord.q},r${unit.coord.r}`).join("; ")}`);
  assert.equal(eastLane.length, 3, `Hard should place three opening Infantry above the east gate lane; infantry at ${infantry.map((unit) => `q${unit.coord.q},r${unit.coord.r}`).join("; ")}`);
  assert(enemyUnits.every((unit) => unit.placedDay === 1), "All starting enemy units should be first-turn placements");
}

function checkHardSplitsOpeningGateCapturers(): void {
  const state = createScenario(2, 80, [], "Hard");
  fillEnemyResearchQueue(state);
  state.units = [];
  for (const unitType of Object.keys(state.enemyEconomy.inventory) as UnitType[]) {
    state.enemyEconomy.inventory[unitType] = 0;
  }
  const center = state.bases.Enemy.q;
  const westRunner = addUnit(state, "Enemy", "Infantry", center - 1, state.bases.Enemy.r + 1);
  const eastRunner = addUnit(state, "Enemy", "Infantry", center + 1, state.bases.Enemy.r + 1);

  const next = runEnemyTurn(state);
  const movedWestRunner = next.units.find((unit) => unit.id === westRunner.id);
  const movedEastRunner = next.units.find((unit) => unit.id === eastRunner.id);
  assert(movedWestRunner && movedEastRunner, "Hard opening gate runners should survive");
  assert(
    movedWestRunner.coord.q < center && movedEastRunner.coord.q > center,
    `Hard should split opening capturers toward both gates; moved to q${movedWestRunner.coord.q} and q${movedEastRunner.coord.q}`
  );
}

function checkHardOpeningFallsBackToWinningGate(): void {
  const state = createScenario(7, 80, [], "Hard");
  fillEnemyResearchQueue(state);
  state.units = [];
  const westGate = state.gates.find((gate) => gate.id === "West");
  const eastGate = state.gates.find((gate) => gate.id === "East");
  assert(westGate && eastGate, "Both gates should exist");
  westGate.occupation.Player = 2;
  eastGate.occupation.Enemy = 1;
  const center = state.bases.Enemy.q;
  const runner = addUnit(state, "Enemy", "Infantry", center - 1, state.bases.Enemy.r + 1);
  for (const defender of [
    addUnit(state, "Player", "Tank", westGate.coord.q, westGate.coord.r + 1),
    addUnit(state, "Player", "Artillery", westGate.coord.q + 1, westGate.coord.r)
  ]) {
    rememberPlayerUnitForEnemy(state, defender);
  }

  const beforeEast = hexDistance(runner.coord, eastGate.coord);
  const beforeWest = hexDistance(runner.coord, westGate.coord);
  const next = runEnemyTurn(state);
  const movedRunner = next.units.find((unit) => unit.id === runner.id);
  assert(movedRunner, "Hard fallback gate runner should survive");
  const eastProgress = beforeEast - hexDistance(movedRunner.coord, eastGate.coord);
  const westProgress = beforeWest - hexDistance(movedRunner.coord, westGate.coord);
  assert(eastProgress > westProgress, `Hard should abandon a losing opening gate for the winning gate; east progress ${eastProgress}, west progress ${westProgress}`);
}

function checkHardFightsForGateWhenLockedOut(): void {
  const state = createScenario(18, 120, ["Special Services"], "Hard");
  fillEnemyResearchQueue(state);
  for (const gate of state.gates) {
    gate.owner = "Player";
    gate.knownOwner = "Player";
    const defenders = [
      addUnit(state, "Player", "Infantry", gate.coord.q, gate.coord.r),
      addUnit(state, "Player", "Tank", gate.coord.q + 1, gate.coord.r),
      addUnit(state, "Player", "Artillery", gate.coord.q - 1, gate.coord.r),
      addUnit(state, "Player", "IFV", gate.coord.q, gate.coord.r + 1)
    ];
    for (const defender of defenders) {
      state.spottedUnits.Enemy[defender.id] = {
        id: defender.id,
        owner: defender.owner,
        type: defender.type,
        coord: { ...defender.coord },
        health: defender.health,
        maxHealth: defender.maxHealth,
        spottedDay: state.day
      };
    }
  }
  const attackers = [
    addUnit(state, "Enemy", "Infantry", state.bases.Enemy.q - 2, state.bases.Enemy.r + 1),
    addUnit(state, "Enemy", "Infantry", state.bases.Enemy.q - 1, state.bases.Enemy.r + 1),
    addUnit(state, "Enemy", "Operator", state.bases.Enemy.q + 1, state.bases.Enemy.r + 1),
    addUnit(state, "Enemy", "Ghost", state.bases.Enemy.q + 2, state.bases.Enemy.r + 1)
  ];
  const beforeDistances = new Map(attackers.map((unit) => [unit.id, Math.min(...state.gates.map((gate) => hexDistance(unit.coord, gate.coord)))]));

  const next = runEnemyTurn(state);
  const committedBreakoutCount = attackers.reduce((count, unit) => {
    const moved = next.units.find((candidate) => candidate.id === unit.id);
    if (!moved) {
      return count;
    }
    const before = beforeDistances.get(unit.id) ?? Number.POSITIVE_INFINITY;
    const after = Math.min(...next.gates.map((gate) => hexDistance(moved.coord, gate.coord)));
    return count + (after < before - 5 || after <= 10 ? 1 : 0);
  }, 0);
  assert(committedBreakoutCount >= 2, `Hard should fight for a gate when the player holds both and the enemy has none; ${committedBreakoutCount} units advanced`);
}

function checkHardRecapturesGateToStrandBaseAttackers(): void {
  const state = createScenario(20, 120, ["Special Services"], "Hard");
  fillEnemyResearchQueue(state);
  state.units = [];
  state.gates.forEach((gate) => {
    gate.owner = "Player";
    gate.knownOwner = "Player";
    gate.occupation.Player = 2;
    gate.occupation.Enemy = 0;
  });

  const westGate = state.gates.find((gate) => gate.id === "West");
  assert(westGate, "West gate should exist");
  const baseCapturer = addUnit(state, "Player", "Infantry", state.bases.Enemy.q, state.bases.Enemy.r);
  const baseSupport = addUnit(state, "Player", "Tank", state.bases.Enemy.q + 1, state.bases.Enemy.r + 2);
  rememberPlayerUnitForEnemy(state, baseCapturer);
  rememberPlayerUnitForEnemy(state, baseSupport);

  const gateRecapturer = addUnit(state, "Enemy", "Ghost", westGate.coord.q, westGate.coord.r - 4);
  const beforeDistance = hexDistance(gateRecapturer.coord, westGate.coord);

  const next = runEnemyTurn(state);
  const movedRecapturer = next.units.find((unit) => unit.id === gateRecapturer.id);
  assert(movedRecapturer, "Gate recapturer should survive");
  const afterDistance = hexDistance(movedRecapturer.coord, westGate.coord);
  const updatedWestGate = next.gates.find((gate) => gate.id === "West");
  assert(
    afterDistance < beforeDistance && updatedWestGate?.occupation.Enemy,
    `Hard should recapture a gate to restore the front line and strand base attackers; distance ${beforeDistance} -> ${afterDistance}, occupation ${updatedWestGate?.occupation.Enemy ?? 0}`
  );
}

function checkHardRetreatsFromPlayerThirdAfterGateLoss(): void {
  const state = createScenario(24, 120, ["Special Services"], "Hard");
  fillEnemyResearchQueue(state);
  state.units = [];
  const westGate = state.gates.find((gate) => gate.id === "West");
  const eastGate = state.gates.find((gate) => gate.id === "East");
  assert(westGate && eastGate, "Both gates should exist");
  westGate.owner = "Enemy";
  westGate.knownOwner = "Enemy";
  eastGate.owner = "Player";
  eastGate.knownOwner = "Player";

  const stranded = addUnit(state, "Enemy", "Ghost", state.bases.Player.q, state.bases.Player.r - 3);
  const beforeRow = stranded.coord.r;

  const next = runEnemyTurn(state);
  const moved = next.units.find((unit) => unit.id === stranded.id);
  assert(moved, "Stranded unit should survive its retreat turn");
  assert(moved.coord.r < beforeRow, `Hard should retreat from the player third after losing a gate; row ${beforeRow} -> ${moved.coord.r}`);
}

function checkHardDoesNotStageAgainstBlockedPlayerLine(): void {
  const state = createScenario(24, 120, ["Special Services"], "Hard");
  fillEnemyResearchQueue(state);
  state.units = [];
  const westGate = state.gates.find((gate) => gate.id === "West");
  const eastGate = state.gates.find((gate) => gate.id === "East");
  assert(westGate && eastGate, "Both gates should exist");
  westGate.owner = "Enemy";
  westGate.knownOwner = "Enemy";
  eastGate.owner = "Player";
  eastGate.knownOwner = "Player";

  const { playerLineRow } = getFrontLineRows(state);
  const blocker = addUnit(state, "Enemy", "Tank", state.bases.Player.q, playerLineRow - 3);
  const target = addUnit(state, "Player", "Tank", state.bases.Player.q, playerLineRow + 1);
  rememberPlayerUnitForEnemy(state, target);

  const next = runEnemyTurn(state);
  const moved = next.units.find((unit) => unit.id === blocker.id);
  assert(moved, "Blocked-line unit should survive");
  assert(
    moved.coord.r < playerLineRow - 1,
    `Hard should not stage beside an active player front line it cannot cross; row ${blocker.coord.r} -> ${moved.coord.r}, line ${playerLineRow}`
  );
}

function checkHardFireSupportMovesTowardCenter(): void {
  const state = createScenario(12, 0, [], "Hard");
  fillEnemyResearchQueue(state);
  state.units = [];
  const center = state.bases.Enemy.q;
  const artillery = addUnit(state, "Enemy", "Artillery", center - 2, state.bases.Enemy.r + 1);
  const antiAir = addUnit(state, "Enemy", "Anti-Air", center + 2, state.bases.Enemy.r + 1);
  for (const target of [
    addUnit(state, "Player", "Tank", center, Math.floor(state.map.height * 0.58)),
    addUnit(state, "Player", "Bomber", center + 3, Math.floor(state.map.height * 0.56))
  ]) {
    rememberPlayerUnitForEnemy(state, target);
  }
  const centerFirePosition = { q: center, r: Math.floor(state.map.height * 0.43) };
  const artilleryBefore = hexDistance(artillery.coord, centerFirePosition);
  const antiAirBefore = hexDistance(antiAir.coord, centerFirePosition);

  const next = runEnemyTurn(state);
  const movedArtillery = next.units.find((unit) => unit.id === artillery.id);
  const movedAntiAir = next.units.find((unit) => unit.id === antiAir.id);
  assert(movedArtillery && movedAntiAir, "Hard fire support units should survive");
  const { enemyLineRow } = getFrontLineRows(state);
  const antiAirImprovedOrHeldSafe =
    hexDistance(movedAntiAir.coord, centerFirePosition) < antiAirBefore || movedAntiAir.coord.r < enemyLineRow;
  assert(
    hexDistance(movedArtillery.coord, centerFirePosition) < artilleryBefore && antiAirImprovedOrHeldSafe,
    `Hard should move Artillery toward central fire positions and keep Anti-Air useful under third-range penalties; artillery ${JSON.stringify(artillery.coord)} -> ${JSON.stringify(movedArtillery.coord)}, anti-air ${JSON.stringify(antiAir.coord)} -> ${JSON.stringify(movedAntiAir.coord)}`
  );
}

function checkHardIfvScoutsForIntel(): void {
  const state = createScenario(6, 0, [], "Hard");
  fillEnemyResearchQueue(state);
  state.units = [];
  const ifv = addUnit(state, "Enemy", "IFV", state.bases.Enemy.q, state.bases.Enemy.r + 1);

  const next = runEnemyTurn(state);
  const movedIfv = next.units.find((unit) => unit.id === ifv.id);
  assert(movedIfv, "Hard IFV scout should survive");
  assert(movedIfv.coord.r > ifv.coord.r, `Hard should use IFVs as forward scouts; moved from r${ifv.coord.r} to r${movedIfv.coord.r}`);
}

function checkHardTechsWhenGateLocked(): void {
  const state = createScenario(18, 120, [], "Hard");
  for (const gate of state.gates) {
    gate.owner = "Player";
    gate.knownOwner = "Player";
  }

  const next = runEnemyTurn(state);
  const researchTypes = new Set(next.enemyEconomy.researchQueue.map((job) => job.type));
  assert(
    ["UnlockSpecialServices", "UnlockDroneFactory", "Efficiency", "ProductionCapacity", "ResearchCapacity", "ProductionSpeed", "ResearchSpeed"].some((type) => researchTypes.has(type as ResearchJob["type"])),
    `Hard should answer a two-gate lock with economy or tech research; queued ${Array.from(researchTypes).join(", ") || "nothing"}`
  );
}

function checkHardPrioritizesSpecialServicesUnlock(): void {
  const state = createScenario(12, 90, [], "Hard");
  const next = runEnemyTurn(state);
  const researchTypes = new Set(next.enemyEconomy.researchQueue.map((job) => job.type));
  assert(researchTypes.has("UnlockSpecialServices"), `Hard should unlock Special Services instead of sinking money into Infantry upgrades; queued ${Array.from(researchTypes).join(", ") || "nothing"}`);
}

function checkHardPrioritizesDroneFactoryAgainstArtilleryLock(): void {
  const state = createScenario(18, 140, ["Special Services"], "Hard");
  const center = state.bases.Enemy.q;
  const artillery = [
    addUnit(state, "Player", "Artillery", center - 2, 8),
    addUnit(state, "Player", "Artillery", center, 9),
    addUnit(state, "Player", "Artillery", center + 2, 8)
  ];
  for (const unit of artillery) {
    rememberPlayerUnitForEnemy(state, unit);
  }

  const next = runEnemyTurn(state);
  const researchTypes = new Set(next.enemyEconomy.researchQueue.map((job) => job.type));
  assert(researchTypes.has("UnlockDroneFactory"), `Hard should unlock Drone Factory against artillery pressure; queued ${Array.from(researchTypes).join(", ") || "nothing"}`);
}

function createSpectralPressureScenario(unlockedBuildings: BuildingType[] = []): GameState {
  const state = createScenario(24, 80, unlockedBuildings, "Hard");
  clearEnemyUnitCommitments(state);
  state.economy.unitLevels.Spectral = 3;
  const center = state.bases.Enemy.q;
  const spectrals = [
    addUnit(state, "Player", "Spectral", center - 2, 18),
    addUnit(state, "Player", "Spectral", center, 18),
    addUnit(state, "Player", "Spectral", center + 2, 18)
  ];
  for (const spectral of spectrals) {
    rememberPlayerUnitForEnemy(state, spectral);
  }

  return state;
}

function checkHardEscalatesTechAgainstSpectrals(): void {
  let state = createSpectralPressureScenario();
  state = runEnemyTurn(state);
  let researchTypes = new Set(state.enemyEconomy.researchQueue.map((job) => job.type));
  assert(researchTypes.has("UnlockSpecialServices"), `Hard should start Special Services against level-III Spectrals; queued ${Array.from(researchTypes).join(", ") || "nothing"}`);

  state = runEnemyTurn(createSpectralPressureScenario(["Special Services"]));
  researchTypes = new Set(state.enemyEconomy.researchQueue.map((job) => job.type));
  assert(enemyHasBuilding(state, "Special Services"), "Hard should complete Special Services instead of staying on regular air tech");
  assert(
    enemyHasBuilding(state, "Drone Factory") || researchTypes.has("UnlockDroneFactory"),
    `Hard should follow Special Services with Drone Factory against Spectrals; queued ${Array.from(researchTypes).join(", ") || "nothing"}`
  );
}

function checkHardAvoidsInfantrySpamWhenAdvancedUnitsAvailable(): void {
  const state = createScenario(22, 220, ["Special Services", "Drone Factory"], "Hard");
  fillEnemyResearchQueue(state);
  for (const gate of state.gates) {
    gate.owner = "Player";
    gate.knownOwner = "Player";
  }
  for (let index = 0; index < 7; index += 1) {
    addUnit(state, "Enemy", "Infantry", state.bases.Enemy.q + (index % 3) - 1, state.bases.Enemy.r + 1 + Math.floor(index / 3));
  }

  const produced = producedUnits(runEnemyTurn(state));
  const advancedProduced = produced.filter((unitType) => unitType !== "Infantry");
  assert(advancedProduced.length > 0, `Hard should not spend an advanced economy on only Infantry; produced ${produced.join(", ") || "nothing"}`);
  assert(produced.filter((unitType) => unitType === "Infantry").length <= 1, `Hard should limit Infantry spam when advanced units are available; produced ${produced.join(", ")}`);
}

function checkHardMidgameProductionIsNotInfantryDefault(): void {
  const state = createScenario(14, 220, [], "Hard");
  fillEnemyResearchQueue(state);
  const produced = producedUnits(runEnemyTurn(state));
  const infantryCount = produced.filter((unitType) => unitType === "Infantry").length;
  const combatCount = produced.filter((unitType) => unitType !== "Infantry").length;
  assert(combatCount >= 3, `Hard midgame should build a combat mix, not default Infantry; produced ${produced.join(", ") || "nothing"}`);
  assert(infantryCount <= 1, `Hard midgame should cap Infantry production; produced ${produced.join(", ")}`);
}

function checkHardSpecialServicesCaptureProductionUsesSpecials(): void {
  const state = createScenario(16, 180, ["Special Services"], "Hard");
  fillEnemyResearchQueue(state);
  for (const unitType of Object.keys(state.enemyEconomy.inventory) as UnitType[]) {
    state.enemyEconomy.inventory[unitType] = 0;
  }
  state.units = state.units.filter((unit) => unit.owner !== "Enemy");

  const produced = producedUnits(runEnemyTurn(state));
  assert(
    produced.some((unitType) => unitType === "Operator" || unitType === "Ghost"),
    `Hard with Special Services should produce special capture units instead of Infantry; produced ${produced.join(", ") || "nothing"}`
  );
  assert(!produced.includes("Infantry"), `Hard with Special Services should not use Infantry as the capture default; produced ${produced.join(", ")}`);
}

function checkHardCaptureProductionRanksGhostThenOperator(): void {
  const state = createScenario(18, 120, ["Special Services"], "Hard");
  fillEnemyResearchQueue(state);
  clearEnemyUnitCommitments(state);

  const produced = producedUnits(runEnemyTurn(state));
  assert.equal(produced[0], "Ghost", `Hard should prefer Ghosts as the best capture unit; produced ${produced.join(", ") || "nothing"}`);
  const operatorIndex = produced.indexOf("Operator");
  const infantryIndex = produced.indexOf("Infantry");
  assert(
    operatorIndex >= 0 && (infantryIndex < 0 || operatorIndex < infantryIndex),
    `Hard should prefer Operators over Infantry for capture production; produced ${produced.join(", ") || "nothing"}`
  );
}

function checkHardMidgameCombinedArmsProduction(): void {
  const state = createScenario(16, 500, [], "Hard");
  fillEnemyResearchQueue(state);
  clearEnemyUnitCommitments(state);
  const center = state.bases.Enemy.q;
  for (const unit of [
    addUnit(state, "Player", "Tank", center - 2, 16),
    addUnit(state, "Player", "IFV", center, 16),
    addUnit(state, "Player", "Attack Heli", center + 2, 15),
    addUnit(state, "Player", "Bomber", center + 4, 15)
  ]) {
    rememberPlayerUnitForEnemy(state, unit);
  }

  const produced = producedUnits(runEnemyTurn(state));
  assert(produced.includes("Tank"), `Hard midgame should value Tanks as ground-attack units; produced ${produced.join(", ") || "nothing"}`);
  assert(
    produced.includes("Artillery") || produced.includes("Anti-Air"),
    `Hard midgame should produce center-control fire support; produced ${produced.join(", ") || "nothing"}`
  );
  assert(
    produced.includes("Jet") || produced.includes("Bomber"),
    `Hard midgame should value jets or bombers once the economy can support them; produced ${produced.join(", ") || "nothing"}`
  );
}

function checkHardSpecialServicesProductionPrefersSpecialsOverHelicopters(): void {
  const state = createScenario(20, 160, ["Special Services"], "Hard");
  fillEnemyResearchQueue(state);
  clearEnemyUnitCommitments(state);
  const center = state.bases.Enemy.q;
  for (const unit of [
    addUnit(state, "Player", "Infantry", center - 2, 10),
    addUnit(state, "Player", "Tank", center, 10),
    addUnit(state, "Player", "IFV", center + 2, 10),
    addUnit(state, "Player", "Artillery", center + 1, 11)
  ]) {
    rememberPlayerUnitForEnemy(state, unit);
  }

  const produced = producedUnits(runEnemyTurn(state));
  assert(
    produced[0] === "Operator" || produced[0] === "Ghost",
    `Hard with Special Services should make special units the late-game default, not helicopters; produced ${produced.join(", ") || "nothing"}`
  );
  assert(
    produced.filter((unitType) => unitType === "Operator" || unitType === "Ghost").length >= produced.filter((unitType) => unitType === "Attack Heli").length,
    `Hard should value one special unit above multiple helicopters; produced ${produced.join(", ") || "nothing"}`
  );
}

function checkHardPreservesSpecialServicesUnlockMoney(): void {
  const state = createScenario(16, 26, [], "Hard");
  clearEnemyUnitCommitments(state);
  const center = state.bases.Enemy.q;
  const spectral = addUnit(state, "Player", "Spectral", center, state.bases.Enemy.r + 18);
  rememberPlayerUnitForEnemy(state, spectral);

  const next = runEnemyTurn(state);
  const researchTypes = new Set(next.enemyEconomy.researchQueue.map((job) => job.type));
  assert(researchTypes.has("UnlockSpecialServices"), `Hard should preserve money for Special Services instead of spending out on helicopters; queued ${Array.from(researchTypes).join(", ") || "nothing"}, produced ${producedUnits(next).join(", ") || "nothing"}`);
}

function checkHardBaseEmergencyDoesNotProduceInfantryForGates(): void {
  const state = createScenario(22, 120, ["Special Services"], "Hard");
  fillEnemyResearchQueue(state);
  clearEnemyUnitCommitments(state);
  for (const gate of state.gates) {
    gate.owner = "Player";
    gate.knownOwner = "Player";
  }
  const attacker = addUnit(state, "Player", "Tank", state.bases.Enemy.q, state.bases.Enemy.r);
  rememberPlayerUnitForEnemy(state, attacker);

  const produced = producedUnits(runEnemyTurn(state));
  assert(!producedOnlyInfantry(produced), `Hard base emergency should build base defenders, not infantry for distant gates; produced ${produced.join(", ") || "nothing"}`);
  assert(!produced.includes("Infantry"), `Hard should not answer an active base attack with Infantry when special defenders are available; produced ${produced.join(", ") || "nothing"}`);
}

function producedOnlyInfantry(produced: UnitType[]): boolean {
  return produced.length > 0 && produced.every((unitType) => unitType === "Infantry");
}

function checkHardOpeningProductionIncludesSupportUnits(): void {
  const state = createScenario(3, 120, [], "Hard");
  fillEnemyResearchQueue(state);
  const produced = producedUnits(runEnemyTurn(state));
  assert(
    produced.some((unitType) => unitType !== "Infantry"),
    `Hard opening production should add support or fast units once starting infantry exists; produced ${produced.join(", ") || "nothing"}`
  );
}

function checkHardProducesReaperFromUnlockedDroneFactory(): void {
  const state = createScenario(24, 100, ["Special Services", "Drone Factory"], "Hard");
  fillEnemyResearchQueue(state);
  const produced = producedUnits(runEnemyTurn(state));
  assert(produced.includes("Reaper"), `Hard with Drone Factory and Reaper money should produce Reapers; produced ${produced.join(", ") || "nothing"}`);
}

function checkHardProducesReaperAtExactReaperMoney(): void {
  const state = createScenario(24, 35, ["Special Services", "Drone Factory"], "Hard");
  fillEnemyResearchQueue(state);
  clearEnemyUnitCommitments(state);

  const produced = producedUnits(runEnemyTurn(state));
  assert(produced.includes("Reaper"), `Hard with Drone Factory should produce a first Reaper as soon as it has £35B; produced ${produced.join(", ") || "nothing"}`);
}

function checkHardForwardPressureProductionUsesEliteCombat(): void {
  const state = createScenario(24, 220, ["Special Services", "Drone Factory"], "Hard");
  fillEnemyResearchQueue(state);
  clearEnemyUnitCommitments(state);
  const center = state.bases.Enemy.q;
  for (const unit of [
    addUnit(state, "Player", "Tank", center - 3, 6),
    addUnit(state, "Player", "Tank", center - 1, 7),
    addUnit(state, "Player", "Artillery", center + 1, 8),
    addUnit(state, "Player", "Anti-Air", center + 3, 7),
    addUnit(state, "Player", "IFV", center, 6),
    addUnit(state, "Player", "Infantry", center + 2, 8)
  ]) {
    rememberPlayerUnitForEnemy(state, unit);
  }

  const produced = producedUnits(runEnemyTurn(state));
  assert(
    produced.some((unitType) => unitType === "Reaper" || unitType === "Ghost" || unitType === "Operator" || unitType === "Bomber" || unitType === "Tank" || unitType === "Artillery"),
    `Hard under forward pressure should buy elite combat units; produced ${produced.join(", ") || "nothing"}`
  );
  assert(
    produced.filter((unitType) => unitType === "IFV" || unitType === "Attack Heli").length <= 1,
    `Hard under forward pressure should not default to scout-like IFVs/helicopters; produced ${produced.join(", ") || "nothing"}`
  );
}

function checkHardPlacesAdvancedInventory(): void {
  const state = createScenario(24, 0, ["Special Services", "Drone Factory"], "Hard");
  for (const unitType of Object.keys(state.enemyEconomy.inventory) as UnitType[]) {
    state.enemyEconomy.inventory[unitType] = 0;
  }
  state.enemyEconomy.inventory.Reaper = 1;
  state.enemyEconomy.inventory.Ghost = 1;
  state.enemyEconomy.inventory.Operator = 1;

  const next = runEnemyTurn(state);
  const placedTypes = new Set(next.units.filter((unit) => unit.owner === "Enemy").map((unit) => unit.type));
  for (const unitType of ["Reaper", "Ghost", "Operator"] as UnitType[]) {
    assert(placedTypes.has(unitType), `Hard should place advanced inventory, including ${unitType}; placed ${Array.from(placedTypes).join(", ") || "nothing"}`);
  }
}

function checkDifficultyProductionVolumeScales(): void {
  const productionCounts = DIFFICULTIES.map((difficulty) => {
    const state = createScenario(18, 500, ["Special Services", "Drone Factory"], difficulty);
    fillEnemyResearchQueue(state);
    return { difficulty, count: producedUnits(runEnemyTurn(state)).length };
  });
  const easy = productionCounts.find((result) => result.difficulty === "Easy");
  const medium = productionCounts.find((result) => result.difficulty === "Medium");
  const hard = productionCounts.find((result) => result.difficulty === "Hard");
  assert(easy && medium && hard, "All difficulty production counts should be measured");
  assert(
    easy.count <= medium.count && medium.count <= hard.count && easy.count < hard.count,
    `Production volume should scale by difficulty; Easy ${easy.count}, Medium ${medium.count}, Hard ${hard.count}`
  );
}

function checkDifficultyWeakGateSelectionScales(): void {
  const hard = getWeakGateProgress("Hard");
  const hardWeakGateBias = hard.eastProgress - hard.westProgress;
  assert(
    hardWeakGateBias > 0 && hard.eastDistance < hard.westDistance,
    `Hard weak-gate selection should prefer the less-defended gate; bias ${hardWeakGateBias}`
  );
}

function checkDifficultyExposedBaseExploitationScales(): void {
  const medium = getExposedBaseProgress("Medium");
  const hard = getExposedBaseProgress("Hard");
  assert(
    hard > 0 && hard >= medium,
    `Exposed-base exploitation should scale by difficulty; Medium ${medium}, Hard ${hard}`
  );
}

const AI_BEHAVIOR_CHECKS: Array<{ name: string; run: () => void }> = [
  { name: "artillery damage reduced", run: checkArtilleryDamageReduced },
  { name: "regular production times reduced", run: checkRegularProductionTimesReduced },
  { name: "territory range penalties", run: checkTerritoryRangePenalties },
  { name: "special unit upgrade costs scale with unit value", run: checkSpecialUnitUpgradeCostsScaleWithUnitValue },
  { name: "artillery move attack exclusive", run: () => checkMoveAttackExclusiveUnit("Artillery", "Infantry") },
  { name: "anti-air move attack exclusive", run: () => checkMoveAttackExclusiveUnit("Anti-Air", "Bomber") },
  { name: "field unit upgrade and production levels", run: checkFieldUnitUpgradeAndProductionLevels },
  { name: "field unit upgrade can use gain alternative", run: checkFieldUnitUpgradeCanUseGainAlternative },
  { name: "field unit upgrade requires funds by default", run: checkFieldUnitUpgradeRequiresFundsByDefault },
  { name: "field unit upgrade requires gain when selected", run: checkFieldUnitUpgradeRequiresGainWhenSelected },
  { name: "hard unit upgrade research follows actual use", run: checkHardUnitUpgradeResearchFollowsActualUse },
  { name: "hard does not research unused reaper upgrade", run: checkHardDoesNotResearchUnusedReaperUpgrade },
  { name: "attack miss logged", run: checkAttackMissLogged },
  { name: "persistent intel memory", run: checkPersistentIntelMemory },
  { name: "base capture progress advances once per turn", run: checkBaseCaptureProgressAdvancesOncePerTurn },
  { name: "hard production budget comes before research", run: checkHardProductionBudgetComesBeforeResearch },
  ...DIFFICULTIES.flatMap((difficulty) => [
    { name: `${difficulty} ground without anti-air draws air power`, run: () => checkGroundWithoutAntiAirDrawsAirPower(difficulty) },
    { name: `${difficulty} air-heavy player draws air counters`, run: () => checkAirHeavyPlayerDrawsAirCounters(difficulty) },
    { name: `${difficulty} reaper endgame priority`, run: () => checkReaperEndgamePriority(difficulty) },
    { name: `${difficulty} economy and throughput research`, run: () => checkEconomyAndThroughputResearch(difficulty) },
    { name: `${difficulty} emergency base defense`, run: () => checkEmergencyBaseDefense(difficulty) },
    { name: `${difficulty} damaged high-value unit retreats`, run: () => checkDamagedHighValueUnitRetreats(difficulty) },
    { name: `${difficulty} captured gate is defended`, run: () => checkCapturedGateIsDefended(difficulty) },
    { name: `${difficulty} reaper budget discipline`, run: () => checkReaperBudgetDiscipline(difficulty) }
  ]),
  { name: "hard patrols both flanks", run: checkHardPatrolsBothFlanks },
  { name: "hard keeps base sentry", run: checkHardKeepsBaseSentry },
  { name: "hard produces capture when capturers are distant", run: checkHardProducesCaptureWhenCapturersAreDistant },
  { name: "hard damaged defender holds base emergency", run: checkHardDamagedDefenderHoldsBaseEmergency },
  { name: "hard chooses weak gate", run: checkHardChoosesWeakGate },
  { name: "hard exploits exposed player base", run: checkHardExploitsExposedPlayerBase },
  { name: "hard moves for early gate capture", run: checkHardMovesForEarlyGateCapture },
  { name: "hard opening scouts and rushers use gate lanes", run: checkHardOpeningScoutsAndRushersUseGateLanes },
  { name: "hard opening same-gate IFVs spread out", run: checkHardOpeningSameGateIfvsSpreadOut },
  { name: "hard places all starting units first turn in gate lanes", run: checkHardPlacesAllStartingUnitsFirstTurnInGateLanes },
  { name: "hard splits opening gate capturers", run: checkHardSplitsOpeningGateCapturers },
  { name: "hard opening falls back to winning gate", run: checkHardOpeningFallsBackToWinningGate },
  { name: "hard fights for gate when locked out", run: checkHardFightsForGateWhenLockedOut },
  { name: "hard recaptures gate to strand base attackers", run: checkHardRecapturesGateToStrandBaseAttackers },
  { name: "hard retreats from player third after gate loss", run: checkHardRetreatsFromPlayerThirdAfterGateLoss },
  { name: "hard does not stage against blocked player line", run: checkHardDoesNotStageAgainstBlockedPlayerLine },
  { name: "hard fire support moves toward center", run: checkHardFireSupportMovesTowardCenter },
  { name: "hard IFV scouts for intel", run: checkHardIfvScoutsForIntel },
  { name: "hard techs when gate locked", run: checkHardTechsWhenGateLocked },
  { name: "hard prioritizes Special Services unlock", run: checkHardPrioritizesSpecialServicesUnlock },
  { name: "hard prioritizes Drone Factory against artillery lock", run: checkHardPrioritizesDroneFactoryAgainstArtilleryLock },
  { name: "hard escalates tech against Spectrals", run: checkHardEscalatesTechAgainstSpectrals },
  { name: "artillery line draws bombers", run: checkArtilleryLineDrawsBombers },
  { name: "hard avoids Infantry spam when advanced units available", run: checkHardAvoidsInfantrySpamWhenAdvancedUnitsAvailable },
  { name: "hard midgame production is not Infantry default", run: checkHardMidgameProductionIsNotInfantryDefault },
  { name: "hard Special Services capture production uses specials", run: checkHardSpecialServicesCaptureProductionUsesSpecials },
  { name: "hard capture production ranks Ghost then Operator", run: checkHardCaptureProductionRanksGhostThenOperator },
  { name: "hard midgame combined arms production", run: checkHardMidgameCombinedArmsProduction },
  { name: "hard Special Services production prefers specials over Helicopters", run: checkHardSpecialServicesProductionPrefersSpecialsOverHelicopters },
  { name: "hard preserves Special Services unlock money", run: checkHardPreservesSpecialServicesUnlockMoney },
  { name: "hard base emergency does not produce Infantry for gates", run: checkHardBaseEmergencyDoesNotProduceInfantryForGates },
  { name: "hard opening production includes support units", run: checkHardOpeningProductionIncludesSupportUnits },
  { name: "hard produces Reaper from unlocked Drone Factory", run: checkHardProducesReaperFromUnlockedDroneFactory },
  { name: "hard produces Reaper at exact Reaper money", run: checkHardProducesReaperAtExactReaperMoney },
  { name: "hard forward pressure production uses elite combat", run: checkHardForwardPressureProductionUsesEliteCombat },
  { name: "hard places advanced inventory", run: checkHardPlacesAdvancedInventory },
  { name: "difficulty production volume scales", run: checkDifficultyProductionVolumeScales },
  { name: "difficulty weak gate selection scales", run: checkDifficultyWeakGateSelectionScales },
  { name: "difficulty exposed base exploitation scales", run: checkDifficultyExposedBaseExploitationScales }
];

function getSelectedAiBehaviorCheckIndexes(): Set<number> | undefined {
  const raw = process.env.AI_BEHAVIOR_CHECKS;
  if (!raw) {
    return undefined;
  }

  const indexes = raw
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 0 && value < AI_BEHAVIOR_CHECKS.length);
  return new Set(indexes);
}

function runAiBehaviorChecks(): void {
  if (process.env.AI_BEHAVIOR_LIST_CHECKS === "1") {
    console.log(JSON.stringify(AI_BEHAVIOR_CHECKS.map((check, index) => ({ index, name: check.name }))));
    return;
  }

  const selectedIndexes = getSelectedAiBehaviorCheckIndexes();
  for (const [index, check] of AI_BEHAVIOR_CHECKS.entries()) {
    if (selectedIndexes && !selectedIndexes.has(index)) {
      continue;
    }
    check.run();
  }

  if (!selectedIndexes) {
    console.log("AI behavior checks passed.");
  }
}

runAiBehaviorChecks();
