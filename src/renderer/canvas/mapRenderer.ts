import { getUnitDefinition } from "../data/unitDefs";
import { getOwnerFaction } from "../game/factions";
import { displayHexId, hexDistance, hexId, sameHex } from "../game/map";
import { getBattlefieldArea } from "../game/territory";
import { getUnitInstanceLevel } from "../game/unitStats";
import { canPlacePlayerUnitAt, canSupplyTruckEnablePlacement, canUnitAttackThisDay, getAttackRangeHexIds, getFrontLineRows, getQueuedMovementStopPathIndexes, getReachableHexIds, getRemainingMovementPoints, getSelectedUnit, getUnitDomain, isSupplyPlacementProvider, ownerControlsBothGates, SUPPLY_TRUCK_PLACEMENT_RANGE, SUPPLY_TRUCK_REPAIR_RANGE } from "../game/units";
import type { GameState, GateState, HexCoord, HexTile, Owner, SpottedUnit, UnitInstance, UnitType } from "../game/types";
import { axialToPixel, hexCorners, type MapView } from "./hexMath";

const UI_FONT = '"Assurance Cascadia Mono", "Cascadia Mono", Consolas, monospace';
const RANGE_STROKE_WIDTH = 3;
const ROMAN_LEVELS = ["", "I", "II", "III", "IV", "V"];
const PLAYER_CAPTURE_COLOR = "#3b78ff";
const ENEMY_CAPTURE_COLOR = "#d22b2b";
const VISIBLE_HEX_BORDER_COLOR = "#1fb152";
const ENEMY_TRAIL_HEX_BORDER_COLOR = "#b11f1f";
const AREA_COPY_FILL_ALPHA = 0.68;
const AREA_COPY_OFFSET_RATIO = 0.16;
const GATE_CAPTURE_DAYS = 2;
const BASE_CAPTURE_DAYS = 4;

export type CombatVisualEffect = UnitCombatVisualEffect | EnemyMovementTrailVisualEffect;

export interface TurnAttentionRegion {
  top: HexCoord;
  bottom: HexCoord;
  left: HexCoord;
  right: HexCoord;
}

export interface UnitCombatVisualEffect {
  id: number;
  type: "hit" | "destroyed";
  coord: HexCoord;
  owner: Owner;
  unitType: UnitType;
  startedAt: number;
  durationMs: number;
}

export interface EnemyMovementTrailVisualEffect {
  id: number;
  type: "enemy-trail";
  coords: HexCoord[];
  baseBorderColorsByHexId: Record<string, string>;
  startedAt: number;
  durationMs: number;
}

interface RenderLookups {
  gatesByHexId: Map<string, GateState>;
  groundUnitCountsByHexId: Map<string, number>;
  hitEffectsByUnitKey: Map<string, CombatVisualEffect[]>;
}

interface EnemyTrailRenderState {
  intensity: number;
  baseBorderColor?: string;
}

interface RangeOverlayStyle {
  fill: string | null;
  stroke: string;
}

const MOVEMENT_RANGE_STYLE: RangeOverlayStyle = { fill: "rgba(52, 255, 114, 0.18)", stroke: "#34ff72" };
const ATTACK_RANGE_STYLE: RangeOverlayStyle = { fill: null, stroke: "#ff3030" };
const SUPPLY_REPAIR_RANGE_STYLE: RangeOverlayStyle = { fill: "rgba(255, 218, 64, 0.18)", stroke: "#ffda40" };
const SUPPLY_PLACEMENT_RANGE_STYLE: RangeOverlayStyle = { fill: "rgba(255, 138, 34, 0.18)", stroke: "#ff8a22" };
const UNIT_PLACEMENT_STYLE: RangeOverlayStyle = { fill: "rgba(255, 255, 255, 0.16)", stroke: "#ffffff" };

export function getHexBorderColors(state: GameState): Record<string, string> {
  const gatesByHexId = getGatesByHexId(state);
  return Object.fromEntries(
    state.map.hexes.map((hex) => [
      hex.id,
      getHexBaseStrokeStyle(state, hex, state.fog[hex.id], gatesByHexId.get(hex.id))
    ])
  );
}

export function renderMap(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  state: GameState,
  view: MapView,
  effects: CombatVisualEffect[] = [],
  now = performance.now(),
  hoveredCoord: HexCoord | null = null,
  placementUnitType: UnitType | null = null,
  debugMode = false
): void {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const selectedUnit = getSelectedUnit(state);
  const movementRange = selectedUnit ? getReachableHexIds(state, selectedUnit) : new Set<string>();
  const attackRange = selectedUnit ? getAttackRangeHexIds(state, selectedUnit) : new Set<string>();
  const supplyRepairRange = selectedUnit ? getSupplyTruckRepairRangeHexIds(state, selectedUnit) : new Set<string>();
  const supplyPlacementRange = selectedUnit ? getSupplyTruckPlacementRangeHexIds(state, selectedUnit) : new Set<string>();
  const unitPlacementRange = placementUnitType ? getPlayerUnitPlacementHexIds(state, placementUnitType) : new Set<string>();
  const lookups = buildRenderLookups(state, effects);
  const enemyTrailStates = getActiveEnemyTrailStates(effects, now);

  context.clearRect(0, 0, width, height);
  context.fillStyle = "#000000";
  context.fillRect(0, 0, width, height);

  drawAreaCopyUnderlay(context, view, state);

  for (const hex of state.map.hexes) {
    drawHex(context, view, state, hex, movementRange, attackRange, supplyRepairRange, supplyPlacementRange, unitPlacementRange, enemyTrailStates, lookups);
  }

  drawBases(context, view, state);
  drawGates(context, view, state);
  drawQueuedMovementPaths(context, view, state);
  drawUnits(context, view, state, lookups, now, debugMode);
  drawCombatEffects(context, view, effects, now);
  drawHoverCoord(context, state, width, height, hoveredCoord);
}

