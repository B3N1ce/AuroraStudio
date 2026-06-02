// js/entityManager.js

import { t } from './i18n.js';
import { initWebGL, resizeWebGL, setBackgroundTexture, renderScene, isWebGLAvailable } from './webglRenderer.js';
import { renameEntityInSequence, removeEntityFromSequence } from './timelineEditor.js';

const lamps = new Map();
const otherEntities = {};
let selectedEntityCallback = null;
let currentColorCurve = 'linear';

// Groups, Visibility & Positions Storage
let groups        = JSON.parse(localStorage.getItem('ha_simulator_groups'))        || {};
let hiddenEntities = JSON.parse(localStorage.getItem('ha_simulator_hidden'))       || {};
let storedPositions = JSON.parse(localStorage.getItem('ha_simulator_lamp_positions')) || {};

// Editor callbacks (injected from app.js)
let _getEditorValue = null;
let _setEditorValue = null;
let _isPlaying = () => false;

// Entity display order
let _entityOrder = [];
function _loadEntityOrder() {
    try { _entityOrder = JSON.parse(localStorage.getItem('ha_simulator_entity_order') || '[]'); }
    catch { _entityOrder = []; }
}
function _saveEntityOrder() {
    localStorage.setItem('ha_simulator_entity_order', JSON.stringify(_entityOrder));
}

const ROOM_SIZE = 800;

// Canvas State
let canvas, ctx;
let isDirty = true;
let lastFrameTime = performance.now();

// FPS tracking (rendered frames only — skipped frames don't count)
let _fpsFrames = 0;
let _fpsWindowStart = 0;
let _lastFrameRenderTime = 0;
let _statFps = 0;
let _statFrameMs = 0;
let dragTarget = null;
let dragOffset = { x: 0, y: 0 };
let touchDragTarget = null;
let touchDragOffX = 0, touchDragOffY = 0;

// Simulation room pan/zoom state
let simPanX = 0, simPanY = 0, simZoom = 1.0;
let simIsPanning = false, simPanLastX = 0, simPanLastY = 0;
let simZoomUserSet = false;
const SIM_ZOOM_MIN = 0.15, SIM_ZOOM_MAX = 3.0;
let wallColor = { r: 255, g: 255, b: 255 };
let labelsVisible = localStorage.getItem('ha_simulator_labels_visible') !== 'false';
let entitiesVisible = localStorage.getItem('ha_simulator_entities_visible') !== 'false';
let backgroundImage = null;
let lightInfluence = parseFloat(localStorage.getItem('ha_simulator_light_influence')) || 1.0;
let blendMode = localStorage.getItem('ha_simulator_blend_mode') || 'multiply-glow';
let ambientLevel = parseFloat(localStorage.getItem('ha_simulator_ambient')) || 0.02;
let exposure = parseFloat(localStorage.getItem('ha_simulator_exposure')) || 1.0;
let backgroundChangeCallback = null;

// Uploads backgroundImage to WebGL as a cover crop into the square ROOM_SIZE canvas.
function uploadBgTexture() {
    if (!backgroundImage) { setBackgroundTexture(null); return; }
    const ia = backgroundImage.width / backgroundImage.height;
    let sx, sy, sw, sh;
    if (ia >= 1) {
        // Landscape/square: fill height, crop sides
        sh = ROOM_SIZE; sw = ROOM_SIZE * ia;
        sx = (ROOM_SIZE - sw) / 2; sy = 0;
    } else {
        // Portrait: fill width, crop top/bottom
        sw = ROOM_SIZE; sh = ROOM_SIZE / ia;
        sx = 0; sy = (ROOM_SIZE - sh) / 2;
    }
    const off = document.createElement('canvas');
    off.width  = ROOM_SIZE;
    off.height = ROOM_SIZE;
    off.getContext('2d').drawImage(backgroundImage, sx, sy, sw, sh);
    setBackgroundTexture(off);
}

export function getGroups() { return groups; }
export function getAvailableEntities() { return Array.from(lamps.keys()); }

function saveGroups()  { localStorage.setItem('ha_simulator_groups',  JSON.stringify(groups));         }
function saveHidden()  { localStorage.setItem('ha_simulator_hidden',  JSON.stringify(hiddenEntities)); }
function savePositions() {
    const positions = {};
    lamps.forEach((lamp, id) => {
        positions[id] = { nx: lamp.nx, ny: lamp.ny };
    });
    localStorage.setItem('ha_simulator_lamp_positions', JSON.stringify(positions));
}

export function initEntityManager(callback, editorCallbacks = {}) {
    selectedEntityCallback = callback;
    if (editorCallbacks.getEditorValue) _getEditorValue = editorCallbacks.getEditorValue;
    if (editorCallbacks.setEditorValue) _setEditorValue = editorCallbacks.setEditorValue;
    if (editorCallbacks.isPlaying)      _isPlaying      = editorCallbacks.isPlaying;
    _loadEntityOrder();

    canvas = document.getElementById('simulation-canvas');
    if (canvas) {
        ctx = canvas.getContext('2d');
        canvas.style.background = 'transparent';

        // Insert WebGL canvas inside #simulation-room (behind simulation-canvas)
        const simRoom = document.getElementById('simulation-room');
        initWebGL(simRoom);
        simRoom.style.position = 'absolute';  // override what initWebGL sets to 'relative'

        resizeCanvas();
        window.addEventListener('resize', resetSimView);
        initSimPanZoom();

        canvas.addEventListener('mousedown', handleMouseDown);
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);

        // Wall color picker init
        const wallPicker = document.getElementById('picker-wall-color');
        if (wallPicker) {
            wallPicker.addEventListener('input', (e) => {
                const hex = e.target.value;
                wallColor.r = parseInt(hex.slice(1, 3), 16);
                wallColor.g = parseInt(hex.slice(3, 5), 16);
                wallColor.b = parseInt(hex.slice(5, 7), 16);
                isDirty = true;
            });
        }

        requestAnimationFrame(drawLoop);
    }
}

