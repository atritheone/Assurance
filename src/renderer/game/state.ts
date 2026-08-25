import { createEmptyUnitLevelInventory, createStartingEconomy, createStartingInventory } from "./economy";
import { getDefaultOwnerForFaction, getOpposingFaction } from "./factions";
import { createEmptySpottedUnits, createUnexploredFog, updateFog } from "./fog";
import { generateHexMap } from "./map";
import type { BuildingInstance, BuildingType, DebugOptions, Faction, GameState, GateState, HexCoord, Owner, SideStartOptions, StartOptions, UnitType } from "./types";

function makeBuilding(id: string, owner: "Player" | "Enemy", type: BuildingInstance["type"]): BuildingInstance {
  return { id, owner, type };
}

const STARTING_BUILDINGS: Record<Owner, BuildingType[]> = {
  Player: ["Barracks", "Tank Factory", "Airfield"],
  Enemy: ["Barracks", "Tank Factory", "Airfield"]
};

export const UNLOCKABLE_START_BUILDINGS: Record<Owner, BuildingType[]> = {
  Player: ["Special Services", "The Room"],
  Enemy: ["Special Services", "Drone Factory"]
};

export function createDefaultDebugOptions(): DebugOptions {
  return {
    showAiUnits: false,
    noFogOfWar: false,
    Player: {
      noDamage: false,
      unlimitedMovement: false,
      unlimitedAttackRange: false
    },
    Enemy: {
      noDamage: false,
      unlimitedMovement: false,
      unlimitedAttackRange: false
    }
  };
}

export function createDefaultSideStartOptions(owner: Owner): SideStartOptions {
  const economy = createStartingEconomy(owner);
  return {
    moneyPoundsBn: economy.moneyPoundsBn,
    incomePoundsBn: economy.incomePoundsBn,
    efficiencyLevel: economy.efficiencyLevel,
    productionCapacityLevel: economy.productionCapacityLevel,
    researchCapacityLevel: economy.researchCapacityLevel,
    productionSpeedLevel: economy.productionSpeedLevel,
    researchSpeedLevel: economy.researchSpeedLevel,
    inventory: createStartingInventory(owner),
    unlockedBuildings: []
  };
}

export function createDefaultStartOptions(): StartOptions {
  return {
    difficulty: "Hard",
    playerFaction: "Empire",
    Player: createDefaultSideStartOptions("Player"),
    Enemy: createDefaultSideStartOptions("Enemy")
  };
}

export function createDefaultStartOptionsForPlayerFaction(playerFaction: Faction): StartOptions {
  return {
    difficulty: "Hard",
    playerFaction,
    Player: createDefaultSideStartOptions(getDefaultOwnerForFaction(playerFaction)),
    Enemy: createDefaultSideStartOptions(getDefaultOwnerForFaction(getOpposingFaction(playerFaction)))
  };
}

export function createGates(mapWidth: number, mapHeight: number): GateState[] {
  const centerRow = Math.floor(mapHeight / 2);
  const inset = Math.min(3, Math.floor((mapWidth - 1) / 2));
  return [
    {
      id: "West",
      label: "West Gate",
      coord: { q: inset, r: centerRow },
      owner: null,
      knownOwner: null,
      occupation: { Player: 0, Enemy: 0 }
    },
    {
      id: "East",
      label: "East Gate",
      coord: { q: mapWidth - 1 - inset, r: centerRow },
      owner: null,
      knownOwner: null,
      occupation: { Player: 0, Enemy: 0 }
    }
  ];
}

export function createInitialState(seed = "assurance-prototype", startOptions = createDefaultStartOptions()): GameState {
  const map = generateHexMap(29, 39);
  const playerBase: HexCoord = { q: Math.floor(map.width / 2), r: map.height - 1 };
  const enemyBase: HexCoord = { q: Math.floor(map.width / 2), r: 0 };
  const buildings = createStartingBuildings(startOptions);
  const economy = createStartingEconomy("Player");
  const enemyEconomy = createStartingEconomy("Enemy");
  applySideStartOptions(economy, startOptions.Player);
  applySideStartOptions(enemyEconomy, startOptions.Enemy);
  const state: GameState = {
    title: "Assurance",
    started: false,
    paused: true,
    day: 1,
    seed,
    map,
    bases: {
      Player: playerBase,
      Enemy: enemyBase
    },
    baseOccupation: {
      Player: 0,
      Enemy: 0
    },
    gates: createGates(map.width, map.height),
    fog: createUnexploredFog(map),
    spottedUnits: createEmptySpottedUnits(),
    units: [],
    buildings,
    economy,
    enemyEconomy,
    selection: {
      selectedHexId: null,
      selectedUnitId: null
    },
    log: [],
    winner: null,
    difficulty: startOptions.difficulty,
    playerFaction: startOptions.playerFaction ?? "Empire",
    openingEnemyTurnPending: false,
    enemyActedBeforePlayerThisDay: false,
    debugOptions: createDefaultDebugOptions(),
    debugUnitMissions: {},
    nextId: buildings.length + 1,
    nextLogId: 1
  };

  return updateFog(state);
}

export function cloneState(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

function createStartingBuildings(startOptions: StartOptions): BuildingInstance[] {
  let nextId = 1;
  const buildings: BuildingInstance[] = [];
  for (const owner of ["Player", "Enemy"] as const) {
    const uniqueBuildings = [...new Set([...STARTING_BUILDINGS[owner], ...startOptions[owner].unlockedBuildings])];
    for (const buildingType of uniqueBuildings) {
      buildings.push(makeBuilding(`building-${nextId}`, owner, buildingType));
      nextId += 1;
    }
  }
  return buildings;
}

function applySideStartOptions(economy: ReturnType<typeof createStartingEconomy>, options: SideStartOptions): void {
  economy.moneyPoundsBn = options.moneyPoundsBn;
  economy.incomePoundsBn = options.incomePoundsBn;
  economy.efficiencyLevel = options.efficiencyLevel;
  economy.productionCapacityLevel = options.productionCapacityLevel;
  economy.researchCapacityLevel = options.researchCapacityLevel;
  economy.productionSpeedLevel = options.productionSpeedLevel;
  economy.researchSpeedLevel = options.researchSpeedLevel;
  economy.inventory = { ...economy.inventory, ...options.inventory };
  economy.inventoryByLevel = createEmptyUnitLevelInventory();
  for (const [unitType, count] of Object.entries(economy.inventory) as [UnitType, number][]) {
    if (count > 0) {
      economy.inventoryByLevel[unitType][1] = count;
    }
  }
}