function buildRenderLookups(state: GameState, effects: CombatVisualEffect[]): RenderLookups {
  const gatesByHexId = getGatesByHexId(state);

  const groundUnitCountsByHexId = new Map<string, number>();
  for (const unit of state.units) {
    if (getUnitDomain(unit.type) !== "Ground") {
      continue;
    }

    const id = hexId(unit.coord);
    groundUnitCountsByHexId.set(id, (groundUnitCountsByHexId.get(id) ?? 0) + 1);
  }

  const hitEffectsByUnitKey = new Map<string, CombatVisualEffect[]>();
  for (const effect of effects) {
    if (effect.type !== "hit") {
      continue;
    }

    const key = unitEffectKey(effect.owner, effect.unitType, effect.coord);
    const existing = hitEffectsByUnitKey.get(key);
    if (existing) {
      existing.push(effect);
    } else {
      hitEffectsByUnitKey.set(key, [effect]);
    }
  }

  return { gatesByHexId, groundUnitCountsByHexId, hitEffectsByUnitKey };
}

function getGatesByHexId(state: GameState): Map<string, GateState> {
  const gatesByHexId = new Map<string, GateState>();
  for (const gate of state.gates ?? []) {
    gatesByHexId.set(hexId(gate.coord), gate);
  }
  return gatesByHexId;
}

function drawHoverCoord(
  context: CanvasRenderingContext2D,
  state: GameState,
  width: number,
  height: number,
  hoveredCoord: HexCoord | null
): void {
  if (!state.started || !hoveredCoord) {
    return;
  }

  context.save();
  context.fillStyle = "#a8a8a8";
  context.font = `12px ${UI_FONT}`;
  context.textAlign = "right";
  context.textBaseline = "bottom";
  context.fillText(displayHexId(state.map, hoveredCoord), width - 12, height - 12);
  context.restore();
}

function drawHex(
  context: CanvasRenderingContext2D,
  view: MapView,
  state: GameState,
  hex: HexTile,
  movementRange: Set<string>,
  attackRange: Set<string>,
  supplyRepairRange: Set<string>,
  supplyPlacementRange: Set<string>,
  unitPlacementRange: Set<string>,
  enemyTrailStates: Map<string, EnemyTrailRenderState>,
  lookups: RenderLookups
): void {
  const fogStatus = state.fog[hex.id];
  const center = axialToPixel(hex.coord, view);
  const corners = hexCorners(center, view.hexSize - 1);
  const selected = state.selection.selectedHexId === hex.id;
  const reachable = movementRange.has(hex.id);
  const inAttackRange = attackRange.has(hex.id);
  const inSupplyRepairRange = supplyRepairRange.has(hex.id);
  const inSupplyPlacementRange = supplyPlacementRange.has(hex.id);
  const inUnitPlacementRange = unitPlacementRange.has(hex.id);
  const enemyTrailState = enemyTrailStates.get(hex.id);
  const enemyTrailIntensity = enemyTrailState?.intensity ?? 0;
  const baseOwner = sameHex(hex.coord, state.bases.Player) ? "Player" : sameHex(hex.coord, state.bases.Enemy) ? "Enemy" : null;
  const gate = lookups.gatesByHexId.get(hex.id);
  const gateOwner = getDisplayGateOwner(gate, fogStatus);
  let fillStyle = "#000000";
  let strokeStyle = VISIBLE_HEX_BORDER_COLOR;

  traceHex(context, corners);

  if (baseOwner === "Player") {
    fillStyle = getOwnerCaptureColor(state, "Player");
    strokeStyle = "#ffffff";
  } else if (baseOwner === "Enemy") {
    fillStyle = getOwnerCaptureColor(state, "Enemy");
    strokeStyle = "#ffffff";
  } else if (gateOwner === "Player") {
    fillStyle = getOwnerCaptureColor(state, "Player");
    strokeStyle = "#9fbeff";
  } else if (gateOwner === "Enemy") {
    fillStyle = getOwnerCaptureColor(state, "Enemy");
    strokeStyle = "#ffb2a8";
  } else if (gate) {
    fillStyle = "#d8c945";
    strokeStyle = "#fff6a0";
  } else if (fogStatus === "visible") {
    fillStyle = getAreaTintOwner(state, hex) ? "#151515" : "#000000";
    strokeStyle = VISIBLE_HEX_BORDER_COLOR;
  } else if (fogStatus === "fogged") {
    fillStyle = "#151515";
    strokeStyle = "#8a8a8a";
  } else {
    fillStyle = "#0c0c0c";
    strokeStyle = "#606060";
  }
  if (enemyTrailIntensity > 0) {
    strokeStyle = blendHexColors(enemyTrailState?.baseBorderColor ?? strokeStyle, ENEMY_TRAIL_HEX_BORDER_COLOR, enemyTrailIntensity);
  }
  context.fillStyle = fillStyle;
  context.fill();
  drawCaptureProgress(context, corners, center, getCaptureProgress(state, baseOwner, fogStatus === "visible" ? gate : undefined));
  drawHexBorder(context, corners, strokeStyle, baseOwner || gate ? 1.5 : 1, getFrontLineEdgeColors(state, hex));

  drawRangeOverlays(context, corners, center, [
    reachable ? MOVEMENT_RANGE_STYLE : null,
    inAttackRange ? ATTACK_RANGE_STYLE : null,
    inSupplyRepairRange && !inSupplyPlacementRange ? SUPPLY_REPAIR_RANGE_STYLE : null,
    inSupplyPlacementRange ? SUPPLY_PLACEMENT_RANGE_STYLE : null,
    inUnitPlacementRange ? UNIT_PLACEMENT_STYLE : null
  ]);

  if (selected) {
    traceHex(context, corners);
    context.strokeStyle = "#ffffff";
    context.lineWidth = 2;
    context.stroke();
  }
}

