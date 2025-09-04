import { useEffect, useRef, useState } from 'react';
import { TILE_W, TILE_H, TILE_CHARS, key, type Tile, type TileKey } from './types';
import { fetchTiles, patchTile } from './api';
import { getHub } from './signalr';
import './App.css';

type Camera = { x: number; y: number }; // world px

// --- tuning knobs ---
const FONT_PX = 14;          // letter size (you liked this)
const PAD_X = .8;           // left/right padding inside a cell
const PAD_Y = 3;           // top/bottom padding inside a cell
const DEFAULT_ZOOM_X = 0.95; // < 1.0 = slightly tighter horizontally
const DEFAULT_ZOOM_Y = 0.94; // keep your slightly zoomed-in rows
const FONT_FAMILY = '"Courier New", Courier, monospace';
const VIEW_SCALE = 1.25;
const mod = (n: number, m: number) => ((n % m) + m) % m;
const FADE_MS = 140; // fast fade-in, ~YWO(T) feel

// --- protected plaza around (0,0) in character coordinates ---
const PROTECT = { x: -10, y: -10, w: 30, h: 13 };

// text/links to show inside the plaza (centered)
const PLAZA_LINES: Array<{ text: string; link?: string }> = [
    { text: 'Welcome to the plaza' },
    { text: 'docs: example.com', link: 'https://example.com' }, // example link
];

// helper
const inProtected = (cx: number, cy: number) =>
    cx >= PROTECT.x && cx < PROTECT.x + PROTECT.w &&
    cy >= PROTECT.y && cy < PROTECT.y + PROTECT.h;

