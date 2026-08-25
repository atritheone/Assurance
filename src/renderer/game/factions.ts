import { getUnitDefinition } from "../data/unitDefs";
import type { BuildingType, Faction, GameState, Owner, ResearchType, UnitType } from "./types";

export function getOpposingFaction(faction: Faction): Faction {
  return faction === "Empire" ? "Alliance" : "Empire";
}

export function getOwnerFaction(state: Pick<GameState, "playerFaction">, owner: Owner): Faction {
  const playerFaction = state.playerFaction ?? "Empire";
  return owner === "Player" ? playerFaction : getOpposingFaction(playerFaction);
}

export function getDefaultOwnerForFaction(faction: Faction): Owner {
  return faction === "Empire" ? "Player" : "Enemy";
}

export function getOwnerSideName(state: Pick<GameState, "playerFaction">, owner: Owner): "The Empire" | "The Alliance" {
  return getOwnerFaction(state, owner) === "Empire" ? "The Empire" : "The Alliance";
}

export function getOwnerSideAdjective(state: Pick<GameState, "playerFaction">, owner: Owner): "Imperial" | "Alliance" {
  return getOwnerFaction(state, owner) === "Empire" ? "Imperial" : "Alliance";
}

export function getOwnerBaseName(state: Pick<GameState, "playerFaction">, owner: Owner): "Empire Base" | "Alliance Base" {
  return getOwnerFaction(state, owner) === "Empire" ? "Empire Base" : "Alliance Base";
}

export function isUnitAvailableToFaction(unitType: UnitType, faction: Faction): boolean {
  const availableTo = getUnitDefinition(unitType).availableTo;
  return !availableTo || availableTo.includes(getDefaultOwnerForFaction(faction));
}

export function isUnitAvailableToOwnerInState(state: Pick<GameState, "playerFaction">, owner: Owner, unitType: UnitType): boolean {
  return isUnitAvailableToFaction(unitType, getOwnerFaction(state, owner));
}

export function getFactionEliteBuilding(faction: Faction): BuildingType {
  return faction === "Empire" ? "The Room" : "Drone Factory";
}

export function getFactionEliteResearch(faction: Faction): ResearchType {
  return faction === "Empire" ? "UnlockRoom" : "UnlockDroneFactory";
}

export function getFactionEliteUnit(faction: Faction): UnitType {
  return faction === "Empire" ? "Spectral" : "Reaper";
}

export function getOwnerEliteBuilding(state: Pick<GameState, "playerFaction">, owner: Owner): BuildingType {
  return getFactionEliteBuilding(getOwnerFaction(state, owner));
}

export function getOwnerEliteResearch(state: Pick<GameState, "playerFaction">, owner: Owner): ResearchType {
  return getFactionEliteResearch(getOwnerFaction(state, owner));
}

export function getOwnerEliteUnit(state: Pick<GameState, "playerFaction">, owner: Owner): UnitType {
  return getFactionEliteUnit(getOwnerFaction(state, owner));
}

export function normalizeFactionResearchType(state: Pick<GameState, "playerFaction">, owner: Owner, type: ResearchType): ResearchType {
  if (type !== "UnlockRoom" && type !== "UnlockDroneFactory") {
    return type;
  }

  return getOwnerEliteResearch(state, owner);
}
