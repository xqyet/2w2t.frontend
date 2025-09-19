import { useEffect, useRef, useState } from 'react';
import { TILE_W, TILE_H, TILE_CHARS, key, type Tile, type TileKey } from './types';
import { fetchTiles, patchTile } from './api';
import { getHub } from './signalr';
import './App.css';

declare global {
    interface Window {
        tw2tTeleport?: (opts: {
            x: number;
            y: number;
            units?: 'char' | 'tile' | 'unit';
            center?: boolean;
            placeCaret?: boolean;
            animateMs?: number;
        }) => Promise<void>;
    }
}

type Camera = { x: number; y: number }; // world px

// --- tuning knobs ---
const FONT_PX = 14;          // letter size (you liked this)
const PAD_X = .8;           // left/right padding inside a cell
const PAD_Y = 3;           // top/bottom padding inside a cell
const DEFAULT_ZOOM_X = 0.95; // < 1.0 = slightly tighter horizontally
const DEFAULT_ZOOM_Y = 0.94; // keep your slightly zoomed-in rows
const FONT_FAMILY = '"Courier New", Courier, monospace';
const TIGHTEN_Y = 4; // vertical space for tiles 
const TIGHTEN_X = 1.5; // horixontal space for tiles 
const VIEW_SCALE = 1.18; // users camera view scale
const mod = (n: number, m: number) => ((n % m) + m) % m;
const FADE_MS = 145; // fade
const SAMPLE_MS = 180;     // fling velocity
const FLING_SCALE = 0.6;   // initial fling
const DECAY_PER_MS = 0.007; // higher = stops faster
const MIN_SPEED = 0.00006;  // higher = stops earlier
const QUIET_WINDOW_MS = 25; // camera fling timer
const QUIET_DIST_PX = 6;   // variable to record movement (used in fling function)
const COORD_UNIT = 10; // new way to calculate coords (divide by 10, is much cleaner)
const DRAG_SENS = 0.9; // lower = less sensitive 
const FETCH_THROTTLE_MS = 80; // viewport fetch for page reload
const PEER_TYPING_TTL_MS = 900; // how long caret stays visible
const MAX_CHARS_ABS = 2_000_000_000; // teleport limit (world is infinite but I need a teleport limit to prevent browser strain)


// --- visual toggles ---
const SHOW_GRID = false;              
const SHOW_TILE_BORDERS = false;      
const SHOW_MISSING_PLACEHOLDER = false; 

// --- protected plaza around (0,0) in character coordinates ---
const PROTECT = { x: -10, y: -10, w: 35, h: 16 };