function getPlayerUnitPlacementHexIds(state: GameState, unitType: UnitType): Set<string> {
  return new Set(
    state.map.hexes
      .filter((hex) => canPlacePlayerUnitAt(state, unitType, hex.coord))
      .map((hex) => hex.id)
  );
}

function getSupplyTruckRepairRangeHexIds(state: GameState, unit: UnitInstance): Set<string> {
  return getSupplyTruckRangeHexIds(state, unit, SUPPLY_TRUCK_REPAIR_RANGE, true);
}

function getSupplyTruckPlacementRangeHexIds(state: GameState, unit: UnitInstance): Set<string> {
  if (!canSupplyTruckEnablePlacement(state, unit)) {
    return new Set<string>();
  }

  return getSupplyTruckRangeHexIds(state, unit, SUPPLY_TRUCK_PLACEMENT_RANGE, false);
}

function getSupplyTruckRangeHexIds(state: GameState, unit: UnitInstance, range: number, includeOrigin: boolean): Set<string> {
  const hexIds = new Set<string>();
  if (!isSupplyPlacementProvider(unit.type)) {
    return hexIds;
  }

  for (const hex of state.map.hexes) {
    if (unit.owner === "Player" && state.fog[hex.id] === "unexplored") {
      continue;
    }

    const distance = hexDistance(unit.coord, hex.coord);
    if (distance <= range && (includeOrigin || distance > 0)) {
      hexIds.add(hex.id);
    }
  }

  return hexIds;
}

function drawAreaCopyUnderlay(context: CanvasRenderingContext2D, view: MapView, state: GameState): void {
  context.save();
  for (const hex of state.map.hexes) {
    const owner = getAreaCopyOwner(state, hex);
    if (!owner) {
      continue;
    }

    const offset = getAreaCopyOffset(owner, view.hexSize);
    const center = axialToPixel(hex.coord, view);
    const corners = hexCorners(
      {
        x: center.x + offset.x,
        y: center.y + offset.y
      },
      view.hexSize - 1
    );
    traceHex(context, corners);
    context.fillStyle = toRgba(getOwnerCaptureColor(state, owner), AREA_COPY_FILL_ALPHA);
    context.fill();
  }

  context.fillStyle = "#000000";
  for (const hex of state.map.hexes) {
    const center = axialToPixel(hex.coord, view);
    traceHex(context, hexCorners(center, view.hexSize + 0.5));
    context.fill();
  }
  context.restore();
}

function getAreaCopyOwner(state: GameState, hex: HexTile): Owner | null {
  if (state.winner) {
    return state.winner;
  }

  return getAreaTintOwner(state, hex);
}

function getAreaCopyOffset(owner: Owner, hexSize: number): { x: number; y: number } {
  const offset = Math.max(2.5, hexSize * AREA_COPY_OFFSET_RATIO);
  return owner === "Player"
    ? { x: -offset, y: offset }
    : { x: offset, y: -offset };
}

function getAreaTintOwner(
  state: GameState,
  hex: HexTile
): Owner | null {
  const area = getBattlefieldArea(state, hex.coord);
  if (area === "Empire") {
    return "Player";
  }

  if (area === "Alliance") {
    return "Enemy";
  }

  if (ownerControlsBothGates(state, "Player")) {
    return "Player";
  }

  if (ownerControlsBothGates(state, "Enemy")) {
    return "Enemy";
  }

  return null;
}

