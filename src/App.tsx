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
const VIEW_SCALE = 1.15;
const mod = (n: number, m: number) => ((n % m) + m) % m;
const FADE_MS = 140; // fast fade-in, ~YWO(T) feel
const SAMPLE_MS = 180;     // was ~120; longer window = smaller fling velocity
const FLING_SCALE = 0.6;   // 0..1; scales down the initial fling
const DECAY_PER_MS = 0.007; // was 0.0045; higher = stops faster
const MIN_SPEED = 0.00006;  // was 0.00005; higher = stops earlier
const QUIET_WINDOW_MS = 25; // if the last ~100ms were nearly still, don't fling
const QUIET_DIST_PX = 6;   // movement less than this in that window counts as still
const COORD_UNIT = 10; // show 1 per 10 characters (10->1, 20->2, etc.)
const DRAG_SENS = 0.9; // 1.0 = current feel, lower = less sensitive (e.g., 0.6–0.85)
const FETCH_THROTTLE_MS = 80; // viewport fetch for page reload
const PEER_TYPING_TTL_MS = 900; // how long the “black rect” stays visible


// --- visual toggles ---
const SHOW_GRID = false;              // turn cell grid on/off
const SHOW_TILE_BORDERS = false;      // turn per-tile border boxes on/off
const SHOW_MISSING_PLACEHOLDER = false; // show "…" for unloaded tiles

// --- protected plaza around (0,0) in character coordinates ---
const PROTECT = { x: -10, y: -10, w: 30, h: 13 };