export function setBackgroundImage(url) {
    if (!url) {
        backgroundImage = null;
        setBackgroundTexture(null);
        localStorage.removeItem('ha_simulator_bg');
        isDirty = true;
        if (backgroundChangeCallback) backgroundChangeCallback();
        return;
    }
    const img = new Image();
    img.onload = () => {
        backgroundImage = img;
        uploadBgTexture();
        isDirty = true;
        localStorage.setItem('ha_simulator_bg', url);
        if (backgroundChangeCallback) backgroundChangeCallback();
    };
    img.src = url;
}

export function setOnBackgroundChange(cb) {
    backgroundChangeCallback = cb;
}

export function markDirty() { isDirty = true; }

export function getDebugStats() {
    const now = performance.now();
    const rendering = now - _lastFrameRenderTime < 1200;
    return {
        fps:               rendering ? _statFps : 0,
        frameMs:           rendering ? _statFrameMs : 0,
        canvasW:           canvas ? canvas.width : 0,
        canvasH:           canvas ? canvas.height : 0,
        lmW:               0,
        lmH:               0,
        lampTotal:         lamps.size,
        lampActive:        [...lamps.values()].filter(l => !l.isOff).length,
        lampTransitioning: [...lamps.values()].filter(l => l.transitionEnd > now).length,
        rendering,
    };
}

export function toggleLabels() {
    labelsVisible = !labelsVisible;
    isDirty = true;
    localStorage.setItem('ha_simulator_labels_visible', labelsVisible);
    return labelsVisible;
}

export function getLabelsVisible() {
    return labelsVisible;
}

export function toggleEntities() {
    entitiesVisible = !entitiesVisible;
    isDirty = true;
    localStorage.setItem('ha_simulator_entities_visible', entitiesVisible);
    return entitiesVisible;
}

export function getEntitiesVisible() {
    return entitiesVisible;
}

export function setLightInfluence(val) {
    lightInfluence = parseFloat(val);
    isDirty = true;
    localStorage.setItem('ha_simulator_light_influence', val);
}

export function getLightInfluence() {
    return lightInfluence;
}

export function setBlendMode(mode) {
    blendMode = mode;
    isDirty = true;
    localStorage.setItem('ha_simulator_blend_mode', mode);
}

export function getBlendMode() {
    return blendMode;
}

export function setAmbientLevel(val) {
    ambientLevel = parseFloat(val);
    isDirty = true;
    localStorage.setItem('ha_simulator_ambient', val);
}

export function getAmbientLevel() {
    return ambientLevel;
}

export function setExposure(val) {
    exposure = parseFloat(val);
    isDirty = true;
    localStorage.setItem('ha_simulator_exposure', val);
}

export function getExposure() {
    return exposure;
}

export function hasBackgroundImage() {
    return backgroundImage !== null;
}

function updateOverlayResolution() {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const newSize = Math.round(ROOM_SIZE * Math.min(Math.max(simZoom, 1) * dpr, 4));
    if (canvas.width !== newSize) {
        canvas.width  = newSize;
        canvas.height = newSize;
        isDirty = true;
    }
}

export function resizeCanvas() {
    if (!canvas) return;
    updateOverlayResolution();

    resizeWebGL(ROOM_SIZE, ROOM_SIZE);
    if (backgroundImage) uploadBgTexture();

    lamps.forEach(lamp => {
        lamp.x = lamp.nx * ROOM_SIZE;
        lamp.y = lamp.ny * ROOM_SIZE;
    });

    isDirty = true;
}

export function keepLampsInBounds() {
    const margin = 40 / ROOM_SIZE;
    lamps.forEach(lamp => {
        lamp.nx = Math.max(margin, Math.min(lamp.nx, 1 - margin));
        lamp.ny = Math.max(margin, Math.min(lamp.ny, 1 - margin));
        lamp.x  = lamp.nx * ROOM_SIZE;
        lamp.y  = lamp.ny * ROOM_SIZE;
    });
    isDirty = true;
}

