import type { DebugEconomyField, DebugGlobalOption, DebugSideOption, GameCommand, HexCoord, Owner, PurchaseCurrency, ResearchType, UnitType } from "./types";

export const Commands = {
  startSimulation(seed?: string): GameCommand {
    return { type: "START_SIMULATION", seed };
  },
  runOpeningEnemyTurn(): GameCommand {
    return { type: "RUN_OPENING_ENEMY_TURN" };
  },
  endTurn(): GameCommand {
    return { type: "END_TURN" };
  },
  deselect(): GameCommand {
    return { type: "DESELECT" };
  },
  selectHex(coord: HexCoord): GameCommand {
    return { type: "SELECT_HEX", coord };
  },
  selectUnit(unitId: string): GameCommand {
    return { type: "SELECT_UNIT", unitId };
  },
  moveUnit(unitId: string, to: HexCoord): GameCommand {
    return { type: "MOVE_UNIT", unitId, to };
  },
  cancelQueuedMovement(unitId: string): GameCommand {
    return { type: "CANCEL_QUEUED_MOVEMENT", unitId };
  },
  attackHex(unitId: string, at: HexCoord): GameCommand {
    return { type: "ATTACK_HEX", unitId, at };
  },
  placeUnit(unitType: UnitType, at: HexCoord, unitLevel?: number): GameCommand {
    return { type: "PLACE_UNIT", unitType, at, unitLevel };
  },
  upgradeFieldUnit(unitId: string, currency: PurchaseCurrency = "funds"): GameCommand {
    return { type: "UPGRADE_FIELD_UNIT", unitId, currency };
  },
  startProduction(unitType: UnitType): GameCommand {
    return { type: "START_PRODUCTION", unitType };
  },
  startResearch(researchType: ResearchType, unitType?: UnitType): GameCommand {
    return { type: "START_RESEARCH", researchType, unitType };
  },
  instantProduction(unitType: UnitType): GameCommand {
    return { type: "INSTANT_PRODUCTION", unitType };
  },
  instantResearch(researchType: ResearchType, unitType?: UnitType): GameCommand {
    return { type: "INSTANT_RESEARCH", researchType, unitType };
  },
  finishProduction(jobId: string): GameCommand {
    return { type: "FINISH_PRODUCTION", jobId };
  },
  finishResearch(jobId: string): GameCommand {
    return { type: "FINISH_RESEARCH", jobId };
  },
  cancelProduction(jobId: string): GameCommand {
    return { type: "CANCEL_PRODUCTION", jobId };
  },
  cancelResearch(jobId: string): GameCommand {
    return { type: "CANCEL_RESEARCH", jobId };
  },
  togglePause(): GameCommand {
    return { type: "TOGGLE_PAUSE" };
  },
  setDebugGlobalOption(option: DebugGlobalOption, enabled: boolean): GameCommand {
    return { type: "SET_DEBUG_GLOBAL_OPTION", option, enabled };
  },
  setDebugSideOption(owner: Owner, option: DebugSideOption, enabled: boolean): GameCommand {
    return { type: "SET_DEBUG_SIDE_OPTION", owner, option, enabled };
  },
  debugAdjustFunds(owner: Owner, amount: number): GameCommand {
    return { type: "DEBUG_ADJUST_FUNDS", owner, amount };
  },
  debugSetEconomyField(owner: Owner, field: DebugEconomyField, value: number): GameCommand {
    return { type: "DEBUG_SET_ECONOMY_FIELD", owner, field, value };
  },
  debugSetUnitLevel(owner: Owner, unitType: UnitType, level: number): GameCommand {
    return { type: "DEBUG_SET_UNIT_LEVEL", owner, unitType, level };
  },
  debugAddUnitMaterial(owner: Owner, unitType: UnitType, level?: number, count?: number): GameCommand {
    return { type: "DEBUG_ADD_UNIT_MATERIAL", owner, unitType, level, count };
  }
};
