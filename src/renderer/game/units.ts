import { UNIT_DEFINITIONS, getUnitDefinition } from "../data/unitDefs";
import { isUnitAvailableToOwnerInState } from "./factions";
import { getVisibleHexIdsForOwner } from "./fog";
import { getHex, getNeighborCoords, hexDistance, hexId, sameHex } from "./map";
import { getBattlefieldArea, getFrontLineRows as getTerritoryFrontLineRows, getOwnerEnemyArea } from "./territory";
import { getEffectiveUnitStats } from "./unitStats";
import type { GameState, HexCoord, Owner, SpottedUnit, UnitDomain, UnitInstance, UnitType } from "./types";

const HIGH_ALTITUDE_AIR_UNITS = new Set<UnitType>(["Jet", "Bomber", "Reaper"]);
const DEBUG_UNLIMITED_RANGE = 999;

export const FRONT_LINE_ATTRITION_PERCENT = 0.2;
export const SUPPLY_TRUCK_REPAIR_RANGE = 2;
export const SUPPLY_TRUCK_PLACEMENT_RANGE = 1;
const SUPPLY_PLACEMENT_PROVIDER_TYPES = new Set<UnitType>(["Supply Truck", "Command Heli"]);

export function getUnitAt(state: GameState, coord: HexCoord): UnitInstance | undefined {
  return state.units.find((unit) => sameHex(unit.coord, coord));
}

export function getUnitsAt(state: GameState, coord: HexCoord): UnitInstance[] {
  return state.units.filter((unit) => sameHex(unit.coord, coord));
}

export function getPlayerUnitsAt(state: GameState, coord: HexCoord): UnitInstance[] {
  return getUnitsAt(state, coord).filter((unit) => unit.owner === "Player");
}

export function getEnemyUnitsAt(state: GameState, coord: HexCoord): UnitInstance[] {
  return getUnitsAt(state, coord).filter((unit) => unit.owner === "Enemy");
}

export function getOpposingUnitsAt(state: GameState, owner: Owner, coord: HexCoord): UnitInstance[] {
  return getUnitsAt(state, coord).filter((unit) => unit.owner !== owner);
}

export function getUnitDomain(unitType: UnitType): UnitDomain {
  return getUnitDefinition(unitType).domain;
}

export function isMoveAttackExclusiveUnit(unitType: UnitType): boolean {
  return getUnitDefinition(unitType).cannotMoveAndAttack === true;
}

export function canUnitTargetUnit(attackerType: UnitType, targetType: UnitType): boolean {
  const attacker = getUnitDefinition(attackerType);
  if (attacker.cannotAttack) {
    return false;
  }

  const target = getUnitDefinition(targetType);
  if (attacker.domain === "Ground" && HIGH_ALTITUDE_AIR_UNITS.has(targetType) && attackerType !== "Anti-Air") {
    return false;
  }
  return !attacker.targetDomains || attacker.targetDomains.includes(target.domain);
}

export function hasAttackableTargetAt(state: GameState, unit: UnitInstance, coord: HexCoord): boolean {
  return hasAttackableTargetAtWithVisibility(state, unit, coord, getVisibleHexIdsForOwner(state, unit.owner));
}

function hasAttackableTargetAtWithVisibility(
  state: GameState,
  unit: UnitInstance,
  coord: HexCoord,
  visibleHexIds: Set<string>
): boolean {
  const target = getHex(state.map, coord);
  if (!target) {
    return false;
  }

  if (!isHexVisibleForAction(state, unit.owner, target.id, visibleHexIds)) {
    return false;
  }

  if (!canOwnerOperateAcrossFrontLine(state, unit.owner, unit.coord) || !canOwnerOperateAcrossFrontLine(state, unit.owner, coord)) {
    return false;
  }

  const stats = getEffectiveUnitStats(state, unit.owner, unit.type, unit.level, unit.coord, coord);
  const attackRange = getDebugAttackRange(state, unit, stats.attackRange);
  return (
    hexDistance(unit.coord, coord) <= attackRange &&
    getOpposingUnitsAt(state, unit.owner, coord).some((targetUnit) => canUnitTargetUnit(unit.type, targetUnit.type))
  );
}