function handleMouseDown(e) {
    if (e.button !== 0 || !entitiesVisible || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / simZoom;
    const y = (e.clientY - rect.top) / simZoom;

    dragTarget = null;

    const lampList = [...lamps.values()].reverse();
    for (const lamp of lampList) {
        const dx = x - lamp.x;
        const dy = y - lamp.y;
        if (dx * dx + dy * dy < 35 * 35) {
            dragTarget = lamp;
            dragOffset.x = dx;
            dragOffset.y = dy;
            canvas.style.cursor = 'grabbing';

            if (selectedEntityCallback) {
                const rgb = lamp.currentRgb;
                const rgbString = `rgb(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])})`;
                selectedEntityCallback(lamp.id, rgbString);
            }
            break;
        }
    }
}

function handleMouseMove(e) {
    if (!canvas) return;
    if (!entitiesVisible) {
        if (canvas.style.cursor !== 'default') canvas.style.cursor = 'default';
        return;
    }
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / simZoom;
    const my = (e.clientY - rect.top) / simZoom;

    if (dragTarget) {
        dragTarget.x = mx - dragOffset.x;
        dragTarget.y = my - dragOffset.y;
        canvas.style.cursor = 'grabbing';
        isDirty = true;
    } else {
        let isHovering = false;
        for (const lamp of lamps.values()) {
            const dx = mx - lamp.x;
            const dy = my - lamp.y;
            if (dx * dx + dy * dy < 35 * 35) { isHovering = true; break; }
        }
        canvas.style.cursor = isHovering ? 'grab' : 'default';
    }
}

function handleMouseUp(e) {
    if (e.button !== 0) return;
    if (dragTarget && canvas) {
        dragTarget.nx = dragTarget.x / ROOM_SIZE;
        dragTarget.ny = dragTarget.y / ROOM_SIZE;
        savePositions();
        canvas.style.cursor = 'grab';
    }
    dragTarget = null;
}

function initSimPanZoom() {
    const room = document.getElementById('room');
    if (!room) return;

    room.addEventListener('wheel', (e) => {
        e.preventDefault();
        simZoomUserSet = true;
        const rect = room.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        const cx = (mx - simPanX) / simZoom;
        const cy = (my - simPanY) / simZoom;
        simZoom = Math.min(SIM_ZOOM_MAX, Math.max(SIM_ZOOM_MIN, simZoom * factor));
        simPanX = mx - cx * simZoom;
        simPanY = my - cy * simZoom;
        applySimTransform();
    }, { passive: false });

    room.addEventListener('mousedown', (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        simIsPanning = true;
        simPanLastX = e.clientX;
        simPanLastY = e.clientY;
        room.classList.add('panning');
    });
    window.addEventListener('mousemove', (e) => {
        if (!simIsPanning) return;
        simPanX += e.clientX - simPanLastX;
        simPanY += e.clientY - simPanLastY;
        simPanLastX = e.clientX;
        simPanLastY = e.clientY;
        applySimTransform();
    });
    window.addEventListener('mouseup', (e) => {
        if (e.button !== 1) return;
        simIsPanning = false;
        room.classList.remove('panning');
    });

    // Touch: 1-finger pan + 2-finger pinch-zoom + hold-to-drag lamps
    let _td = 0, _tmx = 0, _tmy = 0;
    let _stActive = false, _stLastX = 0, _stLastY = 0;
    let _holdTimer = null, _holdLamp = null, _holdStartX = 0, _holdStartY = 0;

    function _cancelHold() {
        if (_holdTimer) { clearTimeout(_holdTimer); _holdTimer = null; }
        _holdLamp = null;
    }

    room.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) {
            const touch = e.touches[0];
            _holdStartX = touch.clientX;
            _holdStartY = touch.clientY;

            // Hold-to-drag: check if touch lands on a lamp.
            // While hold is pending, panning is suppressed so the image
            // doesn't drift during the 400ms wait.
            let lampHit = false;
            if (canvas && entitiesVisible) {
                const rect = canvas.getBoundingClientRect();
                const tx = (touch.clientX - rect.left) / simZoom;
                const ty = (touch.clientY - rect.top) / simZoom;
                const lampList = [...lamps.values()].reverse();
                for (const lamp of lampList) {
                    const dx = tx - lamp.x;
                    const dy = ty - lamp.y;
                    if (dx * dx + dy * dy < 50 * 50) {
                        lampHit = true;
                        _holdLamp = lamp;
                        touchDragOffX = dx;
                        touchDragOffY = dy;
                        _holdTimer = setTimeout(() => {
                            _holdTimer = null;
                            touchDragTarget = _holdLamp;
                            _holdLamp = null;
                            _stActive = false;
                            room.classList.remove('panning');
                            navigator.vibrate?.(50);
                            isDirty = true;
                        }, 400);
                        break;
                    }
                }
            }

            // Only start panning immediately if no lamp was hit.
            // If a lamp WAS hit but the finger moves >20px, panning starts
            // retroactively in touchmove (after cancelling the hold timer).
            if (!lampHit) {
                _stActive = true;
                _stLastX = touch.clientX;
                _stLastY = touch.clientY;
                room.classList.add('panning');
            }
        } else if (e.touches.length === 2) {
            _cancelHold();
            touchDragTarget = null;
            _stActive = false;
            e.preventDefault();
            const rect = room.getBoundingClientRect();
            const [t0, t1] = e.touches;
            _td  = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
            _tmx = (t0.clientX + t1.clientX) / 2 - rect.left;
            _tmy = (t0.clientY + t1.clientY) / 2 - rect.top;
        }
    }, { passive: false });

    room.addEventListener('touchmove', (e) => {
        e.preventDefault();
        if (e.touches.length === 1) {
            const touch = e.touches[0];

            // Cancel hold if finger moved more than 20px; switch to panning.
            if (_holdTimer) {
                const mdx = touch.clientX - _holdStartX;
                const mdy = touch.clientY - _holdStartY;
                if (mdx * mdx + mdy * mdy > 400) {
                    _cancelHold();
                    _stActive = true;
                    _stLastX = touch.clientX;
                    _stLastY = touch.clientY;
                    room.classList.add('panning');
                }
            }

            if (touchDragTarget && canvas) {
                // Drag the lamp
                const rect = canvas.getBoundingClientRect();
                const tx = (touch.clientX - rect.left) / simZoom;
                const ty = (touch.clientY - rect.top) / simZoom;
                touchDragTarget.x = Math.max(0, Math.min(ROOM_SIZE, tx - touchDragOffX));
                touchDragTarget.y = Math.max(0, Math.min(ROOM_SIZE, ty - touchDragOffY));
                isDirty = true;
            } else if (_stActive) {
                const dx = touch.clientX - _stLastX;
                const dy = touch.clientY - _stLastY;
                simPanX += dx;
                simPanY += dy;
                _stLastX = touch.clientX;
                _stLastY = touch.clientY;
                applySimTransform();
            }
        } else if (e.touches.length === 2) {
            simZoomUserSet = true;
            const rect = room.getBoundingClientRect();
            const [t0, t1] = e.touches;
            const nd  = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
            const nmx = (t0.clientX + t1.clientX) / 2 - rect.left;
            const nmy = (t0.clientY + t1.clientY) / 2 - rect.top;
            const factor = nd / _td;
            const cx = (_tmx - simPanX) / simZoom;
            const cy = (_tmy - simPanY) / simZoom;
            simZoom = Math.min(SIM_ZOOM_MAX, Math.max(SIM_ZOOM_MIN, simZoom * factor));
            simPanX = _tmx - cx * simZoom + (nmx - _tmx);
            simPanY = _tmy - cy * simZoom + (nmy - _tmy);
            _td = nd; _tmx = nmx; _tmy = nmy;
            applySimTransform();
        }
    }, { passive: false });

    room.addEventListener('touchend', (e) => {
        _cancelHold();
        _td = 0;
        if (touchDragTarget) {
            touchDragTarget.nx = touchDragTarget.x / ROOM_SIZE;
            touchDragTarget.ny = touchDragTarget.y / ROOM_SIZE;
            savePositions();
            touchDragTarget = null;
        }
        if (e.touches.length === 0) {
            _stActive = false;
            room.classList.remove('panning');
        }
    });

    document.getElementById('sim-zoom-in')?.addEventListener('click', () => {
        simZoomUserSet = true;
        simZoom = Math.min(SIM_ZOOM_MAX, simZoom + 0.1);
        applySimTransform();
    });
    document.getElementById('sim-zoom-out')?.addEventListener('click', () => {
        simZoomUserSet = true;
        simZoom = Math.max(SIM_ZOOM_MIN, simZoom - 0.1);
        applySimTransform();
    });
    document.getElementById('sim-zoom-label')?.addEventListener('click', () => {
        simZoomUserSet = true;
        const room = document.getElementById('room');
        if (!room) return;
        simZoom = 1.0;
        simPanX = (room.offsetWidth  - ROOM_SIZE) / 2;
        simPanY = (room.offsetHeight - ROOM_SIZE) / 2;
        applySimTransform();
    });
    document.getElementById('sim-zoom-fit')?.addEventListener('click', () => {
        simZoomUserSet = false;
        resetSimView();
    });

    // Use ResizeObserver so resetSimView fires when the panel first becomes visible
    // (requestAnimationFrame fires too early if the simulation tab is not active on load)
    const _ro = new ResizeObserver(() => {
        if (room.offsetWidth > 0 && room.offsetHeight > 0) resetSimView();
    });
    _ro.observe(room);
}

