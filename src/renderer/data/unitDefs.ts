import type { UnitDefinition, UnitType } from "../game/types";

export const UNIT_DEFINITIONS: UnitDefinition[] = [
  {
    type: "Infantry",
    label: "INF",
    health: 12,
    moveRange: 3,
    attackRange: 2,
    visibilityRange: 5,
    domain: "Ground",
    costPoundsBn: 4,
    gainValue: 4,
    productionDays: 1,
    producedBy: ["Barracks"],
    humanBased: true,
    attackProfile: {
      Infantry: "medium"
    }
  },
  {
    type: "Anti-Air",
    label: "AA",
    health: 12,
    moveRange: 3,
    attackRange: 5,
    visibilityRange: 6,
    domain: "Ground",
    costPoundsBn: 10,
    gainValue: 10,
    productionDays: 2,
    producedBy: ["Tank Factory"],
    humanBased: false,
    targetDomains: ["Air"],
    cannotMoveAndAttack: true,
    attackProfile: {
      "Attack Heli": "good",
      "Command Heli": "good",
      Jet: "good",
      Bomber: "good"
    }
  },
  {
    type: "IFV",
    label: "IFV",
    health: 20,
    moveRange: 5,
    attackRange: 3,
    visibilityRange: 8,
    domain: "Ground",
    costPoundsBn: 9,
    gainValue: 9,
    productionDays: 2,
    producedBy: ["Tank Factory"],
    humanBased: false,
    attackProfile: {
      Infantry: "good",
      IFV: "medium",
      Tank: "good"
    }
  },
  {
    type: "Supply Truck",
    label: "SUP",
    health: 20,
    moveRange: 5,
    attackRange: 0,
    visibilityRange: 8,
    domain: "Ground",
    costPoundsBn: 11,
    gainValue: 11,
    productionDays: 2,
    producedBy: ["Tank Factory"],
    humanBased: false,
    targetDomains: [],
    cannotAttack: true,
    attackProfile: {}
  },
  {
    type: "Artillery",
    label: "ART",
    health: 12,
    moveRange: 3,
    attackRange: 5,
    visibilityRange: 5,
    domain: "Ground",
    costPoundsBn: 10,
    gainValue: 10,
    productionDays: 2,
    producedBy: ["Tank Factory"],
    humanBased: false,
    targetDomains: ["Ground"],
    cannotMoveAndAttack: true,
    attackProfile: {
      Infantry: "good",
      "Anti-Air": "good",
      IFV: "good",
      Tank: "good"
    }
  },
  {
    type: "Tank",
    label: "TNK",
    health: 30,
    moveRange: 4,
    attackRange: 5,
    visibilityRange: 9,
    domain: "Ground",
    costPoundsBn: 20,
    gainValue: 20,
    productionDays: 3,
    producedBy: ["Tank Factory"],
    humanBased: false,
    attackProfile: {
      Infantry: "medium",
      "Anti-Air": "good",
      IFV: "good"
    }
  },
  {
    type: "Attack Heli",
    label: "AKH",
    health: 18,
    moveRange: 7,
    attackRange: 3,
    visibilityRange: 8,
    domain: "Air",
    costPoundsBn: 12,
    gainValue: 12,
    productionDays: 2,
    producedBy: ["Airfield"],
    humanBased: false,
    attackProfile: {
      Infantry: "medium",
      IFV: "good",
      Tank: "good"
    }
  },
  {
    type: "Command Heli",
    label: "CMH",
    health: 18,
    moveRange: 7,
    attackRange: 0,
    visibilityRange: 8,
    domain: "Air",
    costPoundsBn: 16,
    gainValue: 16,
    dailyGain: 1,
    productionDays: 2,
    producedBy: ["Airfield"],
    humanBased: false,
    targetDomains: [],
    cannotAttack: true,
    attackProfile: {}
  },
  {
    type: "Jet",
    label: "JET",
    health: 16,
    moveRange: 8,
    attackRange: 4,
    visibilityRange: 8,
    domain: "Air",
    costPoundsBn: 18,
    gainValue: 18,
    productionDays: 3,
    producedBy: ["Airfield"],
    humanBased: false,
    targetDomains: ["Air"],
    attackProfile: {
      "Attack Heli": "good",
      "Command Heli": "good",
      Jet: "medium",
      Bomber: "good"
    }
  },
  {
    type: "Bomber",
    label: "BMB",
    health: 22,
    moveRange: 7,
    attackRange: 6,
    visibilityRange: 8,
    domain: "Air",
    costPoundsBn: 26,
    gainValue: 26,
    productionDays: 4,
    producedBy: ["Airfield"],
    humanBased: false,
    targetDomains: ["Ground"],
    attackProfile: {
      Infantry: "good",
      "Anti-Air": "good",
      IFV: "good",
      Artillery: "good",
      Tank: "good",
      Operator: "good"
    }
  },
  {
    type: "Operator",
    label: "OPR",
    health: 22,
    damageBonus: 2,
    maxLevel: 3,
    moveRange: 5,
    attackRange: 5,
    visibilityRange: 9,
    domain: "Ground",
    costPoundsBn: 16,
    gainValue: 16,
    productionDays: 3,
    producedBy: ["Special Services"],
    humanBased: true,
    attackProfile: {
      Infantry: "good",
      "Anti-Air": "good",
      IFV: "good",
      Tank: "good",
      "Attack Heli": "good",
      "Command Heli": "good",
      Operator: "medium"
    }
  },
  {
    type: "Ghost",
    label: "GHO",
    health: 20,
    damageBonus: 2,
    maxLevel: 3,
    moveRange: 7,
    attackRange: 4,
    visibilityRange: 11,
    domain: "Ground",
    costPoundsBn: 24,
    gainValue: 24,
    productionDays: 4,
    producedBy: ["Special Services"],
    humanBased: true,
    attackProfile: {
      Infantry: "good",
      "Anti-Air": "good",
      IFV: "good",
      Ghost: "medium"
    }
  },
  {
    type: "Spectral",
    label: "SPC",
    health: 28,
    damageBonus: 3,
    maxLevel: 3,
    moveRange: 7,
    attackRange: 5,
    visibilityRange: 11,
    domain: "Ground",
    costPoundsBn: 35,
    gainValue: 35,
    productionDays: 5,
    producedBy: ["The Room"],
    humanBased: true,
    availableTo: ["Player"],
    attackProfile: {
      Infantry: "good",
      "Anti-Air": "good",
      IFV: "good",
      Operator: "good",
      Ghost: "good",
      Spectral: "medium"
    }
  },
  {
    type: "Reaper",
    label: "RPR",
    health: 34,
    damageBonus: 3,
    maxLevel: 3,
    moveRange: 8,
    attackRange: 8,
    visibilityRange: 11,
    domain: "Air",
    costPoundsBn: 35,
    gainValue: 35,
    productionDays: 6,
    producedBy: ["Drone Factory"],
    humanBased: false,
    availableTo: ["Enemy"],
    attackProfile: {
      Infantry: "good",
      "Anti-Air": "good",
      Artillery: "good",
      IFV: "good",
      Tank: "good",
      "Attack Heli": "good",
      "Command Heli": "good",
      Jet: "good",
      Bomber: "good",
      Operator: "good",
      Ghost: "medium",
      Spectral: "medium",
      Reaper: "medium"
    }
  }
];

export function getUnitDefinition(type: UnitType): UnitDefinition {
  const definition = UNIT_DEFINITIONS.find((unit) => unit.type === type);
  if (!definition) {
    throw new Error(`Unknown unit type: ${type}`);
  }
  return definition;
}
