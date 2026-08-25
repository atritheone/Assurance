import { getHex } from "../game/map";
import type { GameState, HexCoord, UnitType } from "../game/types";
import { axialToPixel, pixelToAxial, type MapView } from "./hexMath";
import { renderMap, type CombatVisualEffect, type TurnAttentionRegion } from "./mapRenderer";

export type HexClick = {
  coord: HexCoord;
  side: "left" | "right";
};

const MIN_HEX_SIZE = 16;
const MAX_HEX_SIZE = 72;
const DEFAULT_HEX_SIZE = 22;
const CAMERA_FOCUS_DURATION_MS = 650;

interface CameraAnimation {
  from: { x: number; y: number };
  to: { x: number; y: number };
  startedAt: number;
  durationMs: number;
}

export class HexCanvas {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly onSelectHex: (click: HexClick | null) => void;
  private state: GameState | null = null;
  private view: MapView | null = null;
  private effects: CombatVisualEffect[] = [];
  private placementUnitType: UnitType | null = null;
  private debugMode = false;
  private cameraAnimation: CameraAnimation | null = null;
  private hoveredCoord: HexCoord | null = null;
  private resizeObserver: ResizeObserver;
  private animationFrameId: number | null = null;
  private renderFrameId: number | null = null;
  private dragging = false;
  private dragged = false;
  private placementPointerActive = false;
  private lastPointer: { x: number; y: number } | null = null;

  constructor(canvas: HTMLCanvasElement, onSelectHex: (click: HexClick | null) => void) {
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("2D canvas context unavailable.");
    }

    this.canvas = canvas;
    this.context = context;
    this.onSelectHex = onSelectHex;
    this.resizeObserver = new ResizeObserver(() => this.render());
    this.resizeObserver.observe(this.canvas);

