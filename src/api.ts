// src/api.ts
import type { Tile } from './types';

let inFlight: AbortController | null = null;

function isAbort(err: unknown) {
    return (
        err instanceof DOMException && err.name === 'AbortError'
    ) || (
            typeof err === 'object' && err !== null && (err as any).name === 'AbortError'
        ) || String((err as any)?.message ?? '').toLowerCase().includes('abort');
}

export async function fetchTiles(
    minX: number, maxX: number, minY: number, maxY: number
): Promise<Tile[]> {
    const url = `/api/Tile?minX=${minX}&maxX=${maxX}&minY=${minY}&maxY=${maxY}`;

    // cancel the previous request if a new one starts
    inFlight?.abort();
    const ac = new AbortController();
    inFlight = ac;

    try {
        const r = await fetch(url, {
            credentials: 'include',
            cache: 'no-store',
            signal: ac.signal,
        });
        if (!r.ok) throw new Error(`GET tiles ${r.status}`);
        return r.json() as Promise<Tile[]>;
    } catch (err) {
        if (isAbort(err)) return []; // benign: user moved; ignore quietly
        throw err;                   // real error -> let caller handle/log
    } finally {
        // clear the handle only if this is the latest controller
        if (inFlight === ac) inFlight = null;
    }
}

export async function patchTile(
    x: number, y: number, offset: number, text: string, knownVersion: number, colorHex?: string
) {
    const r = await fetch('/api/Tile/patch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        cache: 'no-store',
        body: JSON.stringify({ x, y, offset, text, knownVersion, colorHex }),
    });
    if (!r.ok) throw new Error(`PATCH ${r.status}`);
    return r.json() as Promise<{ version: number }>;
}