// text/links to show inside the plaza (centered)
const PLAZA_LINES: Array<{ text: string; link?: string; gap?: number }> = [
    { text: '2W2T', },
    { text: '~2writers2tiles~', gap: 8 },// extra margin below the title (pixels)
    { text: 'An Infinite Void to\nwrite, create, and destroy', gap: 8 }, // newline after "Void to"
    { text: 'Chat with other users you find\nin the void!', gap:8 },
    { text: 'How to Paste ASCII Art', link: 'https://github.com/xqyet/2w2t.ASCII', gap:10 },
    { text: '~xqyet~', link: 'https://xqyet.dev/', gap:6 },
    { text: '~~source code~~', link: 'https://github.com/xqyet/2w2t.frontend' },

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
    const lastTypingSentAt = useRef(0);
    const isMobileInputFocused = () =>
        document.activeElement === mobileInputRef.current;

    const linkAreas = useRef<{ x: number; y: number; w: number; h: number; url: string }[]>([]);
    // recent writes: key = "cx,cy" (absolute char coords), value = timestamp (ms)
    const recentWrites = useRef<Map<string, number>>(new Map());
    // Serial queue to guarantee ordering of caret moves + patches
    const inputQueue = useRef<Promise<void>>(Promise.resolve());
    const tapStart = useRef<{ x: number; y: number; t: number } | null>(null);
    const lastTouch = useRef<{ x: number; y: number } | null>(null);
    const followCaret = useRef(false);
    const ZWS = '\u200B';
    function enqueueEdit(fn: () => Promise<void> | void) {
        inputQueue.current = inputQueue.current.then(async () => { await fn(); });
        return inputQueue.current.catch(() => { }); // swallow to keep chain alive
    }
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
    function sendTyping(tx: number, ty: number, lx: number, ly: number) {
        const now = performance.now();
        if (now - lastTypingSentAt.current < 60) return; // throttle ~16fps+
        lastTypingSentAt.current = now;

        const hub = getHub();
        // best-effort (ignore if not started yet)
        hub.invoke('Typing', tx, ty, lx, ly).catch(() => { });
    }
    function focusMobileInput() {
        // Focus only on coarse pointer/touch devices
        const isTouch =
            (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
            'ontouchstart' in window || navigator.maxTouchPoints > 0;

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
        if (fetchTimer.current !== null) return; // already scheduled
        fetchTimer.current = window.setTimeout(async () => {
            fetchTimer.current = null;
            await refreshViewport();
        }, FETCH_THROTTLE_MS) as unknown as number;
    }
    function onMobileBeforeInput(e: React.FormEvent<HTMLInputElement>) {
        if (!caret.current) return;
        const ne = e.nativeEvent as unknown as InputEvent;
        const type = (ne && (ne as any).inputType) || '';

        // cover long-press variants too
        if (type === 'deleteContentBackward' || type === 'deleteWordBackward' || type === 'deleteHardLineBackward') {
            e.preventDefault(); // keep our sentinel in place

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
                queuePatch(t, offset, ' ');
                followCaret.current = true;
                if (ensureCaretEdgeFollow()) { refreshViewport(); }
            });

            // re-prime so the next backspace still fires
            primeMobileInput();
        }
    }

    function onMobileInput(e: React.FormEvent<HTMLInputElement>) {
        if (!caret.current) {
            // nothing selected to type into
            (e.currentTarget as HTMLInputElement).value = '';
            primeMobileInput();
            return;
        }

        const el = e.currentTarget;
        const ne = e.nativeEvent as unknown as InputEvent;
        const inputType = (ne && (ne as any).inputType) || '';

        // Fallback: if we do get a delete here, handle it (main path is onBeforeInput)
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
                queuePatch(t, offset, ' ');

                followCaret.current = true;
                if (ensureCaretEdgeFollow()) { refreshViewport(); }
            });

            // keep the hidden input primed so the next backspace still fires
            el.value = '';
            primeMobileInput();
            return;
        }

        // Regular character input (strip the sentinel first)
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

        // clear and re-prime so the field is never empty
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

        // viewport size in WORLD units
        const worldW = (cv.clientWidth || window.innerWidth) / VIEW_SCALE;
        const worldH = (cv.clientHeight || window.innerHeight) / VIEW_SCALE;

        // caret cell in WORLD pixels
        const cX = caret.current.cx * cellX;
        const cY = caret.current.cy * cellY;

        // current view rect in WORLD pixels
        const left = cam.current.x;
        const top = cam.current.y;
        const right = cam.current.x + worldW;
        const bottom = cam.current.y + worldH;

        let moved = false;

        // --- horizontal: keep the whole caret cell visible and glued to edges ---
        if (cX < left) {
            cam.current.x = cX;
            moved = true;
        }
        // right edge: if caret's right goes off-screen, align right edge to caret right
        if (cX + cellX > right) {
            cam.current.x = cX + cellX - worldW;
            moved = true;
        }

        // --- vertical: same idea for rows ---
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
            let yStart = plazaTop + (plazaHpx - totalHeight) / 2-40;

            for (const line of PLAZA_LINES) {
                const parts = line.text.split('\n');

                for (const part of parts) {
                    const m = ctx.measureText(part);
                    const lineW = Math.ceil(m.width);
                    const x = plazaLeft + (plazaWpx - lineW) / 2;
                    const y = yStart;

                    if (line.link) {
                        // link style + underline
                        ctx.fillStyle = '#0044aa';
                        ctx.fillText(part, x, y);
                        ctx.beginPath();
                        ctx.moveTo(x, y + FONT_PX + 1);
                        ctx.lineTo(x + lineW, y + FONT_PX + 1);
                        ctx.strokeStyle = '#0044aa';
                        ctx.stroke();

                        // record clickable area in *world* coords for onClick()
                        linkAreas.current.push({ x, y, w: lineW, h: lineAdvance, url: line.link });
                    } else {
                        ctx.fillStyle = '#333';
                        ctx.fillText(part, x, y);
                    }

                    yStart += lineAdvance; // advance for each visual line
                }

                // extra margin after the (possibly multi-line) item
                yStart += (line.gap ?? 0);
            }

            // per-cell grid (aligned to camera) — use worldW/H
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
                    if (SHOW_TILE_BORDERS) {
                        ctx.strokeStyle = '#cfcfcf';
                        ctx.strokeRect(screenX + 0.5, screenY + 0.5, tilePxW - 1, tilePxH - 1);
                    }

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

                                {
                                    const nowPeers = performance.now();
                                    for (const [id, info] of [...peerCarets.current]) {
                                        if (nowPeers - info.ts > PEER_TYPING_TTL_MS) {
                                            peerCarets.current.delete(id);
                                            continue;
                                        }
                                        // use the top-level cellX/cellY computed at the start of draw()
                                        const left = info.cx * cellX - cam.current.x;
                                        const top = info.cy * cellY - cam.current.y;

                                        // (optional: cull if off-screen)
                                        // if (left + cellX < 0 || top + cellY < 0 || left > worldW || top > worldH) continue;

                                        ctx.fillStyle = '#000';
                                        ctx.fillRect(left + 1, top + 1, cellX - 2, cellY - 2);
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

            ctx.restore(); // end scaled drawing

            // --- HUD: center coordinates in bottom-right (device pixels) ---
            {
                // center of the screen in WORLD pixels
                const centerWorldX = cam.current.x + worldW / 2;
                const centerWorldY = cam.current.y + worldH / 2;

                // convert to absolute **character** coords (can be fractional)
                const cxCenterExact = centerWorldX / cellX;
                const cyCenterExact = centerWorldY / cellY;

                // display in “coarse units”: 1 per COORD_UNIT characters
                const dispX = Math.trunc(cxCenterExact / COORD_UNIT);
                const dispY = Math.trunc(cyCenterExact / COORD_UNIT);

                const hudText = `X:${dispX} Y:${dispY}`;

                ctx.save();
                ctx.font = '18px "Courier New", Courier, monospace';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';

                // measure text
                const m = ctx.measureText(hudText);
                const textW = Math.ceil(m.width);
                const textH =
                    (m.actualBoundingBoxAscent ?? 14) + (m.actualBoundingBoxDescent ?? 4);

                // padding & box
                const padX = 12;
                const padY = 8;
                const boxW = textW + padX * 2;
                const boxH = textH + padY * 2;

                // "glued" to bottom-right: no margin
                const bx = cv.width - boxW;
                const by = cv.height - boxH;

                // rounded-rect helper
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

                // background & border
                roundRect(bx, by, boxW, boxH, r);
                ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';   // translucent gray
                ctx.fill();
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)'; // subtle border
                ctx.stroke();

                // text centered vertically inside the pill
                ctx.fillStyle = '#000';
                ctx.fillText(hudText, bx + padX, by + boxH / 2);

                ctx.restore();
            }

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

        const minTileX = Math.floor(cam.current.x / tilePxW) - 2;
        const minTileY = Math.floor(cam.current.y / tilePxH) - 2;
        const maxTileX = Math.floor((cam.current.x + worldW) / tilePxW) + 2;
        const maxTileY = Math.floor((cam.current.y + worldH) / tilePxH) + 2;
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
        lastRect.current = { minX: minTileX, minY: minTileY, maxX: maxTileX, maxY: maxTileY };
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

        hub.on('peerTyping', (msg: { x: number; y: number; col: number; row: number; sender: string }) => {
            const cx = msg.x * TILE_W + msg.col;
            const cy = msg.y * TILE_H + msg.row;
            peerCarets.current.set(msg.sender, { cx, cy, ts: performance.now() });
            setVersionTick(v => v + 1); // trigger a frame so it appears quickly
        });

        hub.start().then(refreshViewport);
        return () => { hub.stop(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        function onPaste(e: ClipboardEvent) {
            if (isMobileInputFocused()) return; 
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

            followCaret.current = true;

            if (followCaret.current && ensureCaretEdgeFollow()) { refreshViewport(); }

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
        followCaret.current = false;
        dragging.current = {
            startMouseX: e.clientX,
            startMouseY: e.clientY,
            startCamX: cam.current.x,
            startCamY: cam.current.y,
        };
        isInertial.current = false; // stop any running inertia
        samples.current = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
    }

    function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
        const cv = e.currentTarget;

        // --- hover cursor over links (works even when not dragging) ---
        const rect = cv.getBoundingClientRect();
        const screenWorldX = (e.clientX - rect.left) / VIEW_SCALE;
        const screenWorldY = (e.clientY - rect.top) / VIEW_SCALE;

        const overLink = linkAreas.current.some(a =>
            screenWorldX >= a.x && screenWorldX <= a.x + a.w &&
            screenWorldY >= a.y && screenWorldY <= a.y + a.h
        );

        // if dragging, show grabbing; else show pointer over links or default
        cv.style.cursor = dragging.current
            ? 'grabbing'
            : (overLink ? 'pointer' : 'default');

        // --- your existing dragging code (only runs when dragging) ---
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

        // grab & clear the buffer
        const buf = samples.current;
        samples.current = [];

        if (buf.length >= 2) {
            // 1) recent-quiet check: look at just the last ~QUIET_WINDOW_MS of movement
            const end = buf[buf.length - 1];
            let i = buf.length - 1;
            while (i > 0 && (end.t - buf[i - 1].t) <= QUIET_WINDOW_MS) i--;
            const start = buf[i];

            const recentDx = end.x - start.x;
            const recentDy = end.y - start.y;
            const recentDist = Math.hypot(recentDx, recentDy);

            if (recentDist < QUIET_DIST_PX) {
                // user stopped moving before releasing ? no fling
                await refreshViewport();
                return;
            }

            // 2) otherwise compute fling velocity as before (using your window + scaling)
            const dt = Math.max(16, end.t - buf[0].t); // ms (avoid tiny dt)
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

        // wait
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

        // schedule fetch like mouse-move
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

    function onTouchEnd(e: React.TouchEvent<HTMLCanvasElement>) {
        e.preventDefault();

        const start = tapStart.current;
        const last = lastTouch.current;
        tapStart.current = null;

        if (start && last) {
            const dt = performance.now() - start.t;
            const dist = Math.hypot(last.x - start.x, last.y - start.y);
            const TAP_MAX_DT = 300;   // ms
            const TAP_MAX_DIST = 10;  // px

            // treat as tap: place caret & focus input
            if (dt <= TAP_MAX_DT && dist <= TAP_MAX_DIST) {
                dragging.current = null; // cancel any drag
                setCaretFromClientPoint(last.x, last.y);
                return;
            }
        }

        // otherwise, end drag and maybe fling
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
            let dt = Math.min(now - last, 40); // clamp spikes
            last = now;

            // advance camera
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

            // stop when slow enough
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

        // If the tap is on a plaza link, open it and bail
        for (const a of linkAreas.current) {
            if (
                screenWorldX >= a.x && screenWorldX <= a.x + a.w &&
                screenWorldY >= a.y && screenWorldY <= a.y + a.h
            ) {
                window.open(a.url, '_blank', 'noopener,noreferrer');
                return;
            }
        }

        // Convert to world coords, compute cell
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

        // Ignore protected area
        const clickedCx = Math.floor(worldX / cellX);
        const clickedCy = Math.floor(worldY / cellY);
        if (inProtected(clickedCx, clickedCy)) return;

        ensureTile(tx, ty);
        caret.current = { cx, cy, anchorCx: cx };

        // Do NOT re-enable follow here; let typing turn it back on
        focusMobileInput();
        setVersionTick(v => v + 1);
    }


    function onClick(e: React.MouseEvent<HTMLCanvasElement>) {
        const cv = e.currentTarget;
        const ctx = cv.getContext('2d')!;
        const { cellX, cellY } = metrics(ctx);

        const rect = cv.getBoundingClientRect();
        // screen/world coords = pixels in the scaled world space (no camera added)
        const screenWorldX = (e.clientX - rect.left) / VIEW_SCALE;
        const screenWorldY = (e.clientY - rect.top) / VIEW_SCALE;

        // full world coords (what you already had) for caret math
        const worldX = screenWorldX + cam.current.x;
        const worldY = screenWorldY + cam.current.y;

        // 1) link hit-test in the SAME space they were recorded (screen/world)
        for (const a of linkAreas.current) {
            if (
                screenWorldX >= a.x && screenWorldX <= a.x + a.w &&
                screenWorldY >= a.y && screenWorldY <= a.y + a.h
            ) {
                window.open(a.url, '_blank', 'noopener,noreferrer');
                return; // don't set caret if we clicked a link
            }
        }

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
        focusMobileInput();
        setVersionTick(v => v + 1);
    }

    // keyboard typing
    useEffect(() => {
        function onKey(e: KeyboardEvent) {

            if (isMobileInputFocused()) return;

            if (!caret.current) return;

            // Ignore modifier combos and non-text keys we handle separately
            if (e.ctrlKey || e.metaKey || e.altKey) return;
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

            // Enter: next line, keep anchor column
            if (e.key === 'Enter') {
                caret.current.cy += 1;
                caret.current.cx = caret.current.anchorCx;
                setVersionTick(v => v + 1);
                followCaret.current = true;
                if (followCaret.current && ensureCaretEdgeFollow()) { refreshViewport(); }
                return;
            }

            // Arrow keys move caret only
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

            // Backspace: clear previous cell (queued to preserve order)
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
                    queuePatch(t, offset, ' ');
                });
                return;
            }

            // Only write single printable characters here
            if (e.key.length === 1) {
                enqueueEdit(() => {
                    if (!caret.current) return;
                    const snapCx = caret.current.cx;
                    const snapCy = caret.current.cy;
                    if (inProtected(snapCx, snapCy)) return;

                    const { tx, ty, offset, lx, ly } = tileForChar(snapCx, snapCy);
                    sendTyping(tx, ty, lx, ly);
                    const t = ensureTile(tx, ty);
                    

                    t.data = t.data.slice(0, offset) + e.key + t.data.slice(offset + 1);
                    setVersionTick(v => v + 1);

                    markRecent(snapCx, snapCy);
                    queuePatch(t, offset, e.key);

                    // advance caret after enqueue
                    if (caret.current) {
                        caret.current.cx = snapCx + 1;
                        setVersionTick(v => v + 1);
                        followCaret.current = true;
                        if (ensureCaretEdgeFollow()) { refreshViewport(); }
                    }
                });
                return;
            }

            // anything else: ignore
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
                // Keep it effectively invisible but focusable
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