function getHexBaseStrokeStyle(
  state: GameState,
  hex: HexTile,
  fogStatus: GameState["fog"][string],
  gate: GateState | undefined
): string {
  const baseOwner = sameHex(hex.coord, state.bases.Player) ? "Player" : sameHex(hex.coord, state.bases.Enemy) ? "Enemy" : null;
  const gateOwner = getDisplayGateOwner(gate, fogStatus);

  if (baseOwner) {
    return "#ffffff";
  }

  if (gateOwner === "Player") {
    return "#9fbeff";
  }

  if (gateOwner === "Enemy") {
    return "#ffb2a8";
  }

  if (gate) {
    return "#fff6a0";
  }

  if (fogStatus === "visible") {
    return VISIBLE_HEX_BORDER_COLOR;
  }

  if (fogStatus === "fogged") {
    return "#8a8a8a";
  }

  return "#606060";
}

function getActiveEnemyTrailStates(effects: CombatVisualEffect[], now: number): Map<string, EnemyTrailRenderState> {
  const states = new Map<string, EnemyTrailRenderState>();
  for (const effect of effects) {
    if (effect.type !== "enemy-trail") {
      continue;
    }

    const progress = getEffectProgress(effect, now);
    if (progress >= 1) {
      continue;
    }

    const fadeStart = 0.84;
    const fadeProgress = progress <= fadeStart ? 0 : (progress - fadeStart) / (1 - fadeStart);
    const intensity = 1 - smoothstep(fadeProgress);
    for (const coord of effect.coords) {
      const id = hexId(coord);
      const existing = states.get(id);
      if (existing && existing.intensity >= intensity) {
        continue;
      }

      states.set(id, {
        intensity,
        baseBorderColor: effect.baseBorderColorsByHexId[id]
      });
    }
  }
  return states;
}

function smoothstep(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

function blendHexColors(base: string, overlay: string, amount: number): string {
  const baseRgb = parseHexColor(base);
  const overlayRgb = parseHexColor(overlay);
  const clamped = Math.max(0, Math.min(1, amount));
  const red = Math.round(baseRgb.red + (overlayRgb.red - baseRgb.red) * clamped);
  const green = Math.round(baseRgb.green + (overlayRgb.green - baseRgb.green) * clamped);
  const blue = Math.round(baseRgb.blue + (overlayRgb.blue - baseRgb.blue) * clamped);
  return `rgb(${red}, ${green}, ${blue})`;
}

function toRgba(color: string, alpha: number): string {
  const rgb = parseHexColor(color);
  return `rgba(${rgb.red}, ${rgb.green}, ${rgb.blue}, ${alpha})`;
}

function parseHexColor(color: string): { red: number; green: number; blue: number } {
  const normalized = color.replace("#", "");
  return {
    red: Number.parseInt(normalized.slice(0, 2), 16),
    green: Number.parseInt(normalized.slice(2, 4), 16),
    blue: Number.parseInt(normalized.slice(4, 6), 16)
  };
}

function getDisplayGateOwner(gate: GateState | undefined, fogStatus: GameState["fog"][string]): Owner | null {
  if (!gate) {
    return null;
  }

  return fogStatus === "visible" ? gate.owner : gate.knownOwner;
}

function getCaptureProgress(
  state: GameState,
  baseOwner: Owner | null,
  gate: GateState | undefined
): { progress: number; color: string } | null {
  if (baseOwner === "Player" && state.baseOccupation.Player > 0) {
    return {
      progress: state.baseOccupation.Player / BASE_CAPTURE_DAYS,
      color: getOwnerCaptureColor(state, "Enemy")
    };
  }

  if (baseOwner === "Enemy" && state.baseOccupation.Enemy > 0) {
    return {
      progress: state.baseOccupation.Enemy / BASE_CAPTURE_DAYS,
      color: getOwnerCaptureColor(state, "Player")
    };
  }

  if (!gate) {
    return null;
  }

  if (gate.owner !== "Player" && gate.occupation.Player > 0) {
    return {
      progress: gate.occupation.Player / GATE_CAPTURE_DAYS,
      color: getOwnerCaptureColor(state, "Player")
    };
  }

  if (gate.owner !== "Enemy" && gate.occupation.Enemy > 0) {
    return {
      progress: gate.occupation.Enemy / GATE_CAPTURE_DAYS,
      color: getOwnerCaptureColor(state, "Enemy")
    };
  }

  return null;
}

function drawCaptureProgress(
  context: CanvasRenderingContext2D,
  corners: { x: number; y: number }[],
  center: { x: number; y: number },
  captureProgress: { progress: number; color: string } | null
): void {
  if (!captureProgress) {
    return;
  }

  const progress = Math.max(0, Math.min(1, captureProgress.progress));
  if (progress <= 0) {
    return;
  }

  const radius = Math.max(...corners.map((corner) => Math.hypot(corner.x - center.x, corner.y - center.y))) + 2;
  const startAngle = -Math.PI / 2;
  const endAngle = startAngle + Math.PI * 2 * progress;

  context.save();
  traceHex(context, corners);
  context.clip();
  context.beginPath();
  context.moveTo(center.x, center.y);
  context.arc(center.x, center.y, radius, startAngle, endAngle, false);
  context.closePath();
  context.fillStyle = captureProgress.color;
  context.fill();
  context.restore();
}

function drawBases(context: CanvasRenderingContext2D, view: MapView, state: GameState): void {
  drawBaseLabel(context, view, state.bases.Player);
  drawBaseLabel(context, view, state.bases.Enemy);
}

function drawBaseLabel(context: CanvasRenderingContext2D, view: MapView, coord: HexCoord): void {
  const center = axialToPixel(coord, view);
  context.fillStyle = "#ffffff";
  context.font = `${Math.max(9, Math.floor(view.hexSize * 0.42))}px ${UI_FONT}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("BASE", center.x, center.y);
}

function drawGates(context: CanvasRenderingContext2D, view: MapView, state: GameState): void {
  for (const gate of state.gates ?? []) {
    const center = axialToPixel(gate.coord, view);
    context.fillStyle = getDisplayGateOwner(gate, state.fog[hexId(gate.coord)]) ? "#ffffff" : "#171100";
    context.font = `700 ${Math.max(7, Math.floor(view.hexSize * 0.28))}px ${UI_FONT}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("GATE", center.x, center.y);
  }
}