function applySimTransform() {
    const simRoom = document.getElementById('simulation-room');
    if (simRoom) simRoom.style.transform = `translate(${simPanX}px, ${simPanY}px) scale(${simZoom})`;
    const label = document.getElementById('sim-zoom-label');
    if (label) label.textContent = Math.round(simZoom * 100) + '%';
    updateOverlayResolution();
}

export function resetSimView() {
    const room = document.getElementById('room');
    if (!room) return;
    const rw = room.offsetWidth;
    const rh = room.offsetHeight;
    if (rw === 0 || rh === 0) return;
    if (!simZoomUserSet) {
        // Fill the full panel — scale to the larger axis so no space is wasted.
        // The smaller axis may overflow slightly but is reachable via pan.
        simZoom = Math.max(SIM_ZOOM_MIN, Math.max(rw / ROOM_SIZE, rh / ROOM_SIZE));
    }
    // Always re-center at whatever zoom is active
    simPanX = (rw - ROOM_SIZE * simZoom) / 2;
    simPanY = (rh - ROOM_SIZE * simZoom) / 2;
    applySimTransform();
}

export function setColorCurve(curve) {
    currentColorCurve = curve;
    isDirty = true;
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function drawLoop(now) {
    if (!ctx) { requestAnimationFrame(drawLoop); return; }

    const anyTransitioning = dragTarget !== null || touchDragTarget !== null ||
        (lamps.size > 0 && [...lamps.values()].some(l => l.transitionEnd > now));

    if (!isDirty && !anyTransitioning) {
        requestAnimationFrame(drawLoop);
        return;
    }
    isDirty = false;

    // FPS measurement (only rendered frames, not skipped ones)
    _fpsFrames++;
    _lastFrameRenderTime = now;
    if (now - _fpsWindowStart >= 500) {
        if (_fpsWindowStart > 0) {
            const elapsed = now - _fpsWindowStart;
            _statFps = Math.round(_fpsFrames * 1000 / elapsed);
            _statFrameMs = Math.round(elapsed / _fpsFrames);
        }
        _fpsFrames = 0;
        _fpsWindowStart = now;
    }

    lastFrameTime = now;

    // Update lamp transition state
    lamps.forEach(lamp => {
        if (lamp.transitionEnd > now) {
            const total = lamp.transitionEnd - lamp.transitionStart;
            const elapsed = now - lamp.transitionStart;
            const t = total > 0 ? Math.min(1, elapsed / total) : 1;

            lamp.currentRgb[0] = lerp(lamp.startRgb[0], lamp.targetRgb[0], t);
            lamp.currentRgb[1] = lerp(lamp.startRgb[1], lamp.targetRgb[1], t);
            lamp.currentRgb[2] = lerp(lamp.startRgb[2], lamp.targetRgb[2], t);
            lamp.currentBrightness = lerp(lamp.startBrightness, lamp.targetBrightness, t);
        } else {
            lamp.currentRgb = [...lamp.targetRgb];
            lamp.currentBrightness = lamp.targetBrightness;
        }
    });

    // WebGL renders background + lighting (all lamps except visibility-hidden ones)
    if (isWebGLAvailable()) {
        renderScene({
            lamps: [...lamps.values()].filter(l => !hiddenEntities[l.id] && !groups[l.id]),
            ambient: ambientLevel,
            wallColor,
            exposure,
            blendMode,
            lightInfluence,
            colorCurve: currentColorCurve,
        });
    } else {
        // Minimal fallback: plain wall color (no lighting)
        ctx.fillStyle = `rgb(${wallColor.r}, ${wallColor.g}, ${wallColor.b})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // Entity bodies on the transparent Canvas 2D overlay
    // canvas.width may be larger than ROOM_SIZE (HiDPI/zoom scaling) — use ctx.scale
    // so all drawing coords remain in the stable [0, ROOM_SIZE] space.
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';

    if (entitiesVisible) {
        const pixelScale = canvas.width / ROOM_SIZE;
        ctx.save();
        ctx.scale(pixelScale, pixelScale);

        lamps.forEach(lamp => {
            ctx.save();
            if (hiddenEntities[lamp.id] && groups[lamp.id]) ctx.globalAlpha = 0;
            else if (hiddenEntities[lamp.id] || groups[lamp.id]) ctx.globalAlpha = 0.2;

            const [r, g, b] = lamp.currentRgb;

            // Body
            ctx.beginPath();
            ctx.arc(lamp.x, lamp.y, 25, 0, Math.PI * 2);
            ctx.fillStyle = lamp.isOff ? '#222' : `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
            ctx.fill();

            // Border
            ctx.strokeStyle = groups[lamp.id] ? '#bd93f9' : '#444';
            ctx.lineWidth = 2;
            ctx.stroke();

            // Touch-drag highlight ring
            if (lamp === touchDragTarget) {
                ctx.beginPath();
                ctx.arc(lamp.x, lamp.y, 34, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
                ctx.lineWidth = 3;
                ctx.stroke();
            }

            // Label
            if (labelsVisible) {
                const labelText = lamp.id.replace('light.', '');
                ctx.font = 'bold 10px Inter, sans-serif';
                ctx.textAlign = 'center';
                ctx.lineJoin = 'round';
                ctx.lineWidth = 3;
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
                ctx.strokeText(labelText, lamp.x, lamp.y + 40);
                ctx.fillStyle = '#e8e8e8';
                ctx.fillText(labelText, lamp.x, lamp.y + 40);
            }

            // Group Icon
            if (groups[lamp.id]) {
                ctx.font = 'bold 10px Inter, sans-serif';
                ctx.textAlign = 'center';
                ctx.lineJoin = 'round';
                ctx.lineWidth = 3;
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
                ctx.strokeText('📁', lamp.x + 20, lamp.y - 20);
                ctx.fillStyle = '#e8e8e8';
                ctx.fillText('📁', lamp.x + 20, lamp.y - 20);
            }

            ctx.restore();
        });

        ctx.restore();
    }

    requestAnimationFrame(drawLoop);
}

