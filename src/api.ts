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
        if (isAbort(err)) return [];
        throw err;
    } finally {
        if (inFlight === ac) inFlight = null;
    }
}

// new helper used only for conflict recovery: no shared AbortController
export async function fetchTileExact(x: number, y: number): Promise<Tile | null> {
    const url = `/api/Tile?minX=${x}&maxX=${x}&minY=${y}&maxY=${y}`;
    const r = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
    });
    if (!r.ok) throw new Error(`GET tile ${r.status}`);
    const arr = await r.json() as Tile[];
    return arr[0] ?? null;
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

    if (!r.ok) {
        const err: any = new Error(`PATCH ${r.status}`);
        err.status = r.status;
        throw err;
    }

    return r.json() as Promise<{ version: number }>;
}