export function getSelectedUnit(state: GameState): UnitInstance | undefined {
  if (!state.selection.selectedUnitId) {
    return undefined;
  }

  const liveUnit = state.units.find((unit) => unit.id === state.selection.selectedUnitId);
  if (liveUnit && (liveUnit.owner === "Player" || state.fog[hexId(liveUnit.coord)] === "visible" || state.debugOptions?.showAiUnits)) {
    return liveUnit;
  }

  const spottedUnit = state.spottedUnits?.Player?.[state.selection.selectedUnitId];
  return spottedUnit ? spottedUnitToInspectableUnit(state, spottedUnit) : undefined;
}

function spottedUnitToInspectableUnit(state: GameState, unit: SpottedUnit): UnitInstance {
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

export function getReachableHexIds(state: GameState, unit: UnitInstance): Set<string> {
  return getReachableHexIdsWithVisibility(state, unit, getVisibleHexIdsForOwner(state, unit.owner));
}

export function getReachableHexIdsWithVisibility(state: GameState, unit: UnitInstance, visibleHexIds: Set<string>): Set<string> {
  const definition = getUnitDefinition(unit.type);
  const remainingMovement = getRemainingMovementPoints(state, unit);
  const occupied = new Set(
    state.units
      .filter(
        (candidate) =>
          candidate.id !== unit.id &&
          (candidate.owner !== unit.owner || getUnitDomain(candidate.type) === definition.domain)
      )
      .map((candidate) => hexId(candidate.coord))
  );
  const reachable = new Set<string>();

  if (remainingMovement <= 0) {
    return reachable;
  }

  const minQ = Math.max(0, unit.coord.q - remainingMovement);
  const maxQ = Math.min(state.map.width - 1, unit.coord.q + remainingMovement);
  const minR = Math.max(0, unit.coord.r - remainingMovement);
  const maxR = Math.min(state.map.height - 1, unit.coord.r + remainingMovement);
  for (let r = minR; r <= maxR; r += 1) {
    for (let q = minQ; q <= maxQ; q += 1) {
      const hex = getHex(state.map, { q, r });
      if (!hex) {
        continue;
      }

      if (!hex.passable || occupied.has(hex.id) || !visibleHexIds.has(hex.id) || !canOwnerMoveAcrossFrontLine(state, unit.owner, unit.coord, hex.coord)) {
        continue;
      }

      const distance = hexDistance(unit.coord, hex.coord);
      const adjustedRemainingMovement = getRemainingMovementPointsForDestination(state, unit, hex.coord);
      if (distance > 0 && distance <= Math.min(remainingMovement, adjustedRemainingMovement)) {
        reachable.add(hex.id);
      }
    }
  }

  return reachable;
}

export function getLegalMoveCoords(state: GameState, unit: UnitInstance): HexCoord[] {
  return getLegalMoveCoordsWithVisibility(state, unit, getVisibleHexIdsForOwner(state, unit.owner));
}

export function getLegalMoveCoordsWithVisibility(state: GameState, unit: UnitInstance, visibleHexIds: Set<string>): HexCoord[] {
  const reachableHexIds = getReachableHexIdsWithVisibility(state, unit, visibleHexIds);
  return state.map.hexes
    .filter((hex) => reachableHexIds.has(hex.id))
    .map((hex) => ({ ...hex.coord }));
}

export function getRemainingMovementPoints(state: GameState, unit: UnitInstance): number {
  if (!canUnitMoveThisDay(state, unit)) {
    return 0;
  }

  if (state.debugOptions?.[unit.owner]?.unlimitedMovement) {
    return DEBUG_UNLIMITED_RANGE;
  }

  const stats = getEffectiveUnitStats(state, unit.owner, unit.type, unit.level, unit.coord);
  return Math.max(0, stats.moveRange - (unit.movementSpentThisDay ?? 0));
}

function getRemainingMovementPointsForDestination(state: GameState, unit: UnitInstance, destination: HexCoord): number {
  if (!canUnitMoveThisDay(state, unit)) {
    return 0;
  }

  if (state.debugOptions?.[unit.owner]?.unlimitedMovement) {
    return DEBUG_UNLIMITED_RANGE;
  }

  const stats = getEffectiveUnitStats(state, unit.owner, unit.type, unit.level, unit.coord, destination);
  return Math.max(0, stats.moveRange - (unit.movementSpentThisDay ?? 0));
}

export function canUnitMoveThisDay(state: GameState, unit: UnitInstance): boolean {
  return (
    unit.placedDay !== state.day &&
    !(isSupplyPlacementProvider(unit.type) && unit.hasProvidedPlacementThisDay) &&
    !(isMoveAttackExclusiveUnit(unit.type) && unit.hasAttackedThisDay)
  );
}

export function getAttackRangeHexIds(state: GameState, unit: UnitInstance): Set<string> {
  const range = new Set<string>();
  if (!canUnitAttackThisDay(state, unit)) {
    return range;
  }

  for (const hex of state.map.hexes) {
    if (unit.owner === "Player" && state.fog[hex.id] === "unexplored") {
      continue;
    }
    const stats = getEffectiveUnitStats(state, unit.owner, unit.type, unit.level, unit.coord, hex.coord);
    const attackRange = getDebugAttackRange(state, unit, stats.attackRange);

    if (
      hexDistance(unit.coord, hex.coord) <= attackRange &&
      canOwnerOperateAcrossFrontLine(state, unit.owner, unit.coord) &&
      canOwnerOperateAcrossFrontLine(state, unit.owner, hex.coord)
    ) {
      range.add(hex.id);
    }
  }

  return range;
}

export function getLegalAttackCoords(state: GameState, unit: UnitInstance): HexCoord[] {
  return getLegalAttackCoordsWithVisibility(state, unit, getVisibleHexIdsForOwner(state, unit.owner));
}

export function getLegalAttackCoordsWithVisibility(state: GameState, unit: UnitInstance, visibleHexIds: Set<string>): HexCoord[] {
  if (!canUnitAttackThisDay(state, unit)) {
    return [];
  }

  const attackableHexIds = new Set<string>();
  const attackableCoords: HexCoord[] = [];

  for (const targetUnit of state.units) {
    if (targetUnit.owner === unit.owner || !canUnitTargetUnit(unit.type, targetUnit.type)) {
      continue;
    }

    const stats = getEffectiveUnitStats(state, unit.owner, unit.type, unit.level, unit.coord, targetUnit.coord);
    const attackRange = getDebugAttackRange(state, unit, stats.attackRange);
    const id = hexId(targetUnit.coord);
    if (
      attackableHexIds.has(id) ||
      !isHexVisibleForAction(state, unit.owner, id, visibleHexIds) ||
      hexDistance(unit.coord, targetUnit.coord) > attackRange ||
      !canOwnerOperateAcrossFrontLine(state, unit.owner, unit.coord) ||
      !canOwnerOperateAcrossFrontLine(state, unit.owner, targetUnit.coord)
    ) {
      continue;
    }

    attackableHexIds.add(id);
    attackableCoords.push({ ...targetUnit.coord });
  }

  return attackableCoords;
}

export function canMoveUnitTo(state: GameState, unit: UnitInstance, coord: HexCoord): boolean {
  const target = getHex(state.map, coord);
  if (!target) {
    return false;
  }

  return getReachableHexIds(state, unit).has(target.id);
}

export function canQueueMoveUnitTo(state: GameState, unit: UnitInstance, coord: HexCoord): boolean {
  return canUnitStartQueuedMovement(unit) && Boolean(findMovementPath(state, unit, coord, { allowFutureMovement: true }));
}

function canUnitStartQueuedMovement(unit: UnitInstance): boolean {
  return !(isMoveAttackExclusiveUnit(unit.type) && unit.hasAttackedThisDay);
}

export function findMovementPath(
  state: GameState,
  unit: UnitInstance,
  destination: HexCoord,
  options: { allowFutureMovement?: boolean } = {}
): HexCoord[] | undefined {
  const target = getHex(state.map, destination);
  const canStartPath = options.allowFutureMovement ? canUnitStartQueuedMovement(unit) : canUnitMoveThisDay(state, unit);
  const definition = getUnitDefinition(unit.type);
  const occupied = new Set(
    state.units
      .filter(
        (candidate) =>
          candidate.id !== unit.id &&
          (candidate.owner !== unit.owner || getUnitDomain(candidate.type) === definition.domain)
      )
      .map((candidate) => hexId(candidate.coord))
  );
  if (!canStartPath || !target || !target.passable || sameHex(unit.coord, destination) || occupied.has(target.id)) {
    return undefined;
  }

  const startId = hexId(unit.coord);
  const destinationId = hexId(destination);
  const queue = [unit.coord];
  const visited = new Set<string>([startId]);
  const previous = new Map<string, string>();

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    for (const neighbor of getNeighborCoords(state.map, current)) {
      const neighborId = hexId(neighbor);
      if (visited.has(neighborId)) {
        continue;
      }

      const hex = getHex(state.map, neighbor);
      if (!hex?.passable || occupied.has(neighborId) || !canOwnerMoveAcrossFrontLine(state, unit.owner, current, neighbor)) {
        continue;
      }

      visited.add(neighborId);
      previous.set(neighborId, hexId(current));
      if (neighborId === destinationId) {
        return rebuildPath(previous, startId, destinationId);
      }

      queue.push(neighbor);
    }
  }

  return undefined;
}

