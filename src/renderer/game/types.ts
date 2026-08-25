export interface HexCoord {
  q: number;
  r: number;
}

export type Owner = "Player" | "Enemy";

export type Faction = "Empire" | "Alliance";

export type Difficulty = "Easy" | "Medium" | "Hard";

export type HexTerrain = "open";

export type FogStatus = "unexplored" | "fogged" | "visible";

export type UnitDomain = "Ground" | "Air";

export type AttackEffectiveness = "weak" | "medium" | "good";

export type UnitType =
  | "Infantry"
  | "Anti-Air"
  | "Artillery"
  | "IFV"
  | "Supply Truck"
  | "Tank"
  | "Attack Heli"
  | "Command Heli"
  | "Jet"
  | "Bomber"
  | "Operator"
  | "Ghost"
  | "Spectral"
  | "Reaper";

export type BuildingType = "Barracks" | "Tank Factory" | "Airfield" | "Special Services" | "The Room" | "Drone Factory";

export type ResearchType =
  | "UnitUpgrade"
  | "UnlockSpecialServices"
  | "UnlockRoom"
  | "UnlockDroneFactory"
  | "Efficiency"
  | "ProductionCapacity"
  | "ResearchCapacity"
  | "ProductionSpeed"
  | "ResearchSpeed";

export type PurchaseCurrency = "funds" | "gain";

export interface HexTile {
  id: string;
  coord: HexCoord;
  terrain: HexTerrain;
  passable: boolean;
}

export interface GameMap {
  width: number;
  height: number;
  hexes: HexTile[];
  hexesById?: Record<string, HexTile>;
  neighborCoordsById?: Record<string, HexCoord[]>;
}

export interface UnitDefinition {
  type: UnitType;
  label: string;
  health: number;
  damageBonus?: number;
  maxLevel?: number;
  moveRange: number;
  attackRange: number;
  visibilityRange: number;
  domain: UnitDomain;
  costPoundsBn: number;
  gainValue: number;
  dailyGain?: number;
  productionDays: number;
  producedBy: BuildingType[];
  humanBased: boolean;
  availableTo?: Owner[];
  targetDomains?: UnitDomain[];
  cannotMoveAndAttack?: boolean;
  cannotAttack?: boolean;
  attackProfile: Partial<Record<UnitType, AttackEffectiveness>>;
}

export interface QueuedMovement {
  destination: HexCoord;
  path: HexCoord[];
  createdDay: number;
}

export interface SideStartOptions {
  moneyPoundsBn: number;
  incomePoundsBn: number;
  efficiencyLevel: number;
  productionCapacityLevel: number;
  researchCapacityLevel: number;
  productionSpeedLevel: number;
  researchSpeedLevel: number;
  inventory: UnitInventory;
  unlockedBuildings: BuildingType[];
}

export interface StartOptions {
  difficulty: Difficulty;
  playerFaction: Faction;
  Player: SideStartOptions;
  Enemy: SideStartOptions;
}

export interface BuildingDefinition {
  type: BuildingType;
  label: string;
  produces: UnitType[];
}

export interface UnitInstance {
  id: string;
  owner: Owner;
  type: UnitType;
  level: number;
  coord: HexCoord;
  health: number;
  maxHealth: number;
  placedDay: number;
  hasMovedThisDay: boolean;
  movementSpentThisDay: number;
  hasAttackedThisDay: boolean;
  hasProvidedPlacementThisDay?: boolean;
  queuedMovement?: QueuedMovement;
}

export interface SpottedUnit {
  id: string;
  owner: Owner;
  type: UnitType;
  level?: number;
  coord: HexCoord;
  health: number;
  maxHealth: number;
  spottedDay: number;
}

export type SpottedUnitsByOwner = Record<Owner, Record<string, SpottedUnit>>;

export interface EnemyMovementTrail {
  unitId: string;
  unitType: UnitType;
  coords: HexCoord[];
}

export interface EnemyUnitLogDetail {
  unitId?: string;
  targetId?: string;
  mission?: string;
  why?: string;
}

export interface BuildingInstance {
  id: string;
  owner: Owner;
  type: BuildingType;
}

export type UnitInventory = Record<UnitType, number>;
export type UnitLevelInventory = Record<UnitType, Record<number, number>>;
export type UnitLevels = Record<UnitType, number>;

export interface ProductionJob {
  id: string;
  owner: Owner;
  unitType: UnitType;
  unitLevel?: number;
  startedDay: number;
  availableDay: number;
}

export interface ResearchJob {
  id: string;
  owner: Owner;
  type: ResearchType;
  unitType?: UnitType;
  targetLevel?: number;
  startedDay: number;
  completeDay: number;
}