function getFrontLineEdgeColors(state: GameState, hex: HexTile): Partial<Record<number, string>> {
  const lines = getFrontLineRows(state);
  const edgeColors: Partial<Record<number, string>> = {};

  if (!ownerControlsBothGates(state, "Player")) {
    if (hex.coord.r === lines.enemyLineRow - 1) {
      edgeColors[1] = getOwnerCaptureColor(state, "Enemy");
      edgeColors[2] = getOwnerCaptureColor(state, "Enemy");
    } else if (hex.coord.r === lines.enemyLineRow) {
      edgeColors[4] = getOwnerCaptureColor(state, "Enemy");
      edgeColors[5] = getOwnerCaptureColor(state, "Enemy");
    }
  }

  if (!ownerControlsBothGates(state, "Enemy")) {
    if (hex.coord.r === lines.playerLineRow - 1) {
      edgeColors[1] = getOwnerCaptureColor(state, "Player");
      edgeColors[2] = getOwnerCaptureColor(state, "Player");
    } else if (hex.coord.r === lines.playerLineRow) {
      edgeColors[4] = getOwnerCaptureColor(state, "Player");
      edgeColors[5] = getOwnerCaptureColor(state, "Player");
    }
  }

  return edgeColors;
}

function getOwnerCaptureColor(state: GameState, owner: Owner): string {
  return getOwnerFaction(state, owner) === "Empire" ? PLAYER_CAPTURE_COLOR : ENEMY_CAPTURE_COLOR;
}

function drawHexBorder(
  context: CanvasRenderingContext2D,
  corners: { x: number; y: number }[],
  defaultColor: string,
  defaultWidth: number,
  edgeColors: Partial<Record<number, string>> = {}
): void {
  context.save();
  context.lineWidth = defaultWidth;
  for (let index = 0; index < corners.length; index += 1) {
    const start = corners[index];
    const end = corners[(index + 1) % corners.length];
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.strokeStyle = edgeColors[index] ?? defaultColor;
    context.stroke();
  }
  context.restore();
}

function drawQueuedMovementPaths(context: CanvasRenderingContext2D, view: MapView, state: GameState): void {
  const queuedUnits = state.units.filter((unit) => unit.owner === "Player" && unit.queuedMovement?.path.length);
  if (!queuedUnits.length) {
    return;
  }

  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";

  for (const unit of queuedUnits) {
    const queued = unit.queuedMovement;
    if (!queued?.path.length) {
      continue;
    }

    const points = [unit.coord, ...queued.path].map((coord) => axialToPixel(coord, view));
    const linePoints = trimQueuedMovementStart(points, view.hexSize * 0.62);
    context.beginPath();
    linePoints.forEach((point, index) => {
      if (index === 0) {
        context.moveTo(point.x, point.y);
      } else {
        context.lineTo(point.x, point.y);
      }
    });
    context.strokeStyle = "rgba(255, 218, 64, 0.92)";
    context.lineWidth = Math.max(2, view.hexSize * 0.13);
    context.setLineDash([Math.max(5, view.hexSize * 0.28), Math.max(4, view.hexSize * 0.2)]);
    context.stroke();

    for (const point of points.slice(1)) {
      context.beginPath();
      context.arc(point.x, point.y, Math.max(2, view.hexSize * 0.09), 0, Math.PI * 2);
      context.fillStyle = "#ffdf4a";
      context.fill();
    }

    drawQueuedMovementStopLabels(context, view, state, unit, points);
  }

  context.restore();
}

function trimQueuedMovementStart(points: { x: number; y: number }[], distance: number): { x: number; y: number }[] {
  if (points.length < 2) {
    return points;
  }

  const [start, next] = points;
  const dx = next.x - start.x;
  const dy = next.y - start.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const trimDistance = Math.min(distance, length * 0.75);
  return [
    {
      x: start.x + (dx / length) * trimDistance,
      y: start.y + (dy / length) * trimDistance
    },
    ...points.slice(1)
  ];
}

