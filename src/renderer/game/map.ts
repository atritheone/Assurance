import type { GameMap, HexCoord, HexTile } from "./types";

export function hexId(coord: HexCoord): string {
  return `${coord.q},${coord.r}`;
}

export function parseHexId(id: string): HexCoord {
  const [q, r] = id.split(",").map(Number);
  return { q, r };
}

export function displayHexId(map: GameMap, coord: HexCoord): string {
  return `${coord.q + 1},${map.height - coord.r}`;
}

export function sameHex(a: HexCoord, b: HexCoord): boolean {
  return a.q === b.q && a.r === b.r;
}

export function hexDistance(a: HexCoord, b: HexCoord): number {
  const ac = oddRowOffsetToCube(a);
  const bc = oddRowOffsetToCube(b);
  return (Math.abs(ac.x - bc.x) + Math.abs(ac.y - bc.y) + Math.abs(ac.z - bc.z)) / 2;
}

export function getHex(map: GameMap, coord: HexCoord): HexTile | undefined {
  const offset = coord.r * map.width + coord.q;
  const offsetHex = coord.q >= 0 && coord.q < map.width && coord.r >= 0 && coord.r < map.height ? map.hexes[offset] : undefined;
  if (offsetHex?.coord.q === coord.q && offsetHex.coord.r === coord.r) {
    return offsetHex;
  }

  const id = hexId(coord);
  return map.hexesById?.[id] ?? map.hexes.find((hex) => hex.id === id);
}

export function getNeighborCoords(map: GameMap, coord: HexCoord): HexCoord[] {
  const cached = map.neighborCoordsById?.[hexId(coord)];
  if (cached) {
    return cached;
  }

  return getNeighborOffsets(coord)
    .map((offset) => ({ q: coord.q + offset.q, r: coord.r + offset.r }))
    .filter((neighbor) => Boolean(getHex(map, neighbor)));
}

function getNeighborOffsets(coord: HexCoord): HexCoord[] {
  const evenRowOffsets = [
    { q: -1, r: -1 },
    { q: 0, r: -1 },
    { q: -1, r: 0 },
    { q: 1, r: 0 },
    { q: -1, r: 1 },
    { q: 0, r: 1 }
  ];
  const oddRowOffsets = [
    { q: 0, r: -1 },
    { q: 1, r: -1 },
    { q: -1, r: 0 },
    { q: 1, r: 0 },
    { q: 0, r: 1 },
    { q: 1, r: 1 }
  ];

  return coord.r % 2 === 0 ? evenRowOffsets : oddRowOffsets;
}

export function generateHexMap(width = 29, height = 39): GameMap {
  const hexes: HexTile[] = [];

  for (let r = 0; r < height; r += 1) {
    for (let q = 0; q < width; q += 1) {
      const coord = { q, r };
      hexes.push({
        id: hexId(coord),
        coord,
        terrain: "open",
        passable: true
      });
    }
  }

  return indexHexMap({ width, height, hexes });
}

export function indexHexMap(map: GameMap): GameMap {
  if (map.hexesById && map.neighborCoordsById) {
    return map;
  }

  const hexesById = map.hexesById ?? Object.fromEntries(map.hexes.map((hex) => [hex.id, hex]));
  const neighborCoordsById = map.neighborCoordsById ?? Object.fromEntries(
    map.hexes.map((hex) => [
      hex.id,
      getNeighborOffsets(hex.coord)
        .map((offset) => ({ q: hex.coord.q + offset.q, r: hex.coord.r + offset.r }))
        .filter((neighbor) => Boolean(hexesById[hexId(neighbor)]))
    ])
  );

  return {
    ...map,
    hexesById,
    neighborCoordsById
  };
}

function oddRowOffsetToCube(coord: HexCoord): { x: number; y: number; z: number } {
  const x = coord.q - (coord.r - (coord.r & 1)) / 2;
  const z = coord.r;
  const y = -x - z;
  return { x, y, z };
}