function App() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [versionTick, setVersionTick] = useState(0);
    const cam = useRef<Camera>({ x: 0, y: 0 });
    const dragging = useRef<null | { startMouseX: number; startMouseY: number; startCamX: number; startCamY: number }>(null);
    // caret in absolute character coordinates (worldwide), + anchor column for Enter
    const caret = useRef<{ cx: number; cy: number; anchorCx: number } | null>(null);

    const linkAreas = useRef<{ x: number; y: number; w: number; h: number; url: string }[]>([]);
    // recent writes: key = "cx,cy" (absolute char coords), value = timestamp (ms)
    const recentWrites = useRef<Map<string, number>>(new Map());

    // Queue of in-flight network patches per tile key
    const pending = useRef<Map<TileKey, Promise<void>>>(new Map());

    function queuePatch(t: Tile, offset: number, ch: string) {
        const k = key(t.x, t.y);
        const prev = pending.current.get(k) ?? Promise.resolve();

        // Chain the next patch after the previous finishes
        const run = prev
            .then(async () => {
                const res = await patchTile(t.x, t.y, offset, ch, t.version);
                t.version = res.version; // bump version in order
            })
            .catch(async () => {
                // On error, refetch that tile once to re-sync
                const [ref] = await fetchTiles(t.x, t.x, t.y, t.y);
                if (ref) tiles.current.set(k, ref);
            })
            .finally(() => {
                // Clear the entry if this is the last promise
                if (pending.current.get(k) === run) pending.current.delete(k);
            });

        pending.current.set(k, run);
    }

    function markRecent(cx: number, cy: number) {
        recentWrites.current.set(`${cx},${cy}`, performance.now());
    }
    // convert absolute char coords -> tile/local position
    function tileForChar(cx: number, cy: number) {
        const tx = Math.floor(cx / TILE_W);
        const ty = Math.floor(cy / TILE_H);
        const lx = ((cx % TILE_W) + TILE_W) % TILE_W; // safe mod
        const ly = ((cy % TILE_H) + TILE_H) % TILE_H;
        const offset = ly * TILE_W + lx;
        return { tx, ty, lx, ly, offset };
    }

    // ensure a tile exists in memory so you can write immediately
    function ensureTile(tx: number, ty: number) {
        const k = key(tx, ty);
        if (!tiles.current.has(k)) {
            tiles.current.set(k, { id: 0, x: tx, y: ty, data: ' '.repeat(TILE_CHARS), version: 0 });
        }
        return tiles.current.get(k)!;
    }

    const tiles = useRef<Map<TileKey, Tile>>(new Map());
    const joined = useRef<Set<TileKey>>(new Set());

    // compute cell size from font metrics + padding (+ zoom)
    function metrics(ctx: CanvasRenderingContext2D) {
        ctx.font = `${FONT_PX}px ${FONT_FAMILY}`; 
        const charW = ctx.measureText('M').width; // monospace -> constant
        const cellX = Math.round((charW + PAD_X * 2) * DEFAULT_ZOOM_X);
        const cellY = Math.round((FONT_PX + PAD_Y * 2) * DEFAULT_ZOOM_Y);
        return { cellX, cellY, charW };
    }

    // draw loop
    useEffect(() => {
        const cv = canvasRef.current!;
        const ctx = cv.getContext('2d')!;
        let af = 0;

        function resize() {
            cv.width = cv.clientWidth || window.innerWidth;
            cv.height = cv.clientHeight || window.innerHeight;
        }
        resize();
        window.addEventListener('resize', resize);

        function draw() {
            const { width, height } = cv;

            const now = performance.now();

            // How much world area is visible when scaled
            const worldW = width / VIEW_SCALE;
            const worldH = height / VIEW_SCALE;

            // Clear background (device pixels)
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, width, height);

            // compute cell sizes in WORLD units (unscaled)
            const { cellX, cellY } = metrics(ctx);

            


            // now draw everything in *world* coordinates, scaled up
            ctx.save();
            ctx.scale(VIEW_SCALE, VIEW_SCALE);

            // --- protected plaza panel at (0,0) ---
            linkAreas.current = []; // clear previous frame's link boxes

            const plazaLeft = PROTECT.x * cellX - cam.current.x;
            const plazaTop = PROTECT.y * cellY - cam.current.y;
            const plazaWpx = PROTECT.w * cellX;
            const plazaHpx = PROTECT.h * cellY;

            // panel background + border
            ctx.fillStyle = '#e6e6e6';
            ctx.fillRect(plazaLeft, plazaTop, plazaWpx, plazaHpx);
            ctx.strokeStyle = '#bdbdbd';
            ctx.strokeRect(plazaLeft + 0.5, plazaTop + 0.5, plazaWpx - 1, plazaHpx - 1);

            // centered text (and record link areas)
            ctx.font = `${FONT_PX}px ${FONT_FAMILY}`;
            ctx.textBaseline = 'top';
            ctx.fillStyle = '#333';

            const lineAdvance = FONT_PX + PAD_Y * 2;
            const totalHeight = PLAZA_LINES.length * lineAdvance;
            let yStart = plazaTop + (plazaHpx - totalHeight) / 2;

            for (const line of PLAZA_LINES) {
                const metrics = ctx.measureText(line.text);
                const lineW = Math.ceil(metrics.width);
                const x = plazaLeft + (plazaWpx - lineW) / 2;
                const y = yStart;

                // link styling (optional underline)
                if (line.link) {
                    // text
                    ctx.fillStyle = '#0044aa';
                    ctx.fillText(line.text, x, y);
                    // underline
                    ctx.beginPath();
                    ctx.moveTo(x, y + FONT_PX + 1);
                    ctx.lineTo(x + lineW, y + FONT_PX + 1);
                    ctx.strokeStyle = '#0044aa';
                    ctx.stroke();

                    // record clickable area in WORLD coords
                    linkAreas.current.push({ x, y, w: lineW, h: lineAdvance, url: line.link });
                } else {
                    ctx.fillStyle = '#333';
                    ctx.fillText(line.text, x, y);
                }

                yStart += lineAdvance;
            }

            // per-cell grid (aligned to camera) — use worldW/H
            ctx.strokeStyle = '#e3e3e3';
            const ox = mod(cam.current.x, cellX);
            const oy = mod(cam.current.y, cellY);
            for (let x = -ox; x <= worldW; x += cellX) {
                ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, worldH); ctx.stroke();
            }
            for (let y = -oy; y <= worldH; y += cellY) {
                ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(worldW, y + 0.5); ctx.stroke();
            }

            // viewport -> tile range (use worldW/H)
            const tilePxW = TILE_W * cellX, tilePxH = TILE_H * cellY;
            const minTileX = Math.floor(cam.current.x / tilePxW) - 1;
            const minTileY = Math.floor(cam.current.y / tilePxH) - 1;
            const maxTileX = Math.floor((cam.current.x + worldW) / tilePxW) + 1;
            const maxTileY = Math.floor((cam.current.y + worldH) / tilePxH) + 1;

            // draw tiles & text (unchanged, still using screenX/screenY in world units)
            ctx.font = `${FONT_PX}px ${FONT_FAMILY}`;
            ctx.textBaseline = 'top';
            for (let ty = minTileY; ty <= maxTileY; ty++) {
                for (let tx = minTileX; tx <= maxTileX; tx++) {
                    const k = key(tx, ty);
                    const tile = tiles.current.get(k);
                    const screenX = tx * tilePxW - cam.current.x;
                    const screenY = ty * tilePxH - cam.current.y;

                    ctx.strokeStyle = '#cfcfcf';
                    ctx.strokeRect(screenX + 0.5, screenY + 0.5, tilePxW - 1, tilePxH - 1);

                    if (tile) {
                        // Figure out if the caret is inside THIS tile, and which cell it’s on
                        let hiCol = -1, hiRow = -1;
                        if (caret.current) {
                            const caretTx = Math.floor(caret.current.cx / TILE_W);
                            const caretTy = Math.floor(caret.current.cy / TILE_H);
                            if (tx === caretTx && ty === caretTy) {
                                hiCol = mod(caret.current.cx, TILE_W);
                                hiRow = mod(caret.current.cy, TILE_H);
                            }
                        }

                        for (let row = 0; row < TILE_H; row++) {
                            for (let col = 0; col < TILE_W; col++) {
                                const ch = tile.data[row * TILE_W + col] ?? ' ';

                                const cellLeft = screenX + col * cellX;
                                const cellTop = screenY + row * cellY;

                                // ? absolute character coordinates for this cell
                                const cxAbs = tx * TILE_W + col;
                                const cyAbs = ty * TILE_H + row;
                                const suppressed = inProtected(cxAbs, cyAbs); // ? inside the protected box?

                                // highlight only if not suppressed
                                let isHighlighted = false;
                                if (!suppressed && hiCol !== -1 && hiRow !== -1) {
                                    isHighlighted = (col === hiCol && row === hiRow);
                                }

                                if (isHighlighted) {
                                    ctx.fillStyle = '#000000';
                                    ctx.fillRect(cellLeft + 1, cellTop + 1, cellX - 2, cellY - 2);
                                }

                                // ? don’t draw any character that’s inside the protected box
                                if (suppressed) continue;

                                // ? don’t draw any character that’s inside the protected box
                                if (suppressed) continue;

                                // Fade-in alpha if this absolute cell was just written
                                const keyRC = `${cxAbs},${cyAbs}`;
                                let alpha = 1;
                                const ts = recentWrites.current.get(keyRC);
                                if (ts !== undefined) {
                                    const t = Math.min(1, (now - ts) / FADE_MS);
                                    // ease-out cubic
                                    alpha = 1 - Math.pow(1 - t, 3);
                                    // once done, clean up
                                    if (t >= 1) recentWrites.current.delete(keyRC);
                                }

                                // text color (white on highlight, black otherwise)
                                ctx.save();
                                ctx.globalAlpha = alpha;
                                ctx.fillStyle = isHighlighted ? '#fff' : '#000';
                                ctx.fillText(ch, cellLeft + PAD_X, cellTop + PAD_Y);
                                ctx.restore();

                            }
                        }
            
                    } else {
                        ctx.fillStyle = '#888';
                        ctx.fillText('…', screenX + tilePxW / 2 - 4, screenY + tilePxH / 2 - 8);
                    }
                }
            }

            ctx.restore(); // end scaled drawing

            af = requestAnimationFrame(draw);
        }


        af = requestAnimationFrame(draw);
        return () => { cancelAnimationFrame(af); window.removeEventListener('resize', resize); };
    }, [versionTick]);

    // fetch tiles in view & maintain hub subscriptions
    async function refreshViewport() {
        const cv = canvasRef.current!;
        const ctx = cv.getContext('2d')!;
        const { cellX, cellY } = metrics(ctx);

        // visible world size when scaled
        const worldW = (cv.clientWidth || window.innerWidth) / VIEW_SCALE;
        const worldH = (cv.clientHeight || window.innerHeight) / VIEW_SCALE;

        const tilePxW = TILE_W * cellX, tilePxH = TILE_H * cellY;

        const minTileX = Math.floor(cam.current.x / tilePxW) - 1;
        const minTileY = Math.floor(cam.current.y / tilePxH) - 1;
        const maxTileX = Math.floor((cam.current.x + worldW) / tilePxW) + 1;
        const maxTileY = Math.floor((cam.current.y + worldH) / tilePxH) + 1;
        const fetched = await fetchTiles(minTileX, maxTileX, minTileY, maxTileY);

        fetched.forEach((t: Tile) => tiles.current.set(key(t.x, t.y), t));

        // join/leave groups
        const need = new Set<TileKey>();
        for (let y = minTileY; y <= maxTileY; y++) for (let x = minTileX; x <= maxTileX; x++) need.add(key(x, y));
        const hub = getHub();
        for (const k of need) {
            if (!joined.current.has(k)) {
                const [x, y] = k.split(':').map(Number);
                await hub.invoke('JoinTile', x, y);
                joined.current.add(k);
            }
        }
        for (const k of [...joined.current]) {
            if (!need.has(k)) {
                const [x, y] = k.split(':').map(Number);
                await hub.invoke('LeaveTile', x, y);
                joined.current.delete(k);
            }
        }
        setVersionTick(v => v + 1);
    }

    // boot: hub + initial viewport
    useEffect(() => {
        const hub = getHub();
        hub.on('tilePatched', (msg: { x: number; y: number; offset: number; text: string; version: number }) => {
            const t = tiles.current.get(key(msg.x, msg.y));
            if (!t) return;
            t.data = t.data.slice(0, msg.offset) + msg.text + t.data.slice(msg.offset + msg.text.length);
            t.version = msg.version;
            setVersionTick(v => v + 1);
        });

        hub.start().then(refreshViewport);
        return () => { hub.stop(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        function onPaste(e: ClipboardEvent) {
            if (!caret.current) return;

            const text = e.clipboardData?.getData('text') ?? '';
            if (!text) return;

            // Take only the first Unicode character (handles emoji/surrogates too)
            const ch = Array.from(text)[0];
            if (!ch || ch.length !== 1) return;

            // If caret is inside protected area, ignore
            if (inProtected(caret.current.cx, caret.current.cy)) return;

            // figure out which tile and offset we're writing into
            const { tx, ty, offset } = tileForChar(caret.current.cx, caret.current.cy);
            const t = ensureTile(tx, ty);

            // optimistic local write
            t.data = t.data.slice(0, offset) + ch + t.data.slice(offset + 1);
            setVersionTick(v => v + 1);

            // ? mark this cell for fade-in
            markRecent(caret.current.cx, caret.current.cy);

            // enqueue network patch (do not await)
            queuePatch(t, offset, ch);

            // advance caret
            caret.current.cx += 1;

            // Optional: prevent the browser from trying to paste into the page
            e.preventDefault();
        }

        window.addEventListener('paste', onPaste);
        return () => window.removeEventListener('paste', onPaste);
    }, []);


    // Prefetch + center camera at (0,0) on first render
    useEffect(() => {
        const cv = canvasRef.current;
        if (!cv) return;

        const worldW = (cv.clientWidth || window.innerWidth) / VIEW_SCALE;
        const worldH = (cv.clientHeight || window.innerHeight) / VIEW_SCALE;

        // center (0,0) in the middle of the screen
        cam.current.x = -worldW / 2;
        cam.current.y = -worldH / 2;

        // fetch tiles immediately so text is visible without clicking
        refreshViewport();
    }, []);

    // mouse pan (reversed like YWOT)
    function onMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
        dragging.current = { startMouseX: e.clientX, startMouseY: e.clientY, startCamX: cam.current.x, startCamY: cam.current.y };
    }
    function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
        if (!dragging.current) return;
        const dx = (e.clientX - dragging.current.startMouseX) / VIEW_SCALE;
        const dy = (e.clientY - dragging.current.startMouseY) / VIEW_SCALE;
        cam.current.x = dragging.current.startCamX - dx;
        cam.current.y = dragging.current.startCamY - dy;
    }
    async function onMouseUp() {
        if (dragging.current) { dragging.current = null; await refreshViewport(); }
    }

    // click sets caret
    function onClick(e: React.MouseEvent<HTMLCanvasElement>) {
        const cv = e.currentTarget;
        const ctx = cv.getContext('2d')!;
        const { cellX, cellY } = metrics(ctx);

        const rect = cv.getBoundingClientRect();
        const worldX = (e.clientX - rect.left) / VIEW_SCALE + cam.current.x;
        const worldY = (e.clientY - rect.top) / VIEW_SCALE + cam.current.y;

        const tilePxW = TILE_W * cellX, tilePxH = TILE_H * cellY;
        const tx = Math.floor(worldX / tilePxW);
        const ty = Math.floor(worldY / tilePxH);
        const rx = mod(worldX, tilePxW);  // 0..tilePxW-1 even if worldX is negative
        const ry = mod(worldY, tilePxH);  // 0..tilePxH-1 even if worldY is negative
        const lx = Math.floor(rx / cellX);
        const ly = Math.floor(ry / cellY);

        const cx = tx * TILE_W + lx;
        const cy = ty * TILE_H + ly;

        // 1) if click hits a plaza link, open it
        for (const a of linkAreas.current) {
            if (worldX >= a.x && worldX <= a.x + a.w &&
                worldY >= a.y && worldY <= a.y + a.h) {
                window.open(a.url, '_blank', 'noopener,noreferrer');
                return; // do not set caret
            }
        }

        // 2) if click is inside the protected area, ignore (no caret)
        const clickedCx = Math.floor(worldX / cellX);
        const clickedCy = Math.floor(worldY / cellY);
        if (inProtected(clickedCx, clickedCy)) {
            return;
        }

        ensureTile(tx, ty);
        caret.current = { cx, cy, anchorCx: cx }; // remember starting column
        setVersionTick(v => v + 1);
    }


    // keyboard typing
    useEffect(() => {
        async function onKey(e: KeyboardEvent) {
            if (!caret.current) return;

            // Enter: move to next line keeping the original column you clicked
            if (e.key === 'Enter') {
                caret.current.cy += 1;
                caret.current.cx = caret.current.anchorCx;
                setVersionTick(v => v + 1);
                return;
            }

            // Arrow keys move the absolute caret across tiles
            if (e.key === 'ArrowLeft') { caret.current.cx -= 1; setVersionTick(v => v + 1); return; }
            if (e.key === 'ArrowRight') { caret.current.cx += 1; setVersionTick(v => v + 1); return; }
            if (e.key === 'ArrowUp') { caret.current.cy -= 1; setVersionTick(v => v + 1); return; }
            if (e.key === 'ArrowDown') { caret.current.cy += 1; setVersionTick(v => v + 1); return; }

            // Only handle single printable characters here
            if (e.key.length !== 1) return;

            // If caret is inside protected area, do nothing
            if (caret.current && inProtected(caret.current.cx, caret.current.cy)) {
                return;
            }

            // figure out which tile and offset we're writing into
            const { tx, ty, offset } = tileForChar(caret.current.cx, caret.current.cy);
            const t = ensureTile(tx, ty);

            // optimistic local write
            t.data = t.data.slice(0, offset) + e.key + t.data.slice(offset + 1);
            setVersionTick(v => v + 1);

            // ? mark this cell for fade-in (use the current caret position)
            markRecent(caret.current.cx, caret.current.cy);

            // send to server, enqueue network patch (do not await)
            queuePatch(t, offset, e.key);


            // advance caret to the right — infinite across tiles
            caret.current.cx += 1;
            setVersionTick(v => v + 1);
        }

        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);


    return (
        <>
            <div className="toolbar">drag to pan • click to set caret • type to edit</div>
            <canvas
                ref={canvasRef}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
                onMouseLeave={onMouseUp}
                onClick={onClick}
            />
        </>
    );
}

export default App;