export interface EconomyState {
  moneyPoundsBn: number;
  gainPoints: number;
  incomePoundsBn: number;
  inventory: UnitInventory;
  inventoryByLevel?: UnitLevelInventory;
  productionQueue: ProductionJob[];
  lastProductionUnitType?: UnitType;
  researchQueue: ResearchJob[];
  unitLevels: UnitLevels;
  efficiencyLevel: number;
  productionCapacityLevel: number;
  researchCapacityLevel: number;
  productionSpeedLevel: number;
  researchSpeedLevel: number;
}

export interface DebugSideOptions {
  noDamage: boolean;
  unlimitedMovement: boolean;
  unlimitedAttackRange: boolean;
}

export interface DebugOptions {
  showAiUnits: boolean;
  noFogOfWar: boolean;
  Player: DebugSideOptions;
  Enemy: DebugSideOptions;
}

export type DebugSideOption = keyof DebugSideOptions;
export type DebugGlobalOption = "showAiUnits" | "noFogOfWar";
export type DebugEconomyField =
  | "moneyPoundsBn"
  | "gainPoints"
  | "incomePoundsBn"
  | "efficiencyLevel"
  | "productionCapacityLevel"
  | "productionSpeedLevel"
  | "researchCapacityLevel"
  | "researchSpeedLevel";

export interface BaseState {
  Player: HexCoord;
  Enemy: HexCoord;
}

export interface BaseOccupationState {
  Player: number;
  Enemy: number;
}

export type GateId = "West" | "East";

export interface GateState {
  id: GateId;
  label: string;
  coord: HexCoord;
  owner: Owner | null;
  knownOwner: Owner | null;
  occupation: BaseOccupationState;
}

export interface SelectionState {
  selectedHexId: string | null;
  selectedUnitId: string | null;
}

export interface LogEntry {
  id: number;
  day: number;
  text: string;
}

export interface GameState {
  title: "Assurance";
  started: boolean;
  paused: boolean;
  day: number;
  seed: string;
  map: GameMap;
  bases: BaseState;
  baseOccupation: BaseOccupationState;
  gates: GateState[];
  fog: Record<string, FogStatus>;
  spottedUnits: SpottedUnitsByOwner;
  units: UnitInstance[];
  buildings: BuildingInstance[];
  economy: EconomyState;
  enemyEconomy: EconomyState;
  selection: SelectionState;
  log: LogEntry[];
  winner: Owner | null;
  difficulty: Difficulty;
  playerFaction: Faction;
  openingEnemyTurnPending: boolean;
  enemyActedBeforePlayerThisDay: boolean;
  debugOptions: DebugOptions;
  debugUnitMissions?: Record<string, string>;
  nextId: number;
  nextLogId: number;
}

export type GameCommand =
  | { type: "START_SIMULATION"; seed?: string }
  | { type: "RUN_OPENING_ENEMY_TURN" }
  | { type: "END_TURN" }
  | { type: "DESELECT" }
  | { type: "SELECT_HEX"; coord: HexCoord }
  | { type: "SELECT_UNIT"; unitId: string }
  | { type: "MOVE_UNIT"; unitId: string; to: HexCoord }
  | { type: "CANCEL_QUEUED_MOVEMENT"; unitId: string }
  | { type: "ATTACK_HEX"; unitId: string; at: HexCoord }
  | { type: "PLACE_UNIT"; unitType: UnitType; at: HexCoord; unitLevel?: number }
  | { type: "UPGRADE_FIELD_UNIT"; unitId: string; currency?: PurchaseCurrency }
  | { type: "START_PRODUCTION"; unitType: UnitType }
  | { type: "START_RESEARCH"; researchType: ResearchType; unitType?: UnitType }
  | { type: "INSTANT_PRODUCTION"; unitType: UnitType }
  | { type: "INSTANT_RESEARCH"; researchType: ResearchType; unitType?: UnitType }
  | { type: "FINISH_PRODUCTION"; jobId: string }
  | { type: "FINISH_RESEARCH"; jobId: string }
  | { type: "CANCEL_PRODUCTION"; jobId: string }
  | { type: "CANCEL_RESEARCH"; jobId: string }
  | { type: "TOGGLE_PAUSE" }
  | { type: "SET_DEBUG_GLOBAL_OPTION"; option: DebugGlobalOption; enabled: boolean }
  | { type: "SET_DEBUG_SIDE_OPTION"; owner: Owner; option: DebugSideOption; enabled: boolean }
  | { type: "DEBUG_ADJUST_FUNDS"; owner: Owner; amount: number }
  | { type: "DEBUG_SET_ECONOMY_FIELD"; owner: Owner; field: DebugEconomyField; value: number }
  | { type: "DEBUG_SET_UNIT_LEVEL"; owner: Owner; unitType: UnitType; level: number }
  | { type: "DEBUG_ADD_UNIT_MATERIAL"; owner: Owner; unitType: UnitType; level?: number; count?: number };

export interface EngineResult {
  state: GameState;
  logEntries: LogEntry[];
  enemyMovementTrails: EnemyMovementTrail[];
}
