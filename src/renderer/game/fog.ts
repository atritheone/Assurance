import { getHex, hexDistance, hexId, sameHex } from "./map";
import { getEffectiveUnitStats, getTerritoryRangePenalty, getUnitInstanceLevel } from "./unitStats";
import type { FogStatus, GameMap, GameState, GateState, HexCoord, HexTile, Owner, SpottedUnitsByOwner, SpottedUnit } from "./types";

const GATE_SIDE_VISION_WIDTH_RATIO = 0.42;
const GATE_SIDE_VISION_HEIGHT_RATIO = 0.7;
const GATE_LOCAL_VISION_RADIUS = 8;
const SPOTTED_UNIT_MEMORY_DAYS = 8;

export function createUnexploredFog(map: GameMap): Record<string, FogStatus> {
  return Object.fromEntries(map.hexes.map((hex) => [hex.id, "unexplored" as FogStatus]));
}

export function createEmptySpottedUnits(): SpottedUnitsByOwner {
  return {
    Player: {},
    Enemy: {}
  };
}

export function updateFog(state: GameState): GameState {
  if (state.debugOptions?.noFogOfWar) {
    const visibleFog = Object.fromEntries(state.map.hexes.map((hex) => [hex.id, "visible" as FogStatus]));
    const allVisibleHexes = new Set(state.map.hexes.map((hex) => hex.id));
    return {
      ...state,
      fog: visibleFog,
      gates: updateGateIntel(state, allVisibleHexes),
      spottedUnits: updateSpottedUnits(state, {
        Player: allVisibleHexes,
        Enemy: allVisibleHexes
      })
    };
  }

  const playerVisibleHexes = getVisibleHexIdsForOwner(state, "Player");
  const enemyVisibleHexes = getVisibleHexIdsForOwner(state, "Enemy");

  const nextFog: Record<string, FogStatus> = {};
  for (const hex of state.map.hexes) {
    if (playerVisibleHexes.has(hex.id)) {
      nextFog[hex.id] = "visible";
      continue;
    }

    nextFog[hex.id] = state.fog[hex.id] === "visible" || state.fog[hex.id] === "fogged" ? "fogged" : "unexplored";
  }

  return {
    ...state,
    fog: nextFog,
    gates: updateGateIntel(state, playerVisibleHexes),
    spottedUnits: updateSpottedUnits(state, {
      Player: playerVisibleHexes,
      Enemy: enemyVisibleHexes
    })
  };
}

function updateGateIntel(state: GameState, playerVisibleHexes: Set<string>): GateState[] {
  return (state.gates ?? []).map((gate) =>
    playerVisibleHexes.has(hexId(gate.coord))
      ? {
          ...gate,
          knownOwner: gate.owner
        }
      : gate
  );
}

export function getVisibleHexIdsForOwner(state: GameState, owner: "Player" | "Enemy"): Set<string> {
  if (state.debugOptions?.noFogOfWar) {
    return new Set(state.map.hexes.map((hex) => hex.id));
  }

  const visibleHexes = new Set<string>();

  for (const unit of state.units) {
    if (unit.owner !== owner) {
      continue;
    }

    addUnitVisibleHexes(visibleHexes, state, unit);
  }

  addVisibleHexes(visibleHexes, state.map, state.bases[owner], 5);
  for (const gate of state.gates ?? []) {
    if (gate.owner === owner) {
      addGateVision(visibleHexes, state.map, gate);
    }
  }

  return visibleHexes;
}

function addVisibleHexes(target: Set<string>, map: GameMap, origin: HexCoord, radius: number): void {
  for (const hex of getHexesInRangeSearchBox(map, origin, radius)) {
    if (hexDistance(origin, hex.coord) <= radius) {
      target.add(hex.id);
    }
  }
}

function addUnitVisibleHexes(target: Set<string>, state: GameState, unit: { owner: Owner; type: SpottedUnit["type"]; level?: number; coord: HexCoord }): void {
  const stats = getEffectiveUnitStats(state, unit.owner, unit.type, unit.level, unit.coord);
  const originPenalty = getTerritoryRangePenalty(state, unit.owner, unit.coord);
  for (const hex of getHexesInRangeSearchBox(state.map, unit.coord, stats.visibilityRange)) {
    const targetPenalty = getTerritoryRangePenalty(state, unit.owner, hex.coord);
    const visibilityRange = Math.max(1, stats.visibilityRange - Math.max(0, targetPenalty - originPenalty));
    if (hexDistance(unit.coord, hex.coord) <= visibilityRange) {
      target.add(hex.id);
    }
  }
}

