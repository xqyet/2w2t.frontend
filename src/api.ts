// src/api.ts
import type { Tile } from './types';

let inFlight: AbortController | null = null;

export async function fetchTiles(
    minX: number, maxX: number, minY: number, maxY: number
): Promise<Tile[]> {
    const url = `/api/Tile?minX=${minX}&maxX=${maxX}&minY=${minY}&maxY=${maxY}`;

    // cancel the previous request if a new one starts
    inFlight?.abort();
    const ac = new AbortController();
    inFlight = ac;

    const r = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        signal: ac.signal
    });
    if (!r.ok) throw new Error(`GET tiles ${r.status}`);
    const data = await r.json();
    // clear the handle only if this is the latest
    if (inFlight === ac) inFlight = null;
    return data;
}

export async function patchTile(
    x: number, y: number, offset: number, text: string, knownVersion: number
) {
    const r = await fetch('/api/Tile/patch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ x, y, offset, text, knownVersion })
    });
    if (!r.ok) throw new Error(`PATCH ${r.status}`);
    return r.json() as Promise<{ version: number }>;
}
