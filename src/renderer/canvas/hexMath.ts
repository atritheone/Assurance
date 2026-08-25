import type { HexCoord } from "../game/types";

export interface Point {
  x: number;
  y: number;
}

export interface MapView {
  origin: Point;
  hexSize: number;
}

const SQRT_3 = Math.sqrt(3);

export function offsetToPixel(coord: HexCoord, view: MapView): Point {
  const hexWidth = SQRT_3 * view.hexSize;
  const rowOffset = coord.r % 2 === 0 ? 0 : hexWidth / 2;
  return {
    x: view.origin.x + coord.q * hexWidth + rowOffset,
    y: view.origin.y + view.hexSize * 1.5 * coord.r
  };
}

export function pixelToOffset(point: Point, view: MapView): HexCoord {
  const hexWidth = SQRT_3 * view.hexSize;
  const rowHeight = view.hexSize * 1.5;
  const approximateRow = Math.round((point.y - view.origin.y) / rowHeight);
  let best: HexCoord = { q: 0, r: approximateRow };
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let r = approximateRow - 1; r <= approximateRow + 1; r += 1) {
    const rowOffset = r % 2 === 0 ? 0 : hexWidth / 2;
    const approximateCol = Math.round((point.x - view.origin.x - rowOffset) / hexWidth);

    for (let q = approximateCol - 1; q <= approximateCol + 1; q += 1) {
      const center = offsetToPixel({ q, r }, view);
      const dx = center.x - point.x;
      const dy = center.y - point.y;
      const distance = dx * dx + dy * dy;

      if (distance < bestDistance) {
        best = { q, r };
        bestDistance = distance;
      }
    }
  }

  return best;
}

export function hexCorners(center: Point, size: number): Point[] {
  const corners: Point[] = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    corners.push({
      x: center.x + size * Math.cos(angle),
      y: center.y + size * Math.sin(angle)
    });
  }
  return corners;
}

export const axialToPixel = offsetToPixel;
export const pixelToAxial = pixelToOffset;