// text/links to show inside the plaza (centered)
const PLAZA_LINES: Array<{ text: string; link?: string; gap?: number }> = [
    { text: '2W2T', },
    { text: '~2writers2tiles~', gap: 8 },
    { text: 'An Infinite Void to\nwrite, create, and destroy', gap: 8 }, 
    { text: 'Chat with other users you find\nin the void!', gap:8 },
    { text: 'How to Paste ASCII Art', link: 'https://github.com/xqyet/2w2t.ASCII#ascii-script', gap:6 },
    { text: 'How to Teleport', link: 'https://github.com/xqyet/2w2t.ASCII#teleport-script', gap:6 },
    { text: 'source code', link: 'https://github.com/xqyet/2w2t.frontend' },

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
    const caret = useRef<{ cx: number; cy: number; anchorCx: number } | null>(null);
    const velocity = useRef<{ vx: number; vy: number }>({ vx: 0, vy: 0 });
    const isInertial = useRef(false);
    const samples = useRef<Array<{ x: number; y: number; t: number }>>([]);
    const lastRect = useRef<{ minX: number; minY: number; maxX: number; maxY: number } | null>(null);
    const fetchTimer = useRef<number | null>(null);
    const mobileInputRef = useRef<HTMLInputElement>(null);
    const peerCarets = useRef<Map<string, { cx: number; cy: number; ts: number }>>(new Map());
    const hoverCell = useRef<{ cx: number; cy: number } | null>(null);
    const lastTypingSentAt = useRef(0);
    const isMobileInputFocused = () =>
        document.activeElement === mobileInputRef.current;

    const linkAreas = useRef<{ x: number; y: number; w: number; h: number; url: string }[]>([]);
    const recentWrites = useRef<Map<string, number>>(new Map());
    const inputQueue = useRef<Promise<void>>(Promise.resolve());
    const colorLayer = useRef<Map<string, string>>(new Map());
    const tapStart = useRef<{ x: number; y: number; t: number } | null>(null);
    const lastTouch = useRef<{ x: number; y: number } | null>(null);
    const followCaret = useRef(false);
    const ZWS = '\u200B';
    const CLEAR_HEX = '000000';
    function toHex6(input?: string): string | undefined {
        if (!input) return undefined;
        let s = input.trim();
        // #rrggbb
        if (/^#?[0-9a-fA-F]{6}$/.test(s)) return s.replace('#', '').toLowerCase();
        // #rgb
        if (/^#?[0-9a-fA-F]{3}$/.test(s)) {
            s = s.replace('#', '');
            return s.split('').map(c => c + c).join('').toLowerCase();
        }
        // rgb(r,g,b)
        const m = s.match(/^rgb\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*\)$/i);
        if (m) {
            const [r, g, b] = [m[1], m[2], m[3]].map(n => Math.max(0, Math.min(255, +n)));
            const h = (n: number) => n.toString(16).padStart(2, '0');
            return `${h(r)}${h(g)}${h(b)}`;
        }
        return undefined; // (we can expand later if needed)
    }

    function getServerColorAt(tile: Tile, offset: number): string | undefined {
        if (!tile.color || tile.color.length !== TILE_CHARS * 6) return undefined;
        const hex = tile.color.slice(offset * 6, offset * 6 + 6);
        if (!hex || /^0{6}$/.test(hex)) return undefined; // "unset"
        return `#${hex}`;
    }

    function setLocalColorAt(tile: Tile, offset: number, hex6: string) {
        // ensure color string is the right size
        if (!tile.color || tile.color.length !== TILE_CHARS * 6) {
            tile.color = '0'.repeat(TILE_CHARS * 6);
        }
        const start = offset * 6;
        tile.color = tile.color.slice(0, start) + hex6 + tile.color.slice(start + 6);
    }
    function enqueueEdit(fn: () => Promise<void> | void) {
        inputQueue.current = inputQueue.current.then(async () => { await fn(); });
        return inputQueue.current.catch(() => { }); 
    }
    // Queue of in-flight network patches per tile key
    const pending = useRef<Map<TileKey, Promise<void>>>(new Map());
    function queuePatch(t: Tile, offset: number, ch: string, color?: string) {
        const k = key(t.x, t.y);
        const prev = pending.current.get(k) ?? Promise.resolve();

        // optimistic local color (if provided)
        const hex6 = toHex6(color);
        if (hex6) setLocalColorAt(t, offset, hex6);

        const run = prev
            .then(async () => {
                const res = await patchTile(t.x, t.y, offset, ch, t.version, hex6);
                t.version = res.version;
            })
            .catch(async () => {
                const [ref] = await fetchTiles(t.x, t.x, t.y, t.y);
                if (ref) tiles.current.set(k, ref);
            })
            .finally(() => {
                if (pending.current.get(k) === run) pending.current.delete(k);
            });

        pending.current.set(k, run);
    }
    function sendTyping(tx: number, ty: number, lx: number, ly: number) {
        const now = performance.now();
        if (now - lastTypingSentAt.current < 60) return; 
        lastTypingSentAt.current = now;

        hubSafeInvoke('Typing', tx, ty, lx, ly);
    }
    function focusMobileInput() {
        const isTouch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
        if (!isTouch) return;
        const el = mobileInputRef.current;
        if (el) el.focus({ preventScroll: true });
        primeMobileInput(); 
    }
    function primeMobileInput() {
        const el = mobileInputRef.current;
        if (!el) return;
        el.value = ZWS;
        try { el.setSelectionRange(1, 1); } catch { }
    }
    function currentTileRect(ctx: CanvasRenderingContext2D) {
        const { cellX, cellY } = metrics(ctx);
        const cv = canvasRef.current!;
        const worldW = (cv.clientWidth || window.innerWidth) / VIEW_SCALE;
        const worldH = (cv.clientHeight || window.innerHeight) / VIEW_SCALE;
        const tilePxW = TILE_W * cellX, tilePxH = TILE_H * cellY;

        const minTileX = Math.floor(cam.current.x / tilePxW) - 2;
        const minTileY = Math.floor(cam.current.y / tilePxH) - 2;
        const maxTileX = Math.floor((cam.current.x + worldW) / tilePxW) + 2;
        const maxTileY = Math.floor((cam.current.y + worldH) / tilePxH) + 2;
        return { minX: minTileX, minY: minTileY, maxX: maxTileX, maxY: maxTileY };
    }
    function scheduleViewportFetch() {
        if (fetchTimer.current !== null) return; 
        fetchTimer.current = window.setTimeout(async () => {
            fetchTimer.current = null;
            await refreshViewport();
        }, FETCH_THROTTLE_MS) as unknown as number;
    }
    function onMobileBeforeInput(e: React.FormEvent<HTMLInputElement>) {
        if (!caret.current) return;
        const ne = e.nativeEvent as unknown as InputEvent;
        const type = (ne && (ne as any).inputType) || '';

        if (type === 'deleteContentBackward' || type === 'deleteWordBackward' || type === 'deleteHardLineBackward') {
            e.preventDefault(); 

            enqueueEdit(() => {
                if (!caret.current) return;
                const snapCx = caret.current.cx - 1;
                const snapCy = caret.current.cy;
                if (inProtected(snapCx, snapCy)) return;

                caret.current.cx = snapCx;
                const { tx, ty, offset } = tileForChar(snapCx, snapCy);
                sendTyping(tx, ty, offset % TILE_W, Math.floor(offset / TILE_W));
                const t = ensureTile(tx, ty);

                t.data = t.data.slice(0, offset) + ' ' + t.data.slice(offset + 1);
                setVersionTick(v => v + 1);
                markRecent(snapCx, snapCy);
                colorLayer.current.delete(`${snapCx},${snapCy}`);
                queuePatch(t, offset, ' ', `#${CLEAR_HEX}`);
                followCaret.current = true;
                if (ensureCaretEdgeFollow()) { refreshViewport(); }
            });

            primeMobileInput();
        }
    }

    function onMobileInput(e: React.FormEvent<HTMLInputElement>) {
        if (!caret.current) {
            (e.currentTarget as HTMLInputElement).value = '';
            primeMobileInput();
            return;
        }

        const el = e.currentTarget;
        const ne = e.nativeEvent as unknown as InputEvent;
        const inputType = (ne && (ne as any).inputType) || '';

        if (inputType && inputType.startsWith('delete')) {
            enqueueEdit(() => {
                if (!caret.current) return;
                const snapCx = caret.current.cx - 1;
                const snapCy = caret.current.cy;
                if (inProtected(snapCx, snapCy)) return;

                caret.current.cx = snapCx;

                const { tx, ty, offset, lx, ly } = tileForChar(snapCx, snapCy);
                sendTyping(tx, ty, lx, ly);

                const t = ensureTile(tx, ty);
                t.data = t.data.slice(0, offset) + ' ' + t.data.slice(offset + 1);
                setVersionTick(v => v + 1);

                markRecent(snapCx, snapCy);
                colorLayer.current.delete(`${snapCx},${snapCy}`);
                queuePatch(t, offset, ' ', `#${CLEAR_HEX}`); 

                followCaret.current = true;
                if (ensureCaretEdgeFollow()) { refreshViewport(); }
            });

            el.value = '';
            primeMobileInput();
            return;
        }

        const typed = el.value.split(ZWS).join('');
        if (typed) {
            for (const ch of Array.from(typed)) {
                enqueueEdit(() => {
                    if (!caret.current) return;

                    const snapCx = caret.current!.cx;
                    const snapCy = caret.current!.cy;
                    if (inProtected(snapCx, snapCy)) return;

                    const { tx, ty, offset, lx, ly } = tileForChar(snapCx, snapCy);
                    sendTyping(tx, ty, lx, ly);

                    const t = ensureTile(tx, ty);
                    t.data = t.data.slice(0, offset) + ch + t.data.slice(offset + 1);
                    setVersionTick(v => v + 1);

                    markRecent(snapCx, snapCy);
                    queuePatch(t, offset, ch);

                    if (caret.current) {
                        caret.current.cx = snapCx + 1;
                        setVersionTick(v => v + 1);
                        followCaret.current = true;
                        if (ensureCaretEdgeFollow()) { refreshViewport(); }
                    }
                });
            }
        }

        el.value = '';
        primeMobileInput();
    }


    function keepFocusIfEditing() {
        if (caret.current) setTimeout(() => focusMobileInput(), 0);
    }

    function ensureCaretEdgeFollow(): boolean {
        if (!caret.current) return false;
        const cv = canvasRef.current!;
        const ctx = cv.getContext('2d')!;
        const { cellX, cellY } = metrics(ctx);
        const worldW = (cv.clientWidth || window.innerWidth) / VIEW_SCALE;
        const worldH = (cv.clientHeight || window.innerHeight) / VIEW_SCALE;
        const cX = caret.current.cx * cellX;
        const cY = caret.current.cy * cellY;
        const left = cam.current.x;
        const top = cam.current.y;
        const right = cam.current.x + worldW;
        const bottom = cam.current.y + worldH;
        let moved = false;

        if (cX < left) {
            cam.current.x = cX;
            moved = true;
        }

        if (cX + cellX > right) {
            cam.current.x = cX + cellX - worldW;
            moved = true;
        }

        if (cY < top) {
            cam.current.y = cY;
            moved = true;
        }
        if (cY + cellY > bottom) {
            cam.current.y = cY + cellY - worldH;
            moved = true;
        }

        return moved;
    }

    function hubSafeInvoke<T = unknown>(method: string, ...args: any[]): Promise<T | void> {
        const hub = getHub();
        // @ts-ignore — SignalR ConnectionState enum varies by version;
        if (hub.state !== 'Connected') return Promise.resolve();
        return hub.invoke(method, ...args).catch(() => { });
    }


    function markRecent(cx: number, cy: number) {
        recentWrites.current.set(`${cx},${cy}`, performance.now());
    }
    // converting absolute char coords -> tile/local position
    function tileForChar(cx: number, cy: number) {
        const tx = Math.floor(cx / TILE_W);
        const ty = Math.floor(cy / TILE_H);
        const lx = ((cx % TILE_W) + TILE_W) % TILE_W; 
        const ly = ((cy % TILE_H) + TILE_H) % TILE_H;
        const offset = ly * TILE_W + lx;
        return { tx, ty, lx, ly, offset };
    }

    function getCharAt(cx: number, cy: number): string {
        const { tx, ty, offset } = tileForChar(cx, cy);
        const t = tiles.current.get(key(tx, ty));
        if (!t) return ' ';    
        return t.data[offset] ?? ' ';
    }


    // ensuring a tile exists in memory so you can write immediately
    function ensureTile(tx: number, ty: number) {
        const k = key(tx, ty);
        if (!tiles.current.has(k)) {
            tiles.current.set(k, {
                id: 0,
                x: tx,
                y: ty,
                data: ' '.repeat(TILE_CHARS),
                color: '0'.repeat(TILE_CHARS * 6), // NEW
                version: 0
            });
        }
        return tiles.current.get(k)!;
    }

    const tiles = useRef<Map<TileKey, Tile>>(new Map());
    const joined = useRef<Set<TileKey>>(new Set());

    // computing cell size from font metrics + padding (+ zoom)
    function metrics(ctx: CanvasRenderingContext2D) {
        ctx.font = `${FONT_PX}px ${FONT_FAMILY}`;
        const charW = ctx.measureText('M').width; // monospace -> constant
        const cellX = Math.round((charW + PAD_X * 2 - TIGHTEN_X) * DEFAULT_ZOOM_X);
        const cellY = Math.round((FONT_PX + PAD_Y * 2 - TIGHTEN_Y) * DEFAULT_ZOOM_Y);
        return { cellX, cellY, charW };
    }

    // Convert "unit"/"tile"/"char" to absolute character coordinates (will recalculate ui later)
    function toCharCoords(
        x: number,
        y: number,
        units: 'char' | 'tile' | 'unit'
    ): { cx: number; cy: number } {
        if (units === 'char') return { cx: Math.trunc(x), cy: Math.trunc(y) };
        if (units === 'tile') return { cx: Math.trunc(x * TILE_W), cy: Math.trunc(y * TILE_H) };
        return { cx: Math.trunc(x * COORD_UNIT), cy: Math.trunc(y * COORD_UNIT) };
    }

    function clampChar(n: number) {
        if (!Number.isFinite(n)) return 0;
        const i = Math.trunc(n);
        return Math.max(-MAX_CHARS_ABS, Math.min(MAX_CHARS_ABS, i));
    }

    function cameraTargetForChar(cx: number, cy: number) {
        const cv = canvasRef.current!;
        const ctx = cv.getContext('2d')!;
        const { cellX, cellY } = metrics(ctx);

        const worldW = (cv.clientWidth || window.innerWidth) / VIEW_SCALE;
        const worldH = (cv.clientHeight || window.innerHeight) / VIEW_SCALE;

        const targetWorldX = cx * cellX;
        const targetWorldY = cy * cellY;

        const camX = targetWorldX - worldW / 2;
        const camY = targetWorldY - worldH / 2;
        return { camX, camY };
    }

    function placeCaretAtChar(cx: number, cy: number) {
        const { tx, ty } = tileForChar(cx, cy);
        ensureTile(tx, ty);
        caret.current = { cx, cy, anchorCx: cx };
        setVersionTick(v => v + 1);
    }
    async function animateCameraTo(targetX: number, targetY: number, animateMs: number) {
        const startX = cam.current.x;
        const startY = cam.current.y;
        const start = performance.now();
        const dur = Math.max(0, animateMs);

        return new Promise<void>(resolve => {
            if (dur === 0) {
                cam.current.x = targetX;
                cam.current.y = targetY;
                setVersionTick(v => v + 1);
                resolve();
                return;
            }

            function step(now: number) {
                const t = Math.min(1, (now - start) / dur);
                const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
                cam.current.x = startX + (targetX - startX) * e;
                cam.current.y = startY + (targetY - startY) * e;
                setVersionTick(v => v + 1);

                if (t < 1) {
                    requestAnimationFrame(step);
                } else {
                    resolve();
                }
            }
            requestAnimationFrame(step);
        });
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
            const worldW = width / VIEW_SCALE;
            const worldH = height / VIEW_SCALE;

            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, width, height);

            const { cellX, cellY } = metrics(ctx);

            ctx.save();
            ctx.scale(VIEW_SCALE, VIEW_SCALE);

            // --- protected plaza at (0,0) --- //
            linkAreas.current = []; 

            const plazaLeft = PROTECT.x * cellX - cam.current.x;
            const plazaTop = PROTECT.y * cellY - cam.current.y;
            const plazaWpx = PROTECT.w * cellX;
            const plazaHpx = PROTECT.h * cellY;

            ctx.fillStyle = '#e6e6e6';
            ctx.fillRect(plazaLeft, plazaTop, plazaWpx, plazaHpx);
            ctx.strokeStyle = '#bdbdbd';
            ctx.strokeRect(plazaLeft + 0.5, plazaTop + 0.5, plazaWpx - 1, plazaHpx - 1);
            ctx.font = `${FONT_PX}px ${FONT_FAMILY}`;
            ctx.textBaseline = 'top';
            ctx.fillStyle = '#333';

            const lineAdvance = FONT_PX + PAD_Y * 2;
            const totalHeight = PLAZA_LINES.length * lineAdvance;
            let yStart = plazaTop + (plazaHpx - totalHeight) / 2-40;

            for (const line of PLAZA_LINES) {
                const parts = line.text.split('\n');

                for (const part of parts) {
                    const m = ctx.measureText(part);
                    const lineW = Math.ceil(m.width);
                    const x = plazaLeft + (plazaWpx - lineW) / 2;
                    const y = yStart;

                    if (line.link) {
                        ctx.fillStyle = '#0044aa';
                        ctx.fillText(part, x, y);
                        ctx.beginPath();
                        ctx.moveTo(x, y + FONT_PX + 1);
                        ctx.lineTo(x + lineW, y + FONT_PX + 1);
                        ctx.strokeStyle = '#0044aa';
                        ctx.stroke();

                        linkAreas.current.push({ x, y, w: lineW, h: lineAdvance, url: line.link });
                    } else {
                        ctx.fillStyle = '#333';
                        ctx.fillText(part, x, y);
                    }

                    yStart += lineAdvance; 
                }

                yStart += (line.gap ?? 0);
            }

            if (SHOW_GRID) {
                ctx.strokeStyle = '#e3e3e3';
                const ox = mod(cam.current.x, cellX);
                const oy = mod(cam.current.y, cellY);
                for (let x = -ox; x <= worldW; x += cellX) {
                    ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, worldH); ctx.stroke();
                }
                for (let y = -oy; y <= worldH; y += cellY) {
                    ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(worldW, y + 0.5); ctx.stroke();
                }
            }

            const tilePxW = TILE_W * cellX, tilePxH = TILE_H * cellY;
            const minTileX = Math.floor(cam.current.x / tilePxW) - 1;
            const minTileY = Math.floor(cam.current.y / tilePxH) - 1;
            const maxTileX = Math.floor((cam.current.x + worldW) / tilePxW) + 1;
            const maxTileY = Math.floor((cam.current.y + worldH) / tilePxH) + 1;

            ctx.font = `${FONT_PX}px ${FONT_FAMILY}`;
            ctx.textBaseline = 'top';
            for (let ty = minTileY; ty <= maxTileY; ty++) {
                for (let tx = minTileX; tx <= maxTileX; tx++) {
                    const k = key(tx, ty);
                    const tile = tiles.current.get(k);
                    const screenX = tx * tilePxW - cam.current.x;
                    const screenY = ty * tilePxH - cam.current.y;

                    ctx.strokeStyle = '#cfcfcf';
                    if (SHOW_TILE_BORDERS) {
                        ctx.strokeStyle = '#cfcfcf';
                        ctx.strokeRect(screenX + 0.5, screenY + 0.5, tilePxW - 1, tilePxH - 1);
                    }

                    if (tile) {
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
                                const suppressed = inProtected(cxAbs, cyAbs); 

                                let isHighlighted = false;
                                if (!suppressed && hiCol !== -1 && hiRow !== -1) {
                                    isHighlighted = (col === hiCol && row === hiRow);
                                }

                                if (isHighlighted) {
                                    ctx.fillStyle = '#000000';
                                    ctx.fillRect(cellLeft + 1, cellTop + 1, cellX - 0, cellY + 2);
                                }

                                if (suppressed) continue;
                                if (suppressed) continue;

                                const keyRC = `${cxAbs},${cyAbs}`;
                                let alpha = 1;
                                const ts = recentWrites.current.get(keyRC);
                                if (ts !== undefined) {
                                    const t = Math.min(1, (now - ts) / FADE_MS);
                                    alpha = 1 - Math.pow(1 - t, 3);
                                    if (t >= 1) recentWrites.current.delete(keyRC);
                                }

                                ctx.save();
                                ctx.globalAlpha = alpha;
                                const cellKey = keyRC; // `${cxAbs},${cyAbs}`
                                const idx = row * TILE_W + col;
                                const fgServer = getServerColorAt(tile, idx);
                                const fg = isHighlighted
                                    ? '#fff'
                                    : (colorLayer.current.get(cellKey) ?? fgServer ?? '#000');
                                ctx.fillStyle = fg;
                                ctx.fillText(ch, cellLeft + PAD_X, cellTop + PAD_Y);

                                {
                                    const nowPeers = performance.now();
                                    for (const [id, info] of [...peerCarets.current]) {
                                        if (nowPeers - info.ts > PEER_TYPING_TTL_MS) {
                                            peerCarets.current.delete(id);
                                            continue;
                                        }
                                        const left = info.cx * cellX - cam.current.x;
                                        const top = info.cy * cellY - cam.current.y;

                                        // continue if (left + cellX < 0 || top + cellY < 0 || left > worldW || top > worldH);
                                        ctx.fillStyle = '#000';
                                        ctx.fillRect(left + 1, top + 1, cellX - 0, cellY + 2);
                                    }
                                }

                                ctx.restore();



                            }
                        }

                    } else if (SHOW_MISSING_PLACEHOLDER) {
                        ctx.fillStyle = '#888';
                        ctx.fillText('…', screenX + tilePxW / 2 - 4, screenY + tilePxH / 2 - 8);
                    }
                }
            }

            ctx.restore(); 

            // --- HUD: center coordinates in bottom-right (device pixels) --- //
            {
                const centerWorldX = cam.current.x + worldW / 2;
                const centerWorldY = cam.current.y + worldH / 2;
                const cxCenterExact = centerWorldX / cellX;
                const cyCenterExact = centerWorldY / cellY;
                const dispX = Math.trunc(cxCenterExact / COORD_UNIT);
                const dispY = Math.trunc(cyCenterExact / COORD_UNIT);
                const fmt = new Intl.NumberFormat('en-US'); 
                const hudText = `X:${fmt.format(dispX)} Y:${fmt.format(dispY)}`;

                ctx.save();
                ctx.font = '18px "Courier New", Courier, monospace';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';

                const m = ctx.measureText(hudText);
                const textW = Math.ceil(m.width);
                const textH =
                    (m.actualBoundingBoxAscent ?? 14) + (m.actualBoundingBoxDescent ?? 4);
                const padX = 12;
                const padY = 8;
                const boxW = textW + padX * 2;
                const boxH = textH + padY * 2;
                const bx = cv.width - boxW;
                const by = cv.height - boxH;
                const r = 10;
                function roundRect(x: number, y: number, w: number, h: number, rad: number) {
                    const rr = Math.min(rad, w / 2, h / 2);
                    ctx.beginPath();
                    ctx.moveTo(x + rr, y);
                    ctx.lineTo(x + w - rr, y);
                    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
                    ctx.lineTo(x + w, y + h - rr);
                    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
                    ctx.lineTo(x + rr, y + h);
                    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
                    ctx.lineTo(x, y + rr);
                    ctx.quadraticCurveTo(x, y, x + rr, y);
                    ctx.closePath();
                }


                roundRect(bx, by, boxW, boxH, r);
                ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';   
                ctx.fill();
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)'; 
                ctx.stroke();
                ctx.fillStyle = '#000';
                ctx.fillText(hudText, bx + padX, by + boxH / 2);
                ctx.restore();
            }

            af = requestAnimationFrame(draw);
        }

        af = requestAnimationFrame(draw);
        return () => { cancelAnimationFrame(af); window.removeEventListener('resize', resize); };
    }, [versionTick]);

    // primary async to fetch tiles in view & maintain hub subscriptions
    async function refreshViewport() {
        const cv = canvasRef.current!;
        const ctx = cv.getContext('2d')!;
        const { cellX, cellY } = metrics(ctx);
        const worldW = (cv.clientWidth || window.innerWidth) / VIEW_SCALE;
        const worldH = (cv.clientHeight || window.innerHeight) / VIEW_SCALE;
        const tilePxW = TILE_W * cellX, tilePxH = TILE_H * cellY;
        const minTileX = Math.floor(cam.current.x / tilePxW) - 2;
        const minTileY = Math.floor(cam.current.y / tilePxH) - 2;
        const maxTileX = Math.floor((cam.current.x + worldW) / tilePxW) + 2;
        const maxTileY = Math.floor((cam.current.y + worldH) / tilePxH) + 2;
        const fetched = await fetchTiles(minTileX, maxTileX, minTileY, maxTileY);
        fetched.forEach((t: Tile) => tiles.current.set(key(t.x, t.y), t));

        const need = new Set<TileKey>();
        for (let y = minTileY; y <= maxTileY; y++) for (let x = minTileX; x <= maxTileX; x++) need.add(key(x, y));
        for (const k of need) {
            if (!joined.current.has(k)) {
                const [x, y] = k.split(':').map(Number);
                await hubSafeInvoke('JoinTile', x, y);
                joined.current.add(k);
            }
        }
        for (const k of [...joined.current]) {
            if (!need.has(k)) {
                const [x, y] = k.split(':').map(Number);
                await hubSafeInvoke('LeaveTile', x, y);
                joined.current.delete(k);
            }
        }
        setVersionTick(v => v + 1);
        lastRect.current = { minX: minTileX, minY: minTileY, maxX: maxTileX, maxY: maxTileY };
    }

    useEffect(() => {
        (window as any).tw2tWriteChar = (ch: string, color?: string) => {
            if (!caret.current || !ch || Array.from(ch).length !== 1) return;
            const snapCx = caret.current.cx;
            const snapCy = caret.current.cy;
            if (inProtected(snapCx, snapCy)) return;

            const { tx, ty, offset } = tileForChar(snapCx, snapCy);
            const t = ensureTile(tx, ty);

            // local write
            t.data = t.data.slice(0, offset) + ch + t.data.slice(offset + 1);

            // transient overlay so you immediately see the color
            const absKey = `${snapCx},${snapCy}`;
            if (color) colorLayer.current.set(absKey, color);

            setVersionTick(v => v + 1);
            markRecent(snapCx, snapCy);

            // send to server with color
            queuePatch(t, offset, ch, color);

            caret.current.cx = snapCx + 1;
            followCaret.current = true;
            if (ensureCaretEdgeFollow()) { refreshViewport(); }
        };

        return () => { delete (window as any).tw2tWriteChar; };
    }, []);



    useEffect(() => {
        window.tw2tTeleport = async (opts) => {
            const {
                x,
                y,
                units = 'unit',
                center = true,
                placeCaret = true,
                animateMs = 500
            } = opts;

            // convert ? clamp
            let { cx, cy } = toCharCoords(x, y, units);
            const rawCx = cx, rawCy = cy;
            cx = clampChar(cx);
            cy = clampChar(cy);
            if (cx !== rawCx || cy !== rawCy) {
                console.warn('[2w2t] Teleport clamped to safe bounds:', { cx, cy });
            }

            const wantCaret = placeCaret && !inProtected(cx, cy);
            const { camX: targetCamX, camY: targetCamY } = cameraTargetForChar(cx, cy);
            const ms = Math.max(0, Math.min(4000, Math.trunc(animateMs)));

            if (center) {
                await animateCameraTo(targetCamX, targetCamY, ms);
            } else {
                cam.current.x = targetCamX;
                cam.current.y = targetCamY;
                setVersionTick(v => v + 1);
            }

            try { await refreshViewport(); } catch (e) { console.warn('refreshViewport failed', e); }

            if (wantCaret) {
                placeCaretAtChar(cx, cy);
                focusMobileInput();
            }
        };

        return () => { delete window.tw2tTeleport; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        function onUR(e: PromiseRejectionEvent) {
            const msg = String((e as any)?.reason?.message ?? '');
            if (msg.includes("connection is not in the 'Connected' State")) {
                e.preventDefault(); 
            }
        }
        window.addEventListener('unhandledrejection', onUR);
        return () => window.removeEventListener('unhandledrejection', onUR);
    }, []);

    // boot: hub + initial viewport
    useEffect(() => {
        const hub = getHub();
        hub.on('tilePatched', (msg: {
            x: number; y: number; offset: number; text: string; color?: string; version: number
        }) => {
            const t = tiles.current.get(key(msg.x, msg.y));
            if (!t) return;

            // apply text
            t.data = t.data.slice(0, msg.offset) + msg.text + t.data.slice(msg.offset + msg.text.length);

            // apply color if provided (server sends '#rrggbb' or undefined)
            if (msg.color) {
                const hex6 = toHex6(msg.color);
                if (hex6) setLocalColorAt(t, msg.offset, hex6);
            }

            t.version = msg.version;
            setVersionTick(v => v + 1);
        });


        hub.on('peerTyping', (msg: { x: number; y: number; col: number; row: number; sender: string }) => {
            const cx = msg.x * TILE_W + msg.col;
            const cy = msg.y * TILE_H + msg.row;
            peerCarets.current.set(msg.sender, { cx, cy, ts: performance.now() });
            setVersionTick(v => v + 1); 
        });

        hub.start().then(refreshViewport).catch(() => { });
        return () => { hub.stop().catch(() => { }); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        function onPaste(e: ClipboardEvent) {
            if (isMobileInputFocused() && e.isTrusted) return; 
            if (!caret.current) return;

            const html = e.clipboardData?.getData('text/html') ?? '';
            const text = e.clipboardData?.getData('text') ?? '';
            if (!text) return;

            // first Unicode code point only (your editor is 1 char per cell)
            const ch = Array.from(text)[0];
            if (!ch || ch.length !== 1) return;

            // try to extract a foreground color for the first visible character from HTML
            let fgColor: string | undefined;
            if (html) {
                // crude but effective: parse a temp DOM and find the first element that styles color
                const div = document.createElement('div');
                div.innerHTML = html;

                // depth-first search for first colored text node
                function findFirstColored(node: Node, inherited?: string): string | undefined {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        const el = node as HTMLElement;
                        // prefer inline style="color: ...", fall back to attribute data
                        const styleColor =
                            el.style?.color ||
                            // sometimes tools set color via <font color="#..."> (rare today)
                            (el as any).color ||
                            undefined;
                        const current = styleColor || inherited;

                        for (const child of Array.from(el.childNodes)) {
                            const c = findFirstColored(child, current);
                            if (c) return c;
                        }
                        return undefined;
                    }
                    if (node.nodeType === Node.TEXT_NODE) {
                        const txt = node.textContent ?? '';
                        if (txt.trim().length > 0) return inherited;
                    }
                    return undefined;
                }

                const c = findFirstColored(div);
                if (c) {
                    // Normalize common formats to a canvas-friendly string
                    // e.g. "rgb(255, 0, 0)" or "#ff00aa" are fine as-is
                    fgColor = c.toString();
                }
            }


            if (inProtected(caret.current.cx, caret.current.cy)) return;

            const { tx, ty, offset } = tileForChar(caret.current.cx, caret.current.cy);
            const t = ensureTile(tx, ty);

            // optimistic local write
            t.data = t.data.slice(0, offset) + ch + t.data.slice(offset + 1);
            setVersionTick(v => v + 1);
            markRecent(caret.current.cx, caret.current.cy);
            queuePatch(t, offset, ch, fgColor);

            const absKey = `${caret.current.cx},${caret.current.cy}`;
            if (fgColor) colorLayer.current.set(absKey, fgColor);
            
                caret.current.cx += 1;
            followCaret.current = true;

            if (followCaret.current && ensureCaretEdgeFollow()) { refreshViewport(); }

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

        cam.current.x = -worldW / 2;
        cam.current.y = -worldH / 2;

        refreshViewport();
    }, []);

    function onMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
        followCaret.current = false;
        dragging.current = {
            startMouseX: e.clientX,
            startMouseY: e.clientY,
            startCamX: cam.current.x,
            startCamY: cam.current.y,
        };
        isInertial.current = false; 
        samples.current = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
    }

    function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
        const cv = e.currentTarget;
        const rect = cv.getBoundingClientRect();
        const screenWorldX = (e.clientX - rect.left) / VIEW_SCALE;
        const screenWorldY = (e.clientY - rect.top) / VIEW_SCALE;

        const overLink = linkAreas.current.some(a =>
            screenWorldX >= a.x && screenWorldX <= a.x + a.w &&
            screenWorldY >= a.y && screenWorldY <= a.y + a.h
        );

        cv.style.cursor = dragging.current
            ? 'grabbing'
            : (overLink ? 'pointer' : 'default');

        {
            const cv = e.currentTarget;
            const ctx = cv.getContext('2d')!;
            const { cellX, cellY } = metrics(ctx);

            const worldX = screenWorldX + cam.current.x;
            const worldY = screenWorldY + cam.current.y;

            const tilePxW = TILE_W * cellX, tilePxH = TILE_H * cellY;
            const tx = Math.floor(worldX / tilePxW);
            const ty = Math.floor(worldY / tilePxH);
            const rx = mod(worldX, tilePxW);
            const ry = mod(worldY, tilePxH);
            const lx = Math.floor(rx / cellX);
            const ly = Math.floor(ry / cellY);

            hoverCell.current = { cx: tx * TILE_W + lx, cy: ty * TILE_H + ly };
        }

        if (!dragging.current) return;

        const rawDx = (e.clientX - dragging.current.startMouseX) / VIEW_SCALE;
        const rawDy = (e.clientY - dragging.current.startMouseY) / VIEW_SCALE;

        const dx = rawDx * DRAG_SENS;
        const dy = rawDy * DRAG_SENS;

        cam.current.x = dragging.current.startCamX - dx;
        cam.current.y = dragging.current.startCamY - dy;

        {
            const ctx = canvasRef.current!.getContext('2d')!;
            const rect = currentTileRect(ctx);
            if (!lastRect.current ||
                rect.minX !== lastRect.current.minX || rect.maxX !== lastRect.current.maxX ||
                rect.minY !== lastRect.current.minY || rect.maxY !== lastRect.current.maxY) {
                lastRect.current = rect;
                scheduleViewportFetch();
            }
        }

        const now = performance.now();
        samples.current.push({ x: e.clientX, y: e.clientY, t: now });
        while (samples.current.length > 2 && now - samples.current[0].t > SAMPLE_MS) {
            samples.current.shift();
        }
    }
    async function onMouseUp() {
        if (!dragging.current) return;
        dragging.current = null;

        const buf = samples.current;
        samples.current = [];

        if (buf.length >= 2) {
            const end = buf[buf.length - 1];
            let i = buf.length - 1;
            while (i > 0 && (end.t - buf[i - 1].t) <= QUIET_WINDOW_MS) i--;
            const start = buf[i];
            const recentDx = end.x - start.x;
            const recentDy = end.y - start.y;
            const recentDist = Math.hypot(recentDx, recentDy);

            if (recentDist < QUIET_DIST_PX) {
                await refreshViewport();
                return;
            }

            const dt = Math.max(16, end.t - buf[0].t);
            const vx = (((end.x - buf[0].x) / dt) / VIEW_SCALE) * FLING_SCALE;
            const vy = (((end.y - buf[0].y) / dt) / VIEW_SCALE) * FLING_SCALE;

            const speed2 = vx * vx + vy * vy;
            if (speed2 > 0.000001) {
                velocity.current.vx = vx;
                velocity.current.vy = vy;
                startInertia();
                return;
            }
        }
        await refreshViewport();
    }

    // --- touch helpers (mapping to existing mouse logic) ---
    function firstTouch(e: TouchEvent) { return e.changedTouches[0]; }

    function onTouchStart(e: React.TouchEvent<HTMLCanvasElement>) {
        followCaret.current = false;
        e.preventDefault();

        const t = firstTouch(e.nativeEvent);
        tapStart.current = { x: t.clientX, y: t.clientY, t: performance.now() };
        lastTouch.current = { x: t.clientX, y: t.clientY };

        dragging.current = {
            startMouseX: t.clientX,
            startMouseY: t.clientY,
            startCamX: cam.current.x,
            startCamY: cam.current.y,
        };
        isInertial.current = false;
        samples.current = [{ x: t.clientX, y: t.clientY, t: performance.now() }];
    }

    function onTouchMove(e: React.TouchEvent<HTMLCanvasElement>) {
        e.preventDefault();
        if (!dragging.current) return;

        const t = firstTouch(e.nativeEvent);
        lastTouch.current = { x: t.clientX, y: t.clientY };
        const rawDx = (t.clientX - dragging.current.startMouseX) / VIEW_SCALE;
        const rawDy = (t.clientY - dragging.current.startMouseY) / VIEW_SCALE;
        const dx = rawDx * DRAG_SENS;
        const dy = rawDy * DRAG_SENS;

        cam.current.x = dragging.current.startCamX - dx;
        cam.current.y = dragging.current.startCamY - dy;

        const ctx = canvasRef.current!.getContext('2d')!;
        const rect = currentTileRect(ctx);
        if (!lastRect.current ||
            rect.minX !== lastRect.current.minX || rect.maxX !== lastRect.current.maxX ||
            rect.minY !== lastRect.current.minY || rect.maxY !== lastRect.current.maxY) {
            lastRect.current = rect;
            scheduleViewportFetch();
        }

        const now = performance.now();
        samples.current.push({ x: t.clientX, y: t.clientY, t: now });
        while (samples.current.length > 2 && now - samples.current[0].t > SAMPLE_MS) {
            samples.current.shift();
        }
    }

    function getColorAt(cx: number, cy: number): string | undefined {
        const overlay = colorLayer.current.get(`${cx},${cy}`);
        if (overlay) return overlay; // transient/local color
        const { tx, ty, offset } = tileForChar(cx, cy);
        const t = tiles.current.get(key(tx, ty));
        if (!t) return undefined;
        return getServerColorAt(t, offset); // '#rrggbb' | undefined
    }
    const escapeHtml = (s: string) =>
        s.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]!));


    function onTouchEnd(e: React.TouchEvent<HTMLCanvasElement>) {
        e.preventDefault();

        const start = tapStart.current;
        const last = lastTouch.current;
        tapStart.current = null;

        if (start && last) {
            const dt = performance.now() - start.t;
            const dist = Math.hypot(last.x - start.x, last.y - start.y);
            const TAP_MAX_DT = 300;   
            const TAP_MAX_DIST = 10;  

            if (dt <= TAP_MAX_DT && dist <= TAP_MAX_DIST) {
                dragging.current = null; 
                setCaretFromClientPoint(last.x, last.y);
                return;
            }
        }

        onMouseUp();
    }

    function onTouchCancel() {
        tapStart.current = null;
        lastTouch.current = null;
        dragging.current = null;
    }


    function startInertia() {
        isInertial.current = true;
        let last = performance.now();

        function step() {
            if (!isInertial.current) return;
            const now = performance.now();
            let dt = Math.min(now - last, 40); 
            last = now;

            cam.current.x -= velocity.current.vx * dt;
            cam.current.y -= velocity.current.vy * dt;

            {
                const ctx = canvasRef.current!.getContext('2d')!;
                const rect = currentTileRect(ctx);
                if (!lastRect.current ||
                    rect.minX !== lastRect.current.minX || rect.maxX !== lastRect.current.maxX ||
                    rect.minY !== lastRect.current.minY || rect.maxY !== lastRect.current.maxY) {
                    lastRect.current = rect;
                    scheduleViewportFetch();
                }
            }

            // exponential decay
            const decay = Math.exp(-DECAY_PER_MS * dt);
            velocity.current.vx *= decay;
            velocity.current.vy *= decay;

            const speed2 = velocity.current.vx * velocity.current.vx + velocity.current.vy * velocity.current.vy;
            if (speed2 < MIN_SPEED * MIN_SPEED) {
                isInertial.current = false;
                refreshViewport();
                return;
            }
            requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
    }

    function setCaretFromClientPoint(clientX: number, clientY: number) {
        const cv = canvasRef.current!;
        const ctx = cv.getContext('2d')!;
        const { cellX, cellY } = metrics(ctx);

        const rect = cv.getBoundingClientRect();
        const screenWorldX = (clientX - rect.left) / VIEW_SCALE;
        const screenWorldY = (clientY - rect.top) / VIEW_SCALE;

        for (const a of linkAreas.current) {
            if (
                screenWorldX >= a.x && screenWorldX <= a.x + a.w &&
                screenWorldY >= a.y && screenWorldY <= a.y + a.h
            ) {
                window.open(a.url, '_blank', 'noopener,noreferrer');
                return;
            }
        }

        // Converting to world coords, compute cell
        const worldX = screenWorldX + cam.current.x;
        const worldY = screenWorldY + cam.current.y;

        const tilePxW = TILE_W * cellX, tilePxH = TILE_H * cellY;
        const tx = Math.floor(worldX / tilePxW);
        const ty = Math.floor(worldY / tilePxH);
        const rx = mod(worldX, tilePxW);
        const ry = mod(worldY, tilePxH);
        const lx = Math.floor(rx / cellX);
        const ly = Math.floor(ry / cellY);
        const cx = tx * TILE_W + lx;
        const cy = ty * TILE_H + ly;
        const clickedCx = Math.floor(worldX / cellX);
        const clickedCy = Math.floor(worldY / cellY);
        if (inProtected(clickedCx, clickedCy)) return;

        ensureTile(tx, ty);
        caret.current = { cx, cy, anchorCx: cx };

        focusMobileInput();
        setVersionTick(v => v + 1);
    }


    function onClick(e: React.MouseEvent<HTMLCanvasElement>) {
        const cv = e.currentTarget;
        const ctx = cv.getContext('2d')!;
        const { cellX, cellY } = metrics(ctx);
        const rect = cv.getBoundingClientRect();
        const screenWorldX = (e.clientX - rect.left) / VIEW_SCALE;
        const screenWorldY = (e.clientY - rect.top) / VIEW_SCALE;
        const worldX = screenWorldX + cam.current.x;
        const worldY = screenWorldY + cam.current.y;

        for (const a of linkAreas.current) {
            if (
                screenWorldX >= a.x && screenWorldX <= a.x + a.w &&
                screenWorldY >= a.y && screenWorldY <= a.y + a.h
            ) {
                window.open(a.url, '_blank', 'noopener,noreferrer');
                return; 
            }
        }

        const tilePxW = TILE_W * cellX, tilePxH = TILE_H * cellY;
        const tx = Math.floor(worldX / tilePxW);
        const ty = Math.floor(worldY / tilePxH);
        const rx = mod(worldX, tilePxW);  
        const ry = mod(worldY, tilePxH);  
        const lx = Math.floor(rx / cellX);
        const ly = Math.floor(ry / cellY);

        const cx = tx * TILE_W + lx;
        const cy = ty * TILE_H + ly;

        for (const a of linkAreas.current) {
            if (worldX >= a.x && worldX <= a.x + a.w &&
                worldY >= a.y && worldY <= a.y + a.h) {
                window.open(a.url, '_blank', 'noopener,noreferrer');
                return; 
            }
        }

        const clickedCx = Math.floor(worldX / cellX);
        const clickedCy = Math.floor(worldY / cellY);
        if (inProtected(clickedCx, clickedCy)) {
            return;
        }

        ensureTile(tx, ty);
        caret.current = { cx, cy, anchorCx: cx }; 
        focusMobileInput();
        setVersionTick(v => v + 1);
    }

    useEffect(() => {
        function onKey(e: KeyboardEvent) {

            if (isMobileInputFocused()) return;

            if (!caret.current) return;

            // Ignore modifier combos and non-text keys handled separately
            const isCopy = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c';
            const isCut = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x';
            if (isCopy || isCut) {
                const src = caret.current ?? hoverCell.current;
                if (!src || inProtected(src.cx, src.cy)) { e.preventDefault(); return; }

                const ch = getCharAt(src.cx, src.cy) || ' ';
                const color = getColorAt(src.cx, src.cy); // '#rrggbb' | undefined
                const html = color
                    ? `<span style="color:${color}">${escapeHtml(ch)}</span>`
                    : escapeHtml(ch);

                const writeRich = async () => {
                    if (navigator.clipboard?.write && (window as any).ClipboardItem) {
                        await navigator.clipboard.write([
                            new ClipboardItem({
                                'text/html': new Blob([html], { type: 'text/html' }),
                                'text/plain': new Blob([ch], { type: 'text/plain' }),
                            })
                        ]);
                    } else {
                        // Fallback path
                        document.addEventListener('copy', ev => {
                            ev.clipboardData!.setData('text/plain', ch);
                            ev.clipboardData!.setData('text/html', html);
                            ev.preventDefault();
                        }, { once: true });
                        document.execCommand('copy');
                    }
                };

                writeRich().catch(() => { /* ignore */ });
                markRecent(src.cx, src.cy);
                setVersionTick(v => v + 1);

                if (isCut) {
                    const { tx, ty, offset } = tileForChar(src.cx, src.cy);
                    const t = ensureTile(tx, ty);
                    t.data = t.data.slice(0, offset) + ' ' + t.data.slice(offset + 1);
                    colorLayer.current.delete(`${src.cx},${src.cy}`);
                    setVersionTick(v => v + 1);
                    queuePatch(t, offset, ' ', `#${CLEAR_HEX}`); // clear color on server
                }

                e.preventDefault();
                return;
            }


            if (e.altKey || e.ctrlKey || e.metaKey) return;
            if (
                e.key === 'Shift' ||
                e.key === 'CapsLock' ||
                e.key === 'NumLock' ||
                e.key === 'ScrollLock' ||
                e.key === 'Dead' ||      // IME / accent start
                e.key === 'Escape' ||
                e.key === 'Tab'
            ) {
                return;
            }

            if (e.key === 'Enter') {
                caret.current.cy += 1;
                caret.current.cx = caret.current.anchorCx;
                setVersionTick(v => v + 1);
                followCaret.current = true;
                if (followCaret.current && ensureCaretEdgeFollow()) { refreshViewport(); }
                return;
            }

            if (e.key === 'ArrowLeft') {
                caret.current.cx -= 1; setVersionTick(v => v + 1); followCaret.current = true; if (followCaret.current && ensureCaretEdgeFollow()) { refreshViewport(); }

                return;
            }
            if (e.key === 'ArrowRight') {
                caret.current.cx += 1; setVersionTick(v => v + 1); followCaret.current = true; if (followCaret.current && ensureCaretEdgeFollow()) { refreshViewport(); }

                return;
            }
            if (e.key === 'ArrowUp') {
                caret.current.cy -= 1; setVersionTick(v => v + 1); followCaret.current = true; if (followCaret.current && ensureCaretEdgeFollow()) { refreshViewport(); }

                return;
            }
            if (e.key === 'ArrowDown') {
                caret.current.cy += 1; setVersionTick(v => v + 1); followCaret.current = true; if (followCaret.current && ensureCaretEdgeFollow()) { refreshViewport(); }

                return;
            }

            if (e.key === 'Backspace') {
                e.preventDefault();
                enqueueEdit(() => {
                    if (!caret.current) return;
                    const snapCx = caret.current.cx - 1;
                    const snapCy = caret.current.cy;
                    if (inProtected(snapCx, snapCy)) return;

                    caret.current.cx = snapCx;
                    const { tx, ty, offset, lx, ly } = tileForChar(snapCx, snapCy);
                    sendTyping(tx, ty, lx, ly);
                    const t = ensureTile(tx, ty);

                    t.data = t.data.slice(0, offset) + ' ' + t.data.slice(offset + 1);
                    setVersionTick(v => v + 1);
                    followCaret.current = true;
                    if (followCaret.current && ensureCaretEdgeFollow()) { refreshViewport(); }

                    markRecent(snapCx, snapCy);
                    colorLayer.current.delete(`${snapCx},${snapCy}`);
                    queuePatch(t, offset, ' ', `#${CLEAR_HEX}`); 
                });
                return;
            }

            if (e.key.length === 1) {
                enqueueEdit(() => {
                    if (!caret.current) return;
                    const snapCx = caret.current.cx;
                    const snapCy = caret.current.cy;
                    if (inProtected(snapCx, snapCy)) return;

                    const { tx, ty, offset, lx, ly } = tileForChar(snapCx, snapCy);
                    sendTyping(tx, ty, lx, ly);

                    const t = ensureTile(tx, ty);

                    // local write
                    t.data = t.data.slice(0, offset) + e.key + t.data.slice(offset + 1);
                    setVersionTick(v => v + 1);

                    markRecent(snapCx, snapCy);

                    // send the typed character (no color clearing here)
                    queuePatch(t, offset, e.key);

                    if (caret.current) {
                        caret.current.cx = snapCx + 1;
                        setVersionTick(v => v + 1);
                        followCaret.current = true;
                        if (ensureCaretEdgeFollow()) { refreshViewport(); }
                    }
                });
                return;
            
            }
        }

        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);
    return (
        <>
            <div className="toolbar">
                {" "} 
                <img src="https://cdn.discordapp.com/emojis/889434608037421066.png?v=1" alt="stars5" height="24" />
            </div>

            <canvas
                ref={canvasRef}
                style={{ touchAction: 'none' }}
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
                onMouseLeave={onMouseUp}
                onClick={onClick}

                onTouchStart={onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onTouchEnd}
                onTouchCancel={onTouchCancel}
            />
            <input
                ref={mobileInputRef}
                type="text"
                inputMode="text"
                enterKeyHint="enter"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                style={{
                    position: 'fixed',
                    opacity: 0,
                    left: 0,
                    top: 0,
                    width: 1,
                    height: 1,
                    padding: 0,
                    border: 0,
                    background: 'transparent'
                }}
                onBeforeInput={onMobileBeforeInput} 
                onInput={onMobileInput}
                onBlur={keepFocusIfEditing}
            />
        </>
    );
}

export default App;