function drawQueuedMovementStopLabels(
  context: CanvasRenderingContext2D,
  view: MapView,
  state: GameState,
  unit: UnitInstance,
  points: { x: number; y: number }[]
): void {
  const stopPathIndexes = getQueuedMovementStopPathIndexes(state, unit);
  const fontSize = Math.max(8, Math.floor(view.hexSize * 0.27));

  context.setLineDash([]);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `700 ${fontSize}px ${UI_FONT}`;

  for (let moveNumber = 1; moveNumber <= stopPathIndexes.length; moveNumber += 1) {
    const pathIndex = Math.min((unit.queuedMovement?.path.length ?? 0), stopPathIndexes[moveNumber - 1]);
    const point = points[pathIndex];
    if (!point) {
      continue;
    }

    const label = String(moveNumber);
    const radius = Math.max(7, view.hexSize * 0.24);
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fillStyle = "rgba(0, 0, 0, 0.82)";
    context.fill();
    context.strokeStyle = "#ffdf4a";
    context.lineWidth = 1.5;
    context.stroke();
    context.fillStyle = "#ffdf4a";
    context.fillText(label, point.x, point.y);
  }
}

function drawUnits(
  context: CanvasRenderingContext2D,
  view: MapView,
  state: GameState,
  lookups: RenderLookups,
  now: number,
  debugMode: boolean
): void {
  context.textAlign = "center";
  context.textBaseline = "middle";

  for (const unit of state.units) {
    const id = hexId(unit.coord);
    if (!debugMode && unit.owner === "Enemy" && state.fog[id] !== "visible") {
      continue;
    }

    const center = axialToPixel(unit.coord, view);
    const groundUnitCount = lookups.groundUnitCountsByHexId.get(id) ?? 0;
    const hasGroundUnit = getUnitDomain(unit.type) === "Ground" ? groundUnitCount > 1 : groundUnitCount > 0;
    drawUnitLabel(context, view, state, center, unit, hasGroundUnit, getHitIntensity(lookups.hitEffectsByUnitKey, unit, now));
  }

  for (const spottedUnit of Object.values(state.spottedUnits?.Player ?? {})) {
    const currentUnit = state.units.find((unit) => unit.id === spottedUnit.id);
    if (currentUnit && (debugMode || state.fog[hexId(currentUnit.coord)] === "visible")) {
      continue;
    }

    const id = hexId(spottedUnit.coord);
    if (state.fog[id] === "unexplored") {
      continue;
    }

    const center = axialToPixel(spottedUnit.coord, view);
    const groundUnitCount = lookups.groundUnitCountsByHexId.get(id) ?? 0;
    const hasGroundUnit = getUnitDomain(spottedUnit.type) === "Ground" ? groundUnitCount > 1 : groundUnitCount > 0;
    const displaySpottedUnit =
      spottedUnit.level === undefined && currentUnit
        ? {
            ...spottedUnit,
            level: getUnitInstanceLevel(state, currentUnit)
          }
        : spottedUnit;
    drawSpottedUnitLabel(context, view, state, center, displaySpottedUnit, hasGroundUnit);
  }
}

function drawUnitLabel(
  context: CanvasRenderingContext2D,
  view: MapView,
  state: GameState,
  center: { x: number; y: number },
  unit: UnitInstance,
  hasGroundUnit: boolean,
  hitIntensity: number
): void {
  const definition = getUnitDefinition(unit.type);
  const domain = getUnitDomain(unit.type);
  const labelY = domain === "Air" ? center.y - view.hexSize * 0.34 : center.y + view.hexSize * 0.2;
  const statsY = labelY + Math.max(7, view.hexSize * 0.24);
  const prefix = domain === "Air" && hasGroundUnit ? "^" : "";
  const statsText =
    unit.owner === "Enemy"
      ? `${unit.health}/${unit.maxHealth}`
      : `${unit.health}/${unit.maxHealth} ${getRemainingMovementPoints(state, unit)} ${getUnitStatusText(state, unit)}`;
  if (hitIntensity > 0) {
    drawHitPulse(context, center, view.hexSize, hitIntensity);
    context.shadowColor = "#ff1f1f";
    context.shadowBlur = 12 * hitIntensity;
  }

  context.fillStyle = getUnitLabelTextColor(state, unit, hitIntensity);
  context.font = `700 ${Math.max(9, Math.floor(view.hexSize * 0.36))}px ${UI_FONT}`;
  context.fillText(`${prefix}${definition.label}`, center.x, labelY);
  context.font = `${Math.max(6, Math.floor(view.hexSize * 0.22))}px ${UI_FONT}`;
  context.fillText(statsText, center.x, statsY);
  context.shadowBlur = 0;

  const level = getUnitInstanceLevel(state, unit);
  context.textAlign = "right";
  context.textBaseline = "top";
  context.font = `700 ${Math.max(7, Math.floor(view.hexSize * 0.22))}px ${UI_FONT}`;
  context.fillStyle = getUnitLevelTextColor(state, unit, hitIntensity);
  context.fillText(ROMAN_LEVELS[level] ?? String(level), center.x + view.hexSize * 0.46, center.y - view.hexSize * 0.62);
  context.textAlign = "center";
  context.textBaseline = "middle";
}

function getUnitStatusText(state: GameState, unit: UnitInstance): string {
  if (isSupplyPlacementProvider(unit.type)) {
    return canSupplyTruckEnablePlacement(state, unit) ? "+" : "-";
  }

  return canUnitAttackThisDay(state, unit) ? "+" : "-";
}

function hasFieldUpgradeAvailable(state: GameState, unit: UnitInstance): boolean {
  const economy = unit.owner === "Player" ? state.economy : state.enemyEconomy;
  const level = getUnitInstanceLevel(state, unit);
  return level < economy.unitLevels[unit.type];
}