export function updateLampEntities(doc, roomElement) {
    const foundIds = new Set();

    function findEntities(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (obj.entity_id) {
            const ids = Array.isArray(obj.entity_id) ? obj.entity_id : [obj.entity_id];
            ids.forEach(id => {
                if (typeof id === 'string' && !id.includes('{{')) {
                    let cleanId = id.trim();
                    if (!cleanId.includes('.')) cleanId = "light." + cleanId;
                    foundIds.add(cleanId);
                }
            });
        }
        if (typeof obj === 'string' && obj.includes('.') && !obj.includes('{{') && !obj.includes(' ')) {
            const parts = obj.split('.');
            if (parts.length === 2 && !['action', 'service', 'condition'].includes(parts[1])) {
                 foundIds.add(obj.trim());
            }
        }
        Object.values(obj).forEach(val => findEntities(val));
    }

    findEntities(doc);
    const uniqueIds = Array.from(foundIds).filter(id => id.startsWith('light.'));

    // Remove old lamps
    const currentKeys = Array.from(lamps.keys());
    currentKeys.forEach(id => {
        if (!uniqueIds.includes(id)) lamps.delete(id);
    });

    // Add new lamps
    uniqueIds.forEach((id, index) => {
        if (!lamps.has(id)) {
            const stored = storedPositions[id];
            let nx, ny;
            if (stored && stored.nx !== undefined) {
                nx = stored.nx;
                ny = stored.ny;
            } else if (stored && canvas) {
                // Migrate old pixel-based format
                nx = stored.x / canvas.width;
                ny = stored.y / canvas.height;
            } else {
                nx = 0.1 + (lamps.size * 0.15);
                ny = 0.15;
            }
            nx = Math.max(0, Math.min(1, nx));
            ny = Math.max(0, Math.min(1, ny));
            lamps.set(id, {
                id,
                nx, ny,
                x: nx * ROOM_SIZE,
                y: ny * ROOM_SIZE,
                currentRgb: [255, 255, 255],
                startRgb: [255, 255, 255],
                targetRgb: [255, 255, 255],
                currentBrightness: 100,
                startBrightness: 100,
                targetBrightness: 100,
                transitionStart: 0,
                transitionEnd: 0,
                isOff: false
            });
        }
    });

    keepLampsInBounds();
    renderEntityBrowser(uniqueIds);
}

export function setLampColor(id, rgbArray, transition, brightness, isOff) {
    const lamp = lamps.get(id);
    if (lamp) {
        isDirty = true;
        const now = performance.now();
        lamp.startRgb = [...lamp.currentRgb];
        lamp.targetRgb = [...rgbArray];
        lamp.startBrightness = lamp.currentBrightness;
        lamp.targetBrightness = brightness;
        lamp.transitionStart = now;
        lamp.transitionEnd = now + (transition * 1000);
        lamp.isOff = isOff;

        // Update Browser Badge
        const safeR = isNaN(rgbArray[0]) ? 255 : Math.round(rgbArray[0]);
        const safeG = isNaN(rgbArray[1]) ? 255 : Math.round(rgbArray[1]);
        const safeB = isNaN(rgbArray[2]) ? 255 : Math.round(rgbArray[2]);
        const safeBr = isNaN(brightness) ? 100 : Math.round(brightness);
        const rgbString = `rgb(${safeR}, ${safeG}, ${safeB})`;
        const stateBody = document.getElementById('state-' + id.replace(/\./g, '-'));
        if (stateBody) {
            const badge = stateBody.querySelector('.entity-badge');
            const span = stateBody.querySelector('span');
            badge.style.backgroundColor = isOff ? '#222' : rgbString;
            badge.style.boxShadow = isOff ? 'none' : `0 0 5px ${rgbString}`;
            span.innerText = isOff ? t('off') : `${safeBr}% | RGB(${safeR},${safeG},${safeB})`;
        }
    }
}

