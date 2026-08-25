import { getBuildingDefinition } from "../data/buildingDefs";
import { getUnitDefinition } from "../data/unitDefs";
import { isUnitAvailableToOwnerInState } from "./factions";
import type { BuildingType, GameState, Owner, UnitType } from "./types";

export function ownerHasBuilding(state: GameState, owner: Owner, type: BuildingType): boolean {
  return state.buildings.some((building) => building.owner === owner && building.type === type);
}

export function canOwnerProduceUnit(state: GameState, owner: Owner, unitType: UnitType): boolean {
  if (!isUnitAvailableToOwner(unitType, owner, state)) {
    return false;
  }

  return state.buildings
    .filter((building) => building.owner === owner)
    .some((building) => getBuildingDefinition(building.type).produces.includes(unitType));
}

export function isUnitAvailableToOwner(unitType: UnitType, owner: Owner, state?: Pick<GameState, "playerFaction">): boolean {
  if (state) {
    return isUnitAvailableToOwnerInState(state, owner, unitType);
  }

  const availableTo = getUnitDefinition(unitType).availableTo;
  return !availableTo || availableTo.includes(owner);
}