export function getQueuedMovementMoveCount(state: GameState, unit: UnitInstance): number {
  return getQueuedMovementStopPathIndexes(state, unit).length;
}

export function getQueuedMovementStopPathIndexes(state: GameState, unit: UnitInstance): number[] {
  const path = unit.queuedMovement?.path ?? [];
  if (!path.length) {
    return [];
  }

  const stops: number[] = [];
  let origin = unit.coord;
  let pathIndex = 0;

  while (pathIndex < path.length) {
    let bestIndex = pathIndex;
    for (let candidateIndex = pathIndex; candidateIndex < path.length; candidateIndex += 1) {
      const distance = candidateIndex - pathIndex + 1;
      const range = getEffectiveUnitStats(state, unit.owner, unit.type, unit.level, origin, path[candidateIndex]).moveRange;
      if (distance > range) {
        break;
      }
      bestIndex = candidateIndex + 1;
    }

    if (bestIndex <= pathIndex) {
      bestIndex = pathIndex + 1;
    }
    stops.push(bestIndex);
    origin = path[Math.min(bestIndex, path.length) - 1];
    pathIndex = bestIndex;
  }

  return stops;
}

export function canUnitEndMovementAt(state: GameState, unit: UnitInstance, coord: HexCoord): boolean {
  const target = getHex(state.map, coord);
  if (!target?.passable) {
    return false;
  }

  const definition = getUnitDefinition(unit.type);
  return !state.units.some(
    (candidate) =>
      candidate.id !== unit.id &&
      sameHex(candidate.coord, coord) &&
      (candidate.owner !== unit.owner || getUnitDomain(candidate.type) === definition.domain)
  );
}