function getUnitLevelTextColor(state: GameState, unit: UnitInstance, hitIntensity: number): string {
  if (unit.owner === "Player" && hasFieldUpgradeAvailable(state, unit)) {
    return isUncapturedGateTile(state, unit.coord) ? "#000000" : "#ffdf4a";
  }

  return getUnitLabelTextColor(state, unit, hitIntensity);
}

function getUnitLabelTextColor(state: GameState, unit: UnitInstance, hitIntensity: number): string {
  if (unit.owner === "Enemy" && isEnemyObjectiveTile(state, unit.coord)) {
    return "#000000";
  }

  if (hitIntensity > 0) {
    return "#ff1f1f";
  }

  return unit.owner === "Player" ? "#ffffff" : "#ff3b3b";
}

function isEnemyObjectiveTile(state: GameState, coord: HexCoord): boolean {
  if (sameHex(coord, state.bases.Enemy)) {
    return true;
  }

  if (state.baseOccupation.Player > 0 && sameHex(coord, state.bases.Player)) {
    return true;
  }

  return (state.gates ?? []).some((gate) => (gate.owner === "Enemy" || gate.occupation.Enemy > 0) && sameHex(coord, gate.coord));
}

function isUncapturedGateTile(state: GameState, coord: HexCoord): boolean {
  return (state.gates ?? []).some((gate) => gate.owner === null && sameHex(coord, gate.coord));
}

function drawSpottedUnitLabel(
  context: CanvasRenderingContext2D,
  view: MapView,
  state: GameState,
  center: { x: number; y: number },
  unit: SpottedUnit,
  hasGroundUnit: boolean
): void {
  const definition = getUnitDefinition(unit.type);
  const domain = getUnitDomain(unit.type);
  const labelY = domain === "Air" ? center.y - view.hexSize * 0.34 : center.y + view.hexSize * 0.2;
  const statsY = labelY + Math.max(7, view.hexSize * 0.24);
  const prefix = domain === "Air" && hasGroundUnit ? "^" : "";
  const statsText =
    unit.owner === "Enemy"
      ? `${unit.health}/${unit.maxHealth}`
      : `${unit.health}/${unit.maxHealth} ${getUnitDefinition(unit.type).moveRange} +`;

  context.save();
  context.globalAlpha = 0.58;
  context.fillStyle = getSpottedUnitLabelTextColor(state, unit);
  context.font = `700 ${Math.max(9, Math.floor(view.hexSize * 0.36))}px ${UI_FONT}`;
  context.fillText(`${prefix}${definition.label}`, center.x, labelY);
  context.font = `${Math.max(6, Math.floor(view.hexSize * 0.22))}px ${UI_FONT}`;
  context.fillText(statsText, center.x, statsY);
  context.textAlign = "right";
  context.textBaseline = "top";
  context.font = `700 ${Math.max(7, Math.floor(view.hexSize * 0.22))}px ${UI_FONT}`;
  const level = unit.level ?? 1;
  context.fillText(ROMAN_LEVELS[level] ?? String(level), center.x + view.hexSize * 0.46, center.y - view.hexSize * 0.62);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.restore();
}

function getSpottedUnitLabelTextColor(state: GameState, unit: SpottedUnit): string {
  if (unit.owner === "Enemy" && isEnemyObjectiveTile(state, unit.coord)) {
    return "#000000";
  }

  return "#ff8585";
}

function getHitIntensity(effectsByUnitKey: Map<string, CombatVisualEffect[]>, unit: UnitInstance, now: number): number {
  const effects = effectsByUnitKey.get(unitEffectKey(unit.owner, unit.type, unit.coord));
  if (!effects) {
    return 0;
  }

  return effects.reduce((intensity, effect) => Math.max(intensity, getEffectPulse(effect, now)), 0);
}

function unitEffectKey(owner: Owner, unitType: UnitType, coord: HexCoord): string {
  return `${owner}|${unitType}|${hexId(coord)}`;
}

function getEffectProgress(effect: CombatVisualEffect, now: number): number {
  return Math.max(0, Math.min(1, (now - effect.startedAt) / effect.durationMs));
}

function getEffectPulse(effect: CombatVisualEffect, now: number): number {
  const progress = getEffectProgress(effect, now);
  if (progress >= 1) {
    return 0;
  }

  return Math.sin(progress * Math.PI) * (1 - progress * 0.2);
}

function drawHitPulse(context: CanvasRenderingContext2D, center: { x: number; y: number }, hexSize: number, intensity: number): void {
  context.save();
  context.beginPath();
  context.arc(center.x, center.y, hexSize * (0.26 + intensity * 0.18), 0, Math.PI * 2);
  context.fillStyle = `rgba(255, 20, 20, ${0.18 + intensity * 0.34})`;
  context.fill();
  context.strokeStyle = `rgba(255, 230, 230, ${0.25 + intensity * 0.35})`;
  context.lineWidth = 1 + intensity * 2;
  context.stroke();
  context.restore();
}