    this.canvas.addEventListener("click", (event) => this.handleClick(event));
    this.canvas.addEventListener("pointerdown", (event) => this.handlePointerDown(event));
    this.canvas.addEventListener("pointermove", (event) => this.handlePointerMove(event));
    this.canvas.addEventListener("pointerup", () => this.handlePointerUp());
    this.canvas.addEventListener("pointercancel", () => this.handlePointerUp());
    this.canvas.addEventListener("pointerleave", () => this.setHoveredCoord(null));
    this.canvas.addEventListener("wheel", (event) => this.handleWheel(event), { passive: false });
  }

  setState(state: GameState): void {
    this.state = state;
    this.render();
  }

  setScene(
    state: GameState,
    effects: CombatVisualEffect[],
    attentionRegion: TurnAttentionRegion | null = null,
    placementUnitType: UnitType | null = null,
    debugMode = false
  ): void {
    this.state = state;
    this.effects = effects;
    this.placementUnitType = placementUnitType;
    this.debugMode = debugMode;
    if (attentionRegion) {
      this.focusTurnAttentionRegion(attentionRegion);
    }
    this.render();
    this.ensureAnimation();
  }

  setCombatEffects(effects: CombatVisualEffect[]): void {
    this.effects = effects;
    this.render();
    this.ensureAnimation();
  }

  setDebugMode(debugMode: boolean): void {
    this.debugMode = debugMode;
    this.render();
  }

  render(): void {
    if (this.renderFrameId !== null) {
      return;
    }

    this.renderFrameId = requestAnimationFrame(() => {
      this.renderFrameId = null;
      this.drawNow();
    });
  }

  private drawNow(): void {
    if (!this.state) {
      return;
    }

    this.resizeBackingStore();
    if (this.canvas.clientWidth <= 0 || this.canvas.clientHeight <= 0) {
      return;
    }

    this.ensureView();
    if (!this.view) {
      return;
    }

    this.updateCameraAnimation(performance.now());
    this.syncHexSizeCssVariables();
    renderMap(this.canvas, this.context, this.state, this.view, this.effects, performance.now(), this.hoveredCoord, this.placementUnitType, this.debugMode);
  }

  private syncHexSizeCssVariables(): void {
    if (!this.view) {
      return;
    }

    const hexRadius = Math.max(1, this.view.hexSize - 1);
    this.canvas.parentElement?.style.setProperty("--map-hex-radius", `${hexRadius}px`);
    this.canvas.parentElement?.style.setProperty("--map-hex-width", `${Math.sqrt(3) * hexRadius}px`);
    this.canvas.parentElement?.style.setProperty("--map-hex-height", `${2 * hexRadius}px`);
  }

  private handleClick(event: MouseEvent): void {
    if (!this.state || !this.view) {
      return;
    }

    if (this.dragged) {
      this.dragged = false;
      return;
    }

    const bounds = this.canvas.getBoundingClientRect();
    const coord = this.getCoordAtEvent(event, bounds);

    if (coord && getHex(this.state.map, coord)) {
      const center = axialToPixel(coord, this.view);
      this.onSelectHex({
        coord,
        side: event.clientX - bounds.left < center.x ? "left" : "right"
      });
      return;
    }

    this.onSelectHex(null);
  }

  private handlePointerDown(event: PointerEvent): void {
    this.placementPointerActive = this.placementUnitType !== null;
    this.dragging = !this.placementPointerActive;
    this.dragged = false;
    this.lastPointer = { x: event.clientX, y: event.clientY };
    this.canvas.setPointerCapture(event.pointerId);
  }

  private handlePointerMove(event: PointerEvent): void {
    if (!this.view) {
      return;
    }

    if (this.lastPointer && (this.dragging || this.placementPointerActive)) {
      const dx = event.clientX - this.lastPointer.x;
      const dy = event.clientY - this.lastPointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) {
        this.dragged = true;
      }

      if (this.placementPointerActive) {
        this.lastPointer = { x: event.clientX, y: event.clientY };
        this.updateHover(event);
        return;
      }

      this.view.origin.x += dx;
      this.view.origin.y += dy;
      this.cameraAnimation = null;
      this.lastPointer = { x: event.clientX, y: event.clientY };
      this.render();
    }

    this.updateHover(event);
  }

  private handlePointerUp(): void {
    this.dragging = false;
    this.placementPointerActive = false;
    this.lastPointer = null;
  }

  private handleWheel(event: WheelEvent): void {
    if (!this.view) {
      return;
    }

    event.preventDefault();
    this.cameraAnimation = null;
    const bounds = this.canvas.getBoundingClientRect();
    const pointer = {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top
    };
    const previousSize = this.view.hexSize;
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const nextSize = clamp(previousSize * factor, MIN_HEX_SIZE, MAX_HEX_SIZE);
    if (nextSize === previousSize) {
      return;
    }

    const mapX = (pointer.x - this.view.origin.x) / previousSize;
    const mapY = (pointer.y - this.view.origin.y) / previousSize;
    this.view.hexSize = nextSize;
    this.view.origin = {
      x: pointer.x - mapX * nextSize,
      y: pointer.y - mapY * nextSize
    };
    this.render();
    this.updateHover(event);
  }

  private updateHover(event: MouseEvent): void {
    if (!this.state || !this.view) {
      this.setHoveredCoord(null);
      return;
    }

    const coord = this.getCoordAtEvent(event);
    this.setHoveredCoord(coord && getHex(this.state.map, coord) ? coord : null);
  }

  private setHoveredCoord(coord: HexCoord | null): void {
    if (
      this.hoveredCoord?.q === coord?.q &&
      this.hoveredCoord?.r === coord?.r
    ) {
      return;
    }

    this.hoveredCoord = coord;
    this.render();
  }

  private getCoordAtEvent(event: MouseEvent, bounds = this.canvas.getBoundingClientRect()): HexCoord | null {
    if (!this.view) {
      return null;
    }

    return pixelToAxial(
      {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top
      },
      this.view
    );
  }

  private ensureAnimation(): void {
    if (this.animationFrameId !== null || (!this.effects.length && !this.cameraAnimation)) {
      return;
    }

    const animate = (): void => {
      const now = performance.now();
      this.effects = this.effects.filter((effect) => now - effect.startedAt < effect.durationMs);
      this.render();
      if (this.effects.length || this.cameraAnimation) {
        this.animationFrameId = requestAnimationFrame(animate);
        return;
      }

      this.animationFrameId = null;
    };

    this.animationFrameId = requestAnimationFrame(animate);
  }

  private resizeBackingStore(): void {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * ratio));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * ratio));

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  private ensureView(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (!this.state || width <= 0 || height <= 0) {
      return;
    }

    if (this.view) {
      this.view.hexSize = clamp(this.view.hexSize, MIN_HEX_SIZE, MAX_HEX_SIZE);
      return;
    }

    const view: MapView = {
      hexSize: DEFAULT_HEX_SIZE,
      origin: { x: 0, y: 0 }
    };
    const basePixel = axialToPixel(this.state.bases.Player, view);
    view.origin = {
      x: width / 2 - basePixel.x,
      y: height * 0.82 - basePixel.y
    };
    this.view = view;
  }

  private focusTurnAttentionRegion(region: TurnAttentionRegion): void {
    this.ensureView();
    if (!this.view) {
      return;
    }

    const center = getRegionCenter(region, this.view);
    const targetOrigin = {
      x: this.view.origin.x + this.canvas.clientWidth / 2 - center.x,
      y: this.view.origin.y + this.canvas.clientHeight / 2 - center.y
    };
    const distance = Math.hypot(targetOrigin.x - this.view.origin.x, targetOrigin.y - this.view.origin.y);

    if (distance < 1) {
      this.view.origin = targetOrigin;
      this.cameraAnimation = null;
      return;
    }

    this.cameraAnimation = {
      from: { ...this.view.origin },
      to: targetOrigin,
      startedAt: performance.now(),
      durationMs: CAMERA_FOCUS_DURATION_MS
    };
  }

  private updateCameraAnimation(now: number): void {
    if (!this.view || !this.cameraAnimation) {
      return;
    }

    const progress = Math.max(0, Math.min(1, (now - this.cameraAnimation.startedAt) / this.cameraAnimation.durationMs));
    const eased = easeInOutCubic(progress);
    this.view.origin = {
      x: this.cameraAnimation.from.x + (this.cameraAnimation.to.x - this.cameraAnimation.from.x) * eased,
      y: this.cameraAnimation.from.y + (this.cameraAnimation.to.y - this.cameraAnimation.from.y) * eased
    };

    if (progress >= 1) {
      this.cameraAnimation = null;
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getRegionCenter(region: TurnAttentionRegion, view: MapView): { x: number; y: number } {
  const top = axialToPixel(region.top, view);
  const bottom = axialToPixel(region.bottom, view);
  const left = axialToPixel(region.left, view);
  const right = axialToPixel(region.right, view);
  return {
    x: (left.x + right.x) / 2,
    y: (top.y + bottom.y) / 2
  };
}

function easeInOutCubic(value: number): number {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - Math.pow(-2 * value + 2, 3) / 2;
}