export function resetLamps() {
    isDirty = true;
    lamps.forEach(lamp => {
        lamp.currentRgb = [255, 255, 255];
        lamp.startRgb = [255, 255, 255];
        lamp.targetRgb = [255, 255, 255];
        lamp.currentBrightness = 100;
        lamp.startBrightness = 100;
        lamp.targetBrightness = 100;
        lamp.transitionEnd = 0;
        lamp.isOff = false;
    });

    // Reset inspector badges to white/on state
    const rgbString = 'rgb(255, 255, 255)';
    document.querySelectorAll('.entity-body span').forEach(s => s.innerText = `100% | RGB(255,255,255)`);
    document.querySelectorAll('.entity-badge').forEach(b => {
        b.style.backgroundColor = rgbString;
        b.style.boxShadow = `0 0 5px ${rgbString}`;
    });
}

export function hasModifiedLamps() {
    return Array.from(lamps.values()).some(l =>
        l.isOff ||
        l.targetBrightness !== 100 ||
        l.targetRgb[0] !== 255 || l.targetRgb[1] !== 255 || l.targetRgb[2] !== 255
    );
}

export function snapLampsToTarget() {
    lamps.forEach(l => l.transitionEnd = 0);
}

// ─── Entity Edit Helpers ──────────────────────────────────────────────────────

function _makeModalOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    return overlay;
}

function _showRenameModal(entityId) {
    const overlay = _makeModalOverlay();
    const modal = document.createElement('div');
    modal.className = 'modal-content';
    modal.style.maxWidth = '380px';

    const header = document.createElement('div');
    header.className = 'modal-header';
    const title = document.createElement('span');
    title.textContent = t('entity_rename_title');
    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => overlay.remove());
    header.appendChild(title);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'modal-body';
    body.style.gap = '10px';
    const label = document.createElement('label');
    label.textContent = t('entity_new_name');
    label.style.cssText = 'font-size:12px;color:#aaa;display:block;margin-bottom:6px;';
    const input = document.createElement('input');
    input.className = 'node-input';
    input.value = entityId;
    input.style.width = '100%';
    input.style.boxSizing = 'border-box';
    body.appendChild(label);
    body.appendChild(input);

    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-modal-cancel';
    cancelBtn.textContent = t('cancel');
    cancelBtn.addEventListener('click', () => overlay.remove());
    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn-modal-save';
    saveBtn.textContent = t('lib_save');

    const doRename = () => {
        let newId = input.value.trim();
        if (!newId || newId === entityId) { overlay.remove(); return; }
        if (!newId.includes('.')) newId = 'light.' + newId;
        if (!_getEditorValue || !_setEditorValue) { overlay.remove(); return; }

        let doc;
        try { doc = jsyaml.load(_getEditorValue()); } catch { overlay.remove(); return; }
        if (!doc) { overlay.remove(); return; }

        // Rename in YAML sequence
        if (doc.sequence) renameEntityInSequence(doc.sequence, entityId, newId);

        // Rename exact string matches in top-level variables
        if (doc.variables && typeof doc.variables === 'object') {
            for (const [k, v] of Object.entries(doc.variables)) {
                if (v === entityId) doc.variables[k] = newId;
            }
        }

        // Rename in top-level alias/entity fields (edge case)
        if (doc.target?.entity_id === entityId) doc.target.entity_id = newId;
        else if (Array.isArray(doc.target?.entity_id)) {
            doc.target.entity_id = doc.target.entity_id.map(id => id === entityId ? newId : id);
        }

        // Update groups in localStorage
        if (groups[entityId] !== undefined) {
            groups[newId] = groups[entityId];
            delete groups[entityId];
        }
        Object.keys(groups).forEach(g => {
            groups[g] = groups[g].map(c => c === entityId ? newId : c);
        });
        saveGroups();

        // Update entity order
        _entityOrder = _entityOrder.map(id => id === entityId ? newId : id);
        _saveEntityOrder();

        // Write back YAML — triggers onChange → validateAndSync → full re-render
        overlay.remove();
        _setEditorValue(jsyaml.dump(doc, { lineWidth: 120, noRefs: true }));
    };

    saveBtn.addEventListener('click', doRename);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); doRename(); }
        if (e.key === 'Escape') { e.preventDefault(); overlay.remove(); }
    });

    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);
    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    overlay.appendChild(modal);

    setTimeout(() => { input.focus(); input.select(); }, 50);
}