export function getFrontLineRows(state: GameState): { enemyLineRow: number; playerLineRow: number } {
  return getTerritoryFrontLineRows(state);
}

export function ownerControlsBothGates(state: GameState, owner: Owner): boolean {
  return (state.gates ?? []).length > 0 && (state.gates ?? []).every((gate) => gate.owner === owner);
}

export function isCoordPastEnemyFrontLine(state: GameState, owner: Owner, coord: HexCoord): boolean {
  const lines = getFrontLineRows(state);
  return owner === "Player" ? coord.r < lines.enemyLineRow : coord.r >= lines.playerLineRow;
}

export function canOwnerOperateAcrossFrontLine(state: GameState, owner: Owner, coord: HexCoord): boolean {
  return ownerControlsBothGates(state, owner) || !isCoordPastEnemyFrontLine(state, owner, coord);
}

export function canOwnerMoveAcrossFrontLine(state: GameState, owner: Owner, from: HexCoord, to: HexCoord): boolean {
  if (ownerControlsBothGates(state, owner) || !isCoordPastEnemyFrontLine(state, owner, to)) {
    return true;
  }

  if (!isCoordPastEnemyFrontLine(state, owner, from)) {
    return false;
  }

  return owner === "Player" ? to.r > from.r : to.r < from.r;
}