function drawCombatEffects(context: CanvasRenderingContext2D, view: MapView, effects: CombatVisualEffect[], now: number): void {
  for (const effect of effects) {
    if (effect.type === "destroyed") {
      drawDestroyedEffect(context, view, effect, now);
    }
  }
}

function drawDestroyedEffect(context: CanvasRenderingContext2D, view: MapView, effect: UnitCombatVisualEffect, now: number): void {
  const progress = getEffectProgress(effect, now);
  if (progress >= 1) {
    return;
  }

  const center = axialToPixel(effect.coord, view);
  const pulse = Math.sin(progress * Math.PI);
  const radius = view.hexSize * (0.25 + progress * 1.15);
  const alpha = 1 - progress;

  context.save();
  context.globalCompositeOperation = "lighter";
  context.beginPath();
  context.arc(center.x, center.y, radius, 0, Math.PI * 2);
  context.fillStyle = `rgba(255, 40, 20, ${0.22 * alpha})`;
  context.fill();
  context.strokeStyle = `rgba(255, 235, 110, ${0.85 * alpha})`;
  context.lineWidth = Math.max(1, view.hexSize * 0.08 * pulse);
  context.stroke();

  for (let index = 0; index < 12; index += 1) {
    const angle = (Math.PI * 2 * index) / 12 + progress * 0.8;
    const inner = view.hexSize * (0.2 + progress * 0.28);
    const outer = view.hexSize * (0.55 + progress * 1.45);
    context.beginPath();
    context.moveTo(center.x + Math.cos(angle) * inner, center.y + Math.sin(angle) * inner);
    context.lineTo(center.x + Math.cos(angle) * outer, center.y + Math.sin(angle) * outer);
    context.strokeStyle = `rgba(255, ${80 + Math.floor(120 * pulse)}, 30, ${alpha})`;
    context.lineWidth = Math.max(1, view.hexSize * 0.055 * alpha);
    context.stroke();
  }

  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `700 ${Math.max(8, Math.floor(view.hexSize * 0.32))}px ${UI_FONT}`;
  context.fillStyle = `rgba(255, 245, 220, ${Math.min(1, alpha * 1.4)})`;
  context.fillText("X", center.x, center.y);
  context.restore();
}

function traceHex(context: CanvasRenderingContext2D, corners: { x: number; y: number }[]): void {
  context.beginPath();
  corners.forEach((corner, index) => {
    if (index === 0) {
      context.moveTo(corner.x, corner.y);
    } else {
      context.lineTo(corner.x, corner.y);
    }
  });
  context.closePath();
}

function drawRangeOverlays(
  context: CanvasRenderingContext2D,
  corners: { x: number; y: number }[],
  center: { x: number; y: number },
  styles: Array<RangeOverlayStyle | null>
): void {
  const activeStyles = styles.filter((style): style is RangeOverlayStyle => Boolean(style));
  if (!activeStyles.length) {
    return;
  }

  if (activeStyles.length === 1) {
    drawRangeMarker(context, corners, activeStyles[0]);
    return;
  }

  drawSplitRangeMarker(context, corners, center, activeStyles);
}

function drawRangeMarker(context: CanvasRenderingContext2D, corners: { x: number; y: number }[], style: RangeOverlayStyle): void {
  traceHex(context, corners);
  if (style.fill) {
    context.fillStyle = style.fill;
    context.fill();
  }
  context.strokeStyle = style.stroke;
  context.lineWidth = RANGE_STROKE_WIDTH;
  context.stroke();
}

function drawSplitRangeMarker(
  context: CanvasRenderingContext2D,
  corners: { x: number; y: number }[],
  center: { x: number; y: number },
  styles: RangeOverlayStyle[]
): void {
  const splitCorners = expandCorners(corners, center, 1.5);
  const minX = Math.min(...splitCorners.map((corner) => corner.x));
  const maxX = Math.max(...splitCorners.map((corner) => corner.x));
  const minY = Math.min(...splitCorners.map((corner) => corner.y));
  const maxY = Math.max(...splitCorners.map((corner) => corner.y));
  const sliceWidth = (maxX - minX) / styles.length;

  styles.forEach((style, index) => {
    context.save();
    context.beginPath();
    context.rect(minX + sliceWidth * index, minY, sliceWidth, maxY - minY);
    context.clip();
    traceHex(context, splitCorners);
    if (style.fill) {
      context.fillStyle = style.fill;
      context.fill();
    }
    context.strokeStyle = style.stroke;
    context.lineWidth = RANGE_STROKE_WIDTH;
    context.stroke();
    context.restore();
  });

  context.save();
  context.strokeStyle = "#ffffff";
  context.lineWidth = 1;
  for (let index = 1; index < styles.length; index += 1) {
    const x = minX + sliceWidth * index;
    context.beginPath();
    context.moveTo(x, minY);
    context.lineTo(x, maxY);
    context.stroke();
  }
  context.restore();
}

function expandCorners(
  corners: { x: number; y: number }[],
  center: { x: number; y: number },
  amount: number
): { x: number; y: number }[] {
  return corners.map((corner) => {
    const dx = corner.x - center.x;
    const dy = corner.y - center.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    return {
      x: corner.x + (dx / length) * amount,
      y: corner.y + (dy / length) * amount
    };
  });
}
