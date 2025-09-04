import type { Tile } from './types';

export async function fetchTiles(minX: number, maxX: number, minY: number, maxY: number): Promise<Tile[]> {
    const url = `/api/Tile?minX=${minX}&maxX=${maxX}&minY=${minY}&maxY=${maxY}`;
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error(`GET tiles ${r.status}`);
    return r.json();
}

export async function patchTile(x: number, y: number, offset: number, text: string, knownVersion: number) {
    const r = await fetch('/api/Tile/patch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x, y, offset, text, knownVersion })
    });
    if (!r.ok) throw new Error(`PATCH ${r.status}`);
    return r.json() as Promise<{ version: number }>;
}