function _confirmDelete(entityId) {
    const overlay = _makeModalOverlay();
    const modal = document.createElement('div');
    modal.className = 'modal-content';
    modal.style.maxWidth = '360px';

    const header = document.createElement('div');
    header.className = 'modal-header';
    const title = document.createElement('span');
    title.textContent = t('lib_delete');
    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => overlay.remove());
    header.appendChild(title);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'modal-body';
    const msg = document.createElement('p');
    msg.style.cssText = 'margin:0;font-size:12px;color:#f8f8f2;';
    msg.innerHTML = `<code style="color:#8be9fd">${entityId}</code>`;
    const sub = document.createElement('p');
    sub.style.cssText = 'margin:8px 0 0;font-size:11px;color:#aaa;';
    sub.textContent = t('entity_delete_confirm');
    body.appendChild(msg);
    body.appendChild(sub);

    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-modal-cancel';
    cancelBtn.textContent = t('cancel');
    cancelBtn.addEventListener('click', () => overlay.remove());
    const delBtn = document.createElement('button');
    delBtn.className = 'btn-modal-save';
    delBtn.style.cssText = 'border-color:#ff5555;color:#ff5555;';
    delBtn.textContent = t('lib_delete');

    delBtn.addEventListener('click', () => {
        if (!_getEditorValue || !_setEditorValue) { overlay.remove(); return; }

        let doc;
        try { doc = jsyaml.load(_getEditorValue()); } catch { overlay.remove(); return; }
        if (!doc) { overlay.remove(); return; }

        // Remove from YAML sequence
        if (doc.sequence) removeEntityFromSequence(doc.sequence, entityId);

        // Remove from top-level variables if exact value match
        if (doc.variables && typeof doc.variables === 'object') {
            for (const [k, v] of Object.entries(doc.variables)) {
                if (v === entityId) delete doc.variables[k];
            }
        }

        // Remove from groups
        delete groups[entityId];
        Object.keys(groups).forEach(g => {
            groups[g] = groups[g].filter(c => c !== entityId);
        });
        saveGroups();

        // Remove from entity order
        _entityOrder = _entityOrder.filter(id => id !== entityId);
        _saveEntityOrder();

        // Write back YAML
        overlay.remove();
        _setEditorValue(jsyaml.dump(doc, { lineWidth: 120, noRefs: true }));
    });

    footer.appendChild(cancelBtn);
    footer.appendChild(delBtn);
    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    overlay.appendChild(modal);
}

function _reorderEntity(draggedId, targetId, insertBefore) {
    // Ensure both IDs are in _entityOrder
    if (!_entityOrder.includes(draggedId)) _entityOrder.push(draggedId);
    if (!_entityOrder.includes(targetId))  _entityOrder.push(targetId);

    _entityOrder = _entityOrder.filter(id => id !== draggedId);
    const targetIdx = _entityOrder.indexOf(targetId);
    if (targetIdx === -1) return;
    _entityOrder.splice(insertBefore ? targetIdx : targetIdx + 1, 0, draggedId);
    _saveEntityOrder();
    renderEntityBrowser(Array.from(lamps.keys()));
}

// ─── Entity Browser rendering logic ──────────────────────────────────────────

function _sortByEntityOrder(ids) {
    // Add any new IDs not yet tracked
    ids.forEach(id => { if (!_entityOrder.includes(id)) _entityOrder.push(id); });
    // Remove stale IDs no longer present
    _entityOrder = _entityOrder.filter(id => ids.includes(id));
    return [..._entityOrder];
}

function renderEntityBrowser(uniqueIds) {
    const list = document.getElementById('entity-list');
    if (!list) return;
    list.innerHTML = '';

    if (uniqueIds.length === 0) {
        list.innerHTML = `<div style="color: #888; font-size: 11px; padding: 10px;">${t('no_entities')}</div>`;
        return;
    }

    // Apply stored display order
    const orderedIds = _sortByEntityOrder(uniqueIds);

    const standalone = [];
    const groupNodes = {};

    orderedIds.forEach(id => {
        if (groups[id]) {
            groupNodes[id] = groups[id];
        }

        let isChildOf = [];
        Object.keys(groups).forEach(g => {
            if (groups[g].includes(id)) isChildOf.push(g);
        });

        if (isChildOf.length > 0) {
            isChildOf.forEach(g => {
                if (!groupNodes[g]) {
                    groupNodes[g] = groups[g];
                }
            });
        } else if (!groups[id]) {
            standalone.push(id);
        }
    });

    // Render groups in order
    const renderedGroups = new Set();
    orderedIds.forEach(id => {
        if (groupNodes[id] && !renderedGroups.has(id)) {
            renderedGroups.add(id);
            list.appendChild(createEntityNode(id, true, false));
            groupNodes[id].forEach(child => {
                list.appendChild(createEntityNode(child, false, true, id));
            });
        }
    });

    standalone.forEach(id => {
        list.appendChild(createEntityNode(id, false, false));
    });

    setupDragAndDrop();
}

