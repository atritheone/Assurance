import type { BuildingDefinition, BuildingType } from "../game/types";

export const BUILDING_DEFINITIONS: BuildingDefinition[] = [
  { type: "Barracks", label: "BRK", produces: ["Infantry"] },
  { type: "Tank Factory", label: "TNF", produces: ["Supply Truck", "Artillery", "Anti-Air", "IFV", "Tank"] },
  { type: "Airfield", label: "AIR", produces: ["Attack Heli", "Command Heli", "Jet", "Bomber"] },
  { type: "Special Services", label: "SPC", produces: ["Operator", "Ghost"] },
  { type: "The Room", label: "ROM", produces: ["Spectral"] },
  { type: "Drone Factory", label: "DRN", produces: ["Reaper"] }
];

export function getBuildingDefinition(type: BuildingType): BuildingDefinition {
  const definition = BUILDING_DEFINITIONS.find((building) => building.type === type);
  if (!definition) {
    throw new Error(`Unknown building type: ${type}`);
  }
  return definition;
}
