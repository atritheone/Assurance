import type { EnemyUnitLogDetail, GameState, LogEntry, UnitInstance } from "./types";

export interface MovementLogVisibility {
  fromVisible: boolean;
  toVisible: boolean;
}

export function appendLog(state: GameState, text: string): LogEntry {
  const entry: LogEntry = {
    id: state.nextLogId,
    day: state.day,
    text
  };
  state.nextLogId += 1;
  state.log = [...state.log, entry];
  return entry;
}

export function formatUnitRepairLog(unit: UnitInstance, location: string, amount: number, detail?: EnemyUnitLogDetail): string {
  return `${unit.owner} ${unit.type} repaired ${amount} HP at ${location} (${unit.health}/${unit.maxHealth}).${formatEnemyUnitLogDetail(detail)}`;
}

export function formatUnitMovementLog(
  unit: UnitInstance,
  from: string,
  to: string,
  visibility: MovementLogVisibility,
  detail?: EnemyUnitLogDetail
): string | null {
  if (!visibility.fromVisible && !visibility.toVisible) {
    return null;
  }

  const suffix = formatEnemyUnitLogDetail(detail);
  if (visibility.fromVisible && visibility.toVisible) {
    return `${unit.owner} ${unit.type} moved from ${from} to ${to}.${suffix}`;
  }

  if (visibility.fromVisible) {
    return `${unit.owner} ${unit.type} moved from ${from}.${suffix}`;
  }

  return `${unit.owner} ${unit.type} moved to ${to}.${suffix}`;
}

export function formatEnemyUnitLogDetail(detail?: EnemyUnitLogDetail): string {
  const parts = [
    detail?.unitId ? `id: ${detail.unitId}` : null,
    detail?.targetId ? `target id: ${detail.targetId}` : null,
    detail?.mission ? `mission: ${detail.mission}` : null,
    detail?.why ? `why: ${detail.why}` : null
  ].filter((part): part is string => Boolean(part));

  return parts.length ? ` (${parts.join("; ")}).` : "";
}