export function canAttackHex(state: GameState, unit: UnitInstance, coord: HexCoord): boolean {
  const target = getHex(state.map, coord);
  if (!target || unit.owner !== "Player") {
    return false;
  }

  return canUnitAttackThisDay(state, unit) && hasAttackableTargetAt(state, unit, coord);
}

function rebuildPath(previous: Map<string, string>, startId: string, destinationId: string): HexCoord[] {
  const ids: string[] = [];
  let currentId = destinationId;

  while (currentId !== startId) {
    ids.push(currentId);
    const nextId = previous.get(currentId);
    if (!nextId) {
      return [];
    }
    currentId = nextId;
  }

  return ids.reverse().map((id) => {
    const [q, r] = id.split(",").map(Number);
    return { q, r };
  });
}

function getDebugAttackRange(state: GameState, unit: UnitInstance, baseRange: number): number {
  return baseRange > 0 && state.debugOptions?.[unit.owner]?.unlimitedAttackRange ? DEBUG_UNLIMITED_RANGE : baseRange;
}

function isHexVisibleForAction(state: GameState, owner: Owner, id: string, visibleHexIds: Set<string>): boolean {
  return visibleHexIds.has(id) || (owner === "Player" && Boolean(state.debugOptions?.showAiUnits));
}

export function canUnitAttackHex(state: GameState, unit: UnitInstance, coord: HexCoord): boolean {
  const target = getHex(state.map, coord);
  return Boolean(target && canUnitAttackThisDay(state, unit) && hasAttackableTargetAt(state, unit, coord));
}

export function canUnitAttackThisDay(state: GameState, unit: UnitInstance): boolean {
  if (getUnitDefinition(unit.type).cannotAttack) {
    return false;
  }

  return (
    !unit.hasAttackedThisDay &&
    unit.placedDay !== state.day &&
    !(isMoveAttackExclusiveUnit(unit.type) && (unit.movementSpentThisDay ?? 0) > 0)
  );
}

export function canPlacePlayerUnitAt(state: GameState, unitType: UnitType, coord: HexCoord): boolean {
  return canPlaceUnitAt(state, "Player", unitType, coord);
}

export function canPlaceUnitAt(state: GameState, owner: Owner, unitType: UnitType, coord: HexCoord): boolean {
  const definition = getUnitDefinition(unitType);
  if (!isUnitAvailableToOwnerInState(state, owner, unitType)) {
    return false;
  }

  const target = getHex(state.map, coord);
  if (!target || !target.passable) {
    return false;
  }

  const isBackRow = isOwnerBackRow(state, owner, coord);
  const isSupplyTruckPlacement = definition.domain === "Ground" && Boolean(getOwnerSupplyTruckPlacementAnchor(state, owner, coord));
  if (!isBackRow && !isSupplyTruckPlacement) {
    return false;
  }

  const economy = owner === "Player" ? state.economy : state.enemyEconomy;
  if (economy.inventory[unitType] <= 0) {
    return false;
  }

  const domain = definition.domain;
  return !getUnitsAt(state, coord).some((unit) => getUnitDomain(unit.type) === domain);
}

export function getLegalPlacementCoords(state: GameState, owner: Owner, unitType: UnitType): HexCoord[] {
  return state.map.hexes
    .filter((hex) => canPlaceUnitAt(state, owner, unitType, hex.coord))
    .map((hex) => ({ ...hex.coord }));
}

export function isPlayerBackRow(state: GameState, coord: HexCoord): boolean {
  return isOwnerBackRow(state, "Player", coord);
}

export function isOwnerBackRow(state: GameState, owner: Owner, coord: HexCoord): boolean {
  return coord.r === (owner === "Player" ? state.map.height - 1 : 0);
}

