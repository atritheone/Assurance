import assert from "node:assert/strict";
import { test } from "node:test";

import { getEffectiveUnitStats } from "../src/renderer/game/unitStats";
import { attackHexWithUnit, setDebugEnemyOwnerLogs } from "../src/renderer/game/engine";
import { createInitialState } from "../src/renderer/game/state";
import type { GameState, HexCoord, Owner, UnitInstance, UnitType } from "../src/renderer/game/types";
import { isHitLog, renderMapSelection } from "../src/renderer/ui/panels";

test("combat hit log styling accepts AI debug detail suffix", () => {
  assert.equal(isHitLog("Enemy Tank hit Player Infantry at 10,20 for 12."), true);
  assert.equal(isHitLog("Enemy Tank hit Player Infantry at 10,20 for 12. (mission: Attack; why: pressure)."), true);
  assert.equal(isHitLog("Enemy Tank hit Player Infantry at 10,20 for 12. (id: unit-1; target id: unit-2; mission: Attack)."), true);
  assert.equal(isHitLog("Enemy Tank missed Player Infantry at 10,20 (miss). (mission: Attack)."), true);
});

test("selected unit debug panel shows id and mission only in debug mode", () => {
  const state = createInitialState("log-ui-debug-selection");
  state.started = true;
  state.debugOptions.showAiUnits = true;
  const unit = addUnit(state, "Enemy", "Tank", { q: state.bases.Enemy.q, r: state.bases.Enemy.r + 1 });
  state.debugUnitMissions = {
    [unit.id]: "DefendGate"
  };
  state.selection = {
    selectedHexId: `${unit.coord.q},${unit.coord.r}`,
    selectedUnitId: unit.id
  };

  const debugTarget = createRenderTarget();
  renderMapSelection(debugTarget, state, { debugMode: true });
  assert.match(debugTarget.innerHTML, /<span>ID<\/span><strong>log-ui-unit-\d+<\/strong>/);
  assert.match(debugTarget.innerHTML, /<span>Mission<\/span><strong>DefendGate<\/strong>/);

  const normalTarget = createRenderTarget();
  renderMapSelection(normalTarget, state, { debugMode: false });
  assert.doesNotMatch(normalTarget.innerHTML, /<span>ID<\/span>/);
  assert.doesNotMatch(normalTarget.innerHTML, /<span>Mission<\/span>/);
});

test("debug unit action logs include unit ids", () => {
  const state = createInitialState("log-ui-debug-unit-logs");
  state.started = true;
  const unit = addUnit(state, "Player", "Infantry", { q: state.bases.Player.q, r: state.bases.Player.r });

  setDebugEnemyOwnerLogs(true);
  try {
    attackHexWithUnit(state, unit, state.bases.Enemy);
  } finally {
    setDebugEnemyOwnerLogs(false);
  }

  assert.match(state.log.at(-1)?.text ?? "", new RegExp(`\\(id: ${unit.id}\\)\\.$`));
});

function addUnit(state: GameState, owner: Owner, type: UnitType, coord: HexCoord): UnitInstance {
  const stats = getEffectiveUnitStats(state, owner, type);
  const unit: UnitInstance = {
    id: `log-ui-unit-${state.nextId}`,
    owner,
    type,
    level: owner === "Player" ? state.economy.unitLevels[type] : state.enemyEconomy.unitLevels[type],
    coord: { ...coord },
    health: stats.health,
    maxHealth: stats.health,
    placedDay: state.day,
    hasMovedThisDay: false,
    movementSpentThisDay: 0,
    hasAttackedThisDay: false
  };
  state.nextId += 1;
  state.units.push(unit);
  return unit;
}

function createRenderTarget(): HTMLElement {
  return {
    innerHTML: "",
    classList: {
      add() {},
      remove() {}
    }
  } as unknown as HTMLElement;
}