function createEntityNode(id, isGroup, isChild, parentId = null) {
    const item = document.createElement('div');
    item.className = 'entity-item' + (isGroup ? ' entity-group' : '') + (isChild ? ' entity-child' : '');
    item.dataset.id = id;
    if (isGroup) item.dataset.isGroup = 'true';
    if (isChild) item.dataset.parentId = parentId;
    item.draggable = !isGroup;

    const header = document.createElement('div');
    header.className = 'entity-header';
    header.innerHTML = `<div class="entity-id">${id}</div>`;

    const actions = document.createElement('div');
    actions.className = 'entity-actions';

    const btnVis = document.createElement('button');
    btnVis.className = 'btn-icon' + (!hiddenEntities[id] ? ' active' : '');
    btnVis.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    btnVis.title = t('toggle_vis');
    btnVis.onclick = () => {
        hiddenEntities[id] = !hiddenEntities[id];
        saveHidden();
        isDirty = true;
        btnVis.classList.toggle('active', !hiddenEntities[id]);
    };
    actions.appendChild(btnVis);

    if (!isGroup && !isChild) {
        const btnMakeGroup = document.createElement('button');
        btnMakeGroup.className = 'btn-icon';
        btnMakeGroup.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`;
        btnMakeGroup.title = t('mark_group');
        btnMakeGroup.onclick = () => {
            groups[id] = [];
            saveGroups();
            isDirty = true;
            renderEntityBrowser(Array.from(lamps.keys()));
        };
        actions.appendChild(btnMakeGroup);
    }

    if (isChild) {
        const btnRemove = document.createElement('button');
        btnRemove.className = 'btn-icon';
        btnRemove.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`;
        btnRemove.title = t('remove_group');
        btnRemove.onclick = () => {
            groups[parentId] = groups[parentId].filter(c => c !== id);
            saveGroups();
            isDirty = true;
            renderEntityBrowser(Array.from(lamps.keys()));
        };
        actions.appendChild(btnRemove);
    }

    if (isGroup) {
        const btnUngroup = document.createElement('button');
        btnUngroup.className = 'btn-icon';
        btnUngroup.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
        btnUngroup.title = t('ungroup');
        btnUngroup.onclick = () => {
            delete groups[id];
            saveGroups();
            isDirty = true;
            renderEntityBrowser(Array.from(lamps.keys()));
        };
        actions.appendChild(btnUngroup);
    }

    // Rename button
    const btnRename = document.createElement('button');
    btnRename.className = 'btn-icon entity-action-btn';
    btnRename.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
    btnRename.title = t('lib_rename');
    btnRename.onclick = (e) => {
        e.stopPropagation();
        if (_isPlaying()) return;
        _showRenameModal(id);
    };
    actions.appendChild(btnRename);

    // Delete button
    const btnDelete = document.createElement('button');
    btnDelete.className = 'btn-icon entity-action-btn entity-delete-btn';
    btnDelete.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
    btnDelete.title = t('lib_delete');
    btnDelete.onclick = (e) => {
        e.stopPropagation();
        if (_isPlaying()) return;
        _confirmDelete(id);
    };
    actions.appendChild(btnDelete);

    header.appendChild(actions);
    item.appendChild(header);

    const body = document.createElement('div');
    body.className = 'entity-body';
    body.id = 'state-' + id.replace(/\./g, '-');
    body.innerHTML = `
        <div class="entity-badge"></div>
        <span>${t('off')}</span>
    `;
    item.appendChild(body);

    const lamp = lamps.get(id);
    if (lamp) {
        // Update the badge DOM only — never call setLampColor here, as that would
        // overwrite the simulation's pending targetRgb (race: rAF fires ~16ms,
        // but this timeout fires at 10ms, before currentRgb reflects targetRgb).
        setTimeout(() => {
            const stateBody = document.getElementById('state-' + id.replace(/\./g, '-'));
            if (!stateBody) return;
            const badge = stateBody.querySelector('.entity-badge');
            const span  = stateBody.querySelector('span');
            if (lamp.isOff) {
                badge.style.backgroundColor = '#222';
                badge.style.boxShadow = 'none';
                span.innerText = t('off');
            } else {
                const r  = isNaN(lamp.currentRgb[0]) ? 255 : Math.round(lamp.currentRgb[0]);
                const g  = isNaN(lamp.currentRgb[1]) ? 255 : Math.round(lamp.currentRgb[1]);
                const b  = isNaN(lamp.currentRgb[2]) ? 255 : Math.round(lamp.currentRgb[2]);
                const br = isNaN(lamp.currentBrightness) ? 100 : Math.round(lamp.currentBrightness);
                const rgbStr = `rgb(${r}, ${g}, ${b})`;
                badge.style.backgroundColor = rgbStr;
                badge.style.boxShadow = `0 0 5px ${rgbStr}`;
                span.innerText = `${br}% | RGB(${r},${g},${b})`;
            }
        }, 10);
    }

    return item;
}

function setupDragAndDrop() {
    const items = document.querySelectorAll('.entity-item');
    let _dropReorderTarget = null; // { id, before }
    let _indicator = null;

    function _removeIndicator() {
        if (_indicator) { _indicator.remove(); _indicator = null; }
        _dropReorderTarget = null;
    }

    function _showDropIndicator(targetEl, insertBefore) {
        if (!_indicator) {
            _indicator = document.createElement('div');
            _indicator.className = 'entity-drop-indicator';
        }
        const list = document.getElementById('entity-list');
        if (insertBefore) {
            list.insertBefore(_indicator, targetEl);
        } else {
            targetEl.after(_indicator);
        }
    }

    items.forEach(item => {
        if (item.draggable) {
            item.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', item.dataset.id);
                item.style.opacity = '0.5';
            });
            item.addEventListener('dragend', () => {
                item.style.opacity = '1';
                document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
                _removeIndicator();
            });
        }

        if (item.dataset.isGroup === 'true') {
            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                _removeIndicator();
                item.classList.add('drag-over');
            });
            item.addEventListener('dragleave', () => {
                item.classList.remove('drag-over');
            });
            item.addEventListener('drop', (e) => {
                e.preventDefault();
                item.classList.remove('drag-over');
                _removeIndicator();
                const childId = e.dataTransfer.getData('text/plain');
                const groupId = item.dataset.id;
                if (childId && groupId && childId !== groupId) {
                    Object.keys(groups).forEach(g => groups[g] = groups[g].filter(c => c !== childId));
                    if (!groups[groupId].includes(childId)) {
                        groups[groupId].push(childId);
                        saveGroups();
                        renderEntityBrowser(Array.from(lamps.keys()));
                    }
                }
            });
        } else {
            // Non-group: support reorder via drop between items
            item.addEventListener('dragover', (e) => {
                const draggedId = e.dataTransfer.types.includes('text/plain')
                    ? null : null; // can't read mid-drag; just allow
                e.preventDefault();
                document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
                const rect = item.getBoundingClientRect();
                const insertBefore = e.clientY < rect.top + rect.height / 2;
                _dropReorderTarget = { id: item.dataset.id, before: insertBefore };
                _showDropIndicator(item, insertBefore);
            });
            item.addEventListener('dragleave', (e) => {
                // only remove if truly leaving this item (not moving to indicator)
                if (!item.contains(e.relatedTarget) && e.relatedTarget !== _indicator) {
                    _removeIndicator();
                }
            });
            item.addEventListener('drop', (e) => {
                e.preventDefault();
                const draggedId = e.dataTransfer.getData('text/plain');
                const target = _dropReorderTarget;
                _removeIndicator();
                if (draggedId && target && draggedId !== target.id) {
                    _reorderEntity(draggedId, target.id, target.before);
                }
            });
        }
    });
}
