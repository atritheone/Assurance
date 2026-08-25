import { getUnitDefinition } from "../data/unitDefs";
import { hexDistance, hexId } from "./map";
import type { GameState, HexCoord, Owner } from "./types";

export type BattlefieldArea = "Alliance" | "No Man's Land" | "Empire";

const FRONT_LINE_SHIFT_ROWS = 3;

export function getFrontLineRows(state: GameState): { enemyLineRow: number; playerLineRow: number } {
  const homeAreaDepth = Math.max(1, Math.floor(state.map.height / 3) - FRONT_LINE_SHIFT_ROWS);
  return {
    enemyLineRow: homeAreaDepth,
    playerLineRow: state.map.height - homeAreaDepth
  };
}

export function getBattlefieldArea(state: GameState, coord: HexCoord): BattlefieldArea {
  const lines = getFrontLineRows(state);
  if (coord.r < lines.enemyLineRow) {
    return "Alliance";
  }

  if (coord.r >= lines.playerLineRow) {
    return "Empire";
  }

  return "No Man's Land";
}

export function getOwnerHomeArea(owner: Owner): BattlefieldArea {
  return owner === "Player" ? "Empire" : "Alliance";
}

export function getOwnerEnemyArea(owner: Owner): BattlefieldArea {
  return owner === "Player" ? "Alliance" : "Empire";
}

export function getTerritoryRangePenalty(state: GameState, owner: Owner, coord: HexCoord | undefined): number {
  if (!coord) {
    return 0;
  }

  const area = getBattlefieldArea(state, coord);
  if (area === getOwnerHomeArea(owner)) {
    return 0;
  }

  return area === "No Man's Land" ? 1 : 2;
}

export function getTerritoryRangePenaltyForRange(
  state: GameState,
  owner: Owner,
  origin: HexCoord | undefined,
  target: HexCoord | undefined
): number {
  return Math.max(getTerritoryRangePenalty(state, owner, origin), getTerritoryRangePenalty(state, owner, target));
}

export function getOwnerControlledTerritoryHexIds(state: GameState, owner: Owner): Set<string> {
  const controlled = new Set<string>();
  const frontByQ = new Map<number, number>();

  for (const unit of state.units) {
    if (unit.owner !== owner || unit.health <= 0) {
      continue;
    }

    const moveRange = getUnitDefinition(unit.type).moveRange;
    for (const hex of state.map.hexes) {
      if (!hex.passable || hexDistance(unit.coord, hex.coord) > moveRange) {
        continue;
      }

      controlled.add(hex.id);
      const current = frontByQ.get(hex.coord.q);
      if (owner === "Enemy") {
        frontByQ.set(hex.coord.q, current === undefined ? hex.coord.r : Math.max(current, hex.coord.r));
      } else {
        frontByQ.set(hex.coord.q, current === undefined ? hex.coord.r : Math.min(current, hex.coord.r));
      }
    }
  }

  for (const hex of state.map.hexes) {
    if (!hex.passable) {
      continue;
    }

    const front = frontByQ.get(hex.coord.q);
    if (front === undefined) {
      continue;
    }

    if ((owner === "Enemy" && hex.coord.r <= front) || (owner === "Player" && hex.coord.r >= front)) {
      controlled.add(hex.id);
    }
  }

  controlled.add(hexId(state.bases[owner]));
  return controlled;
}

export function getOwnerControlledTerritoryCount(state: GameState, owner: Owner): number {
  return getOwnerControlledTerritoryHexIds(state, owner).size;
}
