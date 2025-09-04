export type Tile = { id: number; x: number; y: number; data: string; version: number };
export type TileKey = `${number}:${number}`;
export const key = (x: number, y: number) => `${x}:${y}` as TileKey;

export const TILE_W = 16;     // chars
export const TILE_H = 16;     // chars
export const CELL = 18;     // px cell size (render)
export const TILE_CHARS = TILE_W * TILE_H; // 256