export function isOwnerPlacementZone(state: GameState, owner: Owner, coord: HexCoord): boolean {
  return isOwnerBackRow(state, owner, coord) || Boolean(getOwnerSupplyTruckPlacementAnchor(state, owner, coord));
}

export function isWithinOwnerSupplyTruckRange(state: GameState, owner: Owner, coord: HexCoord, range: number): boolean {
  return state.units.some((unit) => {
    const distance = unit.owner === owner && isSupplyPlacementProvider(unit.type) ? hexDistance(unit.coord, coord) : Number.POSITIVE_INFINITY;
    return distance > 0 && distance <= range;
  });
}

export function getOwnerSupplyTruckRepairHealthRatio(state: GameState, owner: Owner, coord: HexCoord, range: number): number | undefined {
  let bestRatio: number | undefined;
  for (const unit of state.units) {
    const distance = unit.owner === owner && isSupplyPlacementProvider(unit.type) ? hexDistance(unit.coord, coord) : Number.POSITIVE_INFINITY;
    if (distance <= 0 || distance > range) {
      continue;
    }

    const ratio = Math.max(0.01, Math.min(1, unit.health / Math.max(1, unit.maxHealth)));
    bestRatio = bestRatio === undefined ? ratio : Math.max(bestRatio, ratio);
  }

  return bestRatio;
}

export function getOwnerSupplyTruckPlacementAnchor(state: GameState, owner: Owner, coord: HexCoord): UnitInstance | undefined {
  if (getBattlefieldArea(state, coord) === getOwnerEnemyArea(owner)) {
    return undefined;
  }

  return state.units.find((unit) => unit.owner === owner && canSupplyTruckProvidePlacementAt(state, unit, coord));
}

export function canSupplyTruckEnablePlacement(state: GameState, unit: UnitInstance): boolean {
  if (!isSupplyTruckAvailableForPlacement(unit, state.day)) {
    return false;
  }

  const economy = unit.owner === "Player" ? state.economy : state.enemyEconomy;
  const groundInventory = UNIT_DEFINITIONS.filter((definition) => definition.domain === "Ground" && economy.inventory[definition.type] > 0);
  if (!groundInventory.length) {
    return false;
  }

  return state.map.hexes.some((hex) =>
    groundInventory.some((definition) => canSupplyTruckProvidePlacementAt(state, unit, hex.coord, definition.type))
  );
}

export function canSupplyTruckProvidePlacementAt(
  state: GameState,
  unit: UnitInstance,
  coord: HexCoord,
  unitType?: UnitType
): boolean {
  if (!isSupplyTruckAvailableForPlacement(unit, state.day)) {
    return false;
  }

  const target = getHex(state.map, coord);
  if (!target?.passable || getBattlefieldArea(state, coord) === getOwnerEnemyArea(unit.owner)) {
    return false;
  }

  const distance = hexDistance(unit.coord, coord);
  if (distance <= 0 || distance > SUPPLY_TRUCK_PLACEMENT_RANGE) {
    return false;
  }

  if (!unitType) {
    return true;
  }

  const definition = getUnitDefinition(unitType);
  if (definition.domain !== "Ground" || !isUnitAvailableToOwnerInState(state, unit.owner, unitType)) {
    return false;
  }

  const economy = unit.owner === "Player" ? state.economy : state.enemyEconomy;
  if (economy.inventory[unitType] <= 0) {
    return false;
  }

  return !getUnitsAt(state, coord).some((candidate) => getUnitDomain(candidate.type) === definition.domain);
}

function isSupplyTruckAvailableForPlacement(unit: UnitInstance, day: number): boolean {
  return (
    isSupplyPlacementProvider(unit.type) &&
    unit.placedDay !== day &&
    !unit.hasMovedThisDay &&
    (unit.movementSpentThisDay ?? 0) <= 0
  );
}

export function isSupplyPlacementProvider(unitType: UnitType): boolean {
  return SUPPLY_PLACEMENT_PROVIDER_TYPES.has(unitType);
}