function updateSpottedUnits(state: GameState, visibleHexesByOwner: Record<Owner, Set<string>>): SpottedUnitsByOwner {
  const nextSpottedUnits: SpottedUnitsByOwner = {
    Player: { ...(state.spottedUnits?.Player ?? {}) },
    Enemy: { ...(state.spottedUnits?.Enemy ?? {}) }
  };
  const liveUnitIds = new Set(state.units.map((unit) => unit.id));

  for (const owner of ["Player", "Enemy"] as const) {
    for (const spottedUnitId of Object.keys(nextSpottedUnits[owner])) {
      if (state.day - nextSpottedUnits[owner][spottedUnitId].spottedDay > SPOTTED_UNIT_MEMORY_DAYS) {
        delete nextSpottedUnits[owner][spottedUnitId];
        continue;
      }

      if (!liveUnitIds.has(spottedUnitId)) {
        delete nextSpottedUnits[owner][spottedUnitId];
        continue;
      }

      const spottedUnit = nextSpottedUnits[owner][spottedUnitId];
      const currentUnit = state.units.find((unit) => unit.id === spottedUnitId);
      if (currentUnit && visibleHexesByOwner[owner].has(hexId(spottedUnit.coord)) && !sameHex(currentUnit.coord, spottedUnit.coord)) {
        delete nextSpottedUnits[owner][spottedUnitId];
      }
    }

    const visibleHexes = visibleHexesByOwner[owner];
    for (const unit of state.units) {
      if (unit.owner === owner || !visibleHexes.has(hexId(unit.coord))) {
        continue;
      }

      nextSpottedUnits[owner][unit.id] = {
        id: unit.id,
        owner: unit.owner,
        type: unit.type,
        level: getUnitInstanceLevel(state, unit),
        coord: { ...unit.coord },
        health: unit.health,
        maxHealth: unit.maxHealth,
        spottedDay: state.day
      } satisfies SpottedUnit;
    }
  }

  return nextSpottedUnits;
}

function addGateVision(target: Set<string>, map: GameMap, gate: GateState): void {
  addVisibleHexes(target, map, gate.coord, GATE_LOCAL_VISION_RADIUS);

  const sideWidth = Math.max(1, Math.floor(map.width * GATE_SIDE_VISION_WIDTH_RATIO));
  const sideHeight = Math.max(1, Math.floor(map.height * GATE_SIDE_VISION_HEIGHT_RATIO));
  const minRow = Math.max(0, Math.min(map.height - sideHeight, gate.coord.r - Math.floor(sideHeight / 2)));
  const maxRow = minRow + sideHeight - 1;

  for (const hex of map.hexes) {
    if (hex.coord.r < minRow || hex.coord.r > maxRow) {
      continue;
    }

    const onGateSide =
      gate.id === "West"
        ? hex.coord.q < sideWidth
        : hex.coord.q >= map.width - sideWidth;
    if (onGateSide) {
      target.add(hex.id);
    }
  }
}

function getHexesInRangeSearchBox(map: GameMap, origin: HexCoord, radius: number): HexTile[] {
  const hexes: HexTile[] = [];
  const minQ = Math.max(0, origin.q - radius);
  const maxQ = Math.min(map.width - 1, origin.q + radius);
  const minR = Math.max(0, origin.r - radius);
  const maxR = Math.min(map.height - 1, origin.r + radius);
  for (let r = minR; r <= maxR; r += 1) {
    for (let q = minQ; q <= maxQ; q += 1) {
      const coord = { q, r };
      const hex = getMapHexByOffset(map, coord);
      if (hex) {
        hexes.push(hex);
      }
    }
  }
  return hexes;
}

function getMapHexByOffset(map: GameMap, coord: HexCoord): HexTile | undefined {
  const offset = coord.r * map.width + coord.q;
  const hex = map.hexes.length === map.width * map.height ? map.hexes[offset] : undefined;
  if (hex?.coord.q === coord.q && hex.coord.r === coord.r) {
    return hex;
  }
  return getHex(map, coord);
}
