// js/timelineEditor.js

import { getCurrentDoc, assignPaths } from './nodeEditor.js';
import { t } from './i18n.js';
import { getSimElapsedMs, isSimRunning } from './simulator.js';

// ─── Module State ─────────────────────────────────────────────────────────────

let _cmEditor = null;
let _scale = 0.1;       // px per ms — 0.1 = default, triggers auto-fit on first render
let _totalMs = 1000;
let _rafId = null;
let _scrollSyncHandler = null;
let _extraEntities = [];
let _lastColorByEntity = {};
let _blockDragFired = false; // suppresses click-popover after a body drag
let _loopOneMs = 0;          // single-iteration duration when loop active; 0 = no loop

const ROW_H = 36;

// ─── Public API ───────────────────────────────────────────────────────────────

export function initTimelineEditor(cmEditor) {
    _cmEditor = cmEditor;
    setupDelegatedListeners();
    setupLoopButton();
}

export function syncYamlToTimeline(doc) {
    if (!doc) return;
    assignPaths(doc);
    const { events, totalMs } = compileTimeline(doc);
    _totalMs = totalMs;
    renderTimeline(events, totalMs);
    _updateLoopBtnLabel();
}

export function startTimelineCursor() {
    if (_rafId) return;
    const cursor = document.getElementById('tl-cursor');
    if (cursor) cursor.style.display = 'block';
    const tick = () => {
        if (!isSimRunning()) { _rafId = null; return; }
        setPlaybackTime(getSimElapsedMs());
        _rafId = requestAnimationFrame(tick);
    };
    _rafId = requestAnimationFrame(tick);
}

export function setPlaybackTime(ms) {
    const cursor = document.getElementById('tl-cursor');
    const scrollArea = document.getElementById('tl-scroll-area');
    if (!cursor) return;
    const displayMs = _loopOneMs > 0 ? ms % _loopOneMs : ms;
    const left = displayMs * _scale;
    cursor.style.left = left + 'px';
    cursor.style.display = 'block';
    if (scrollArea) {
        const vl = scrollArea.scrollLeft, vr = vl + scrollArea.clientWidth;
        if (left < vl || left > vr - 20) {
            scrollArea.scrollLeft = Math.max(0, left - scrollArea.clientWidth / 3);
        }
    }
}

export function resetTimelineState() {
    _extraEntities = [];
    _lastColorByEntity = {};
    _scale = 0.1; // triggers auto-fit on next render
    updateZoomLabel();
}

// ─── Zoom Helpers ─────────────────────────────────────────────────────────────

function applyZoom(factor, anchorMs) {
    const scrollArea = document.getElementById('tl-scroll-area');
    const oldScale = _scale;
    const newScale = Math.max(0.005, Math.min(2.0, _scale * factor));
    if (Math.abs(newScale - oldScale) < 1e-9) return;
    _scale = newScale;

    // Keep the chosen time position visible in the center
    const pivot = anchorMs ?? ((scrollArea ? scrollArea.scrollLeft + scrollArea.clientWidth / 2 : 0) / oldScale);
    const doc = getCurrentDoc();
    if (doc) syncYamlToTimeline(doc);
    if (scrollArea) scrollArea.scrollLeft = pivot * _scale - scrollArea.clientWidth / 2;
    updateZoomLabel();
}

function updateZoomLabel() {
    const label = document.getElementById('tl-zoom-label');
    if (!label) return;
    const pps = Math.round(_scale * 1000); // px per second
    label.textContent = pps + ' px/s';
}

// ─── Event Delegation (set up once in initTimelineEditor) ─────────────────────

let _hScrollSyncing = false;

function setupDelegatedListeners() {
    const container = document.getElementById('tl-container');
    if (!container) return;

    // ── Zoom buttons ───────────────────────────────────────────────────────
    const zoomOutBtn = document.getElementById('tl-zoom-out');
    const zoomInBtn  = document.getElementById('tl-zoom-in');
    if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => applyZoom(1 / 1.4));
    if (zoomInBtn)  zoomInBtn.addEventListener('click',  () => applyZoom(1.4));

    // ── Dedicated horizontal scrollbar sync ────────────────────────────────
    const hscroll  = document.getElementById('tl-hscroll');
    const scrollArea = document.getElementById('tl-scroll-area');
    const rulerScroll = document.getElementById('tl-ruler-scroll');

    if (hscroll && scrollArea) {
        hscroll.addEventListener('scroll', () => {
            if (_hScrollSyncing) return;
            _hScrollSyncing = true;
            scrollArea.scrollLeft  = hscroll.scrollLeft;
            if (rulerScroll) rulerScroll.scrollLeft = hscroll.scrollLeft;
            _hScrollSyncing = false;
        }, { passive: true });
    }

    // ── Click handler ──────────────────────────────────────────────────────
    container.addEventListener('click', (e) => {
        if (e.target.closest('#tl-popover')) return;

        const isHandle = e.target.classList.contains('tl-block-handle') ||
                         e.target.classList.contains('tl-block-handle-left');
        const block = e.target.closest('.tl-block');

        if (block && !isHandle) {
            if (_blockDragFired) { _blockDragFired = false; return; }
            closePopover();
            showBlockPopover(block, block._tlEvent);
            return;
        }

        const row = e.target.closest('.tl-row');
        if (row && !block) {
            closePopover();
            const entityId = row.dataset.entity;
            const scrollArea = document.getElementById('tl-scroll-area');
            const rect = scrollArea.getBoundingClientRect();
            const clickMs = snapMs(Math.max(0, (e.clientX - rect.left + scrollArea.scrollLeft) / _scale));
            showNewBlockPopover(entityId, clickMs, e.clientX, e.clientY);
            return;
        }

        if (!block) closePopover();
    });

    // ── Mousedown handler (handles + Ctrl+drag copy) ───────────────────────
    container.addEventListener('mousedown', (e) => {
        const isLeftHandle  = e.target.classList.contains('tl-block-handle-left');
        const isRightHandle = e.target.classList.contains('tl-block-handle');

        if (isLeftHandle) {
            e.preventDefault(); e.stopPropagation();
            const block = e.target.closest('.tl-block');
            if (block && block._tlEvent) startLeftHandleDrag(e, block);
            return;
        }

        if (isRightHandle) {
            e.preventDefault(); e.stopPropagation();
            const block = e.target.closest('.tl-block');
            if (block && block._tlEvent) startRightHandleDrag(e, block);
            return;
        }

        const block = e.target.closest('.tl-block');
        if (block && block._tlEvent) {
            if (e.ctrlKey) {
                e.preventDefault();
                startBlockCopy(e, block);
            } else if (!isLeftHandle && !isRightHandle) {
                startBlockBodyDrag(e, block);
            }
        }
    });

    // ── Zoom: Ctrl+Wheel ───────────────────────────────────────────────────
    const scrollAreaEl = document.getElementById('tl-scroll-area');
    if (scrollAreaEl) {
        scrollAreaEl.addEventListener('wheel', (e) => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
            const rect = scrollAreaEl.getBoundingClientRect();
            const anchorMs = (e.clientX - rect.left + scrollAreaEl.scrollLeft) / _scale;
            applyZoom(factor, anchorMs);
            // Correct scroll position to keep cursor-ms under mouse
            scrollAreaEl.scrollLeft = anchorMs * _scale - (e.clientX - rect.left);
        }, { passive: false });

        // ── Insert ghost indicator ─────────────────────────────────────────
        scrollAreaEl.addEventListener('mousemove', (e) => {
            const ghost = document.getElementById('tl-insert-ghost');
            if (!ghost) return;
            const onBlock = e.target.closest('.tl-block');
            const onRow   = e.target.closest('.tl-row');
            if (!onRow || onBlock) {
                ghost.style.display = 'none';
                return;
            }
            const rect = scrollAreaEl.getBoundingClientRect();
            const ms = snapMs(Math.max(0, (e.clientX - rect.left + scrollAreaEl.scrollLeft) / _scale));
            ghost.style.left = (ms * _scale) + 'px';
            ghost.dataset.time = formatTime(ms);
            ghost.style.display = 'block';
        }, { passive: true });

        scrollAreaEl.addEventListener('mouseleave', () => {
            const ghost = document.getElementById('tl-insert-ghost');
            if (ghost) ghost.style.display = 'none';
        }, { passive: true });
    }
}

// ─── Drag: Left Handle (move left edge, right edge fixed) ────────────────────

function startLeftHandleDrag(e, block) {
    const event      = block._tlEvent;
    const rampEl     = block.querySelector('.tl-block-ramp');
    const startX     = e.clientX;
    const origStartPx = event.startMs * _scale;
    const rightEdgeMs = event.startMs + event.durationMs; // fixed during drag

    const onMove = (e2) => {
        const dx = e2.clientX - startX;
        const newStartMs = snapMs(Math.max(0, origStartPx + dx) / _scale);
        const newDurMs   = Math.max(0, rightEdgeMs - newStartMs);
        block.style.left  = (newStartMs * _scale) + 'px';
        block.style.width = Math.max(4, newDurMs * _scale) + 'px';
        if (rampEl) rampEl.style.width = Math.max(0, newDurMs * _scale) + 'px';
    };

    const onUp = (e2) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const dx = e2.clientX - startX;
        const newStartMs = snapMs(Math.max(0, origStartPx + dx) / _scale);
        const newDurMs   = Math.max(0, rightEdgeMs - newStartMs);
        applyPreDelayEdit(event, newStartMs);
        applyBlockEdit(event.stepRef, { transition: parseFloat((newDurMs / 1000).toFixed(3)) });
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

// ─── Drag: Right Handle (extend transition, right edge only) ─────────────────

function startRightHandleDrag(e, block) {
    const event    = block._tlEvent;
    const rampEl   = block.querySelector('.tl-block-ramp');
    const startX   = e.clientX;
    const startWidth = block.offsetWidth;

    const onMove = (e2) => {
        const dx = e2.clientX - startX;
        const rawMs = Math.max(0, startWidth + dx) / _scale;
        const snappedMs = snapMs(rawMs);
        const snappedPx = Math.max(4, snappedMs * _scale);
        block.style.width = snappedPx + 'px';
        if (rampEl) rampEl.style.width = snappedPx + 'px';
    };

    const onUp = (e2) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const dx = e2.clientX - startX;
        const snappedMs = snapMs(Math.max(0, startWidth + dx) / _scale);
        // rebuildAsAlwaysParallel will recalculate gap delays automatically
        applyBlockEdit(event.stepRef, { transition: parseFloat((snappedMs / 1000).toFixed(3)) });
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

// ─── Ctrl+Drag: Copy Block ────────────────────────────────────────────────────

function startBlockCopy(e, block) {
    const event = block._tlEvent;
    const ghost = block.cloneNode(true);
    ghost.style.opacity = '0.65';
    ghost.style.pointerEvents = 'none';
    ghost.style.position = 'fixed';
    ghost.style.zIndex = '9999';
    ghost.style.width = block.offsetWidth + 'px';
    ghost.style.height = block.offsetHeight + 'px';
    ghost.style.margin = '0';
    document.body.appendChild(ghost);

    const posGhost = (ex, ey) => {
        ghost.style.left = (ex - block.offsetWidth / 2) + 'px';
        ghost.style.top  = (ey - block.offsetHeight / 2) + 'px';
    };
    posGhost(e.clientX, e.clientY);

    const onMove = (e2) => posGhost(e2.clientX, e2.clientY);

    const onUp = (e2) => {
        ghost.remove();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);

        const targetRow = document.elementFromPoint(e2.clientX, e2.clientY)?.closest('.tl-row');
        if (!targetRow) return;
        const targetEntity = targetRow.dataset.entity;
        const scrollArea   = document.getElementById('tl-scroll-area');
        const rect         = scrollArea.getBoundingClientRect();
        const targetMs     = Math.max(0, (e2.clientX - rect.left + scrollArea.scrollLeft) / _scale);
        duplicateBlock(event, targetEntity, targetMs);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

// ─── Drag: Block Body (move block) ───────────────────────────────────────────

function startBlockBodyDrag(e, block) {
    const event    = block._tlEvent;
    const startX   = e.clientX;
    const origLeft = parseFloat(block.style.left) || 0;
    let hasDragged = false;

    const onMove = (e2) => {
        const dx = e2.clientX - startX;
        if (!hasDragged && Math.abs(dx) < 4) return;
        hasDragged = true;
        const newStartMs = snapMs(Math.max(0, origLeft + dx) / _scale);
        block.style.left = (newStartMs * _scale) + 'px';
    };

    const onUp = (e2) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (!hasDragged) return;
        _blockDragFired = true;
        const dx = e2.clientX - startX;
        const newStartMs = snapMs(Math.max(0, origLeft + dx) / _scale);
        applyPreDelayEdit(event, newStartMs);
        pushTimelineToYaml();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

// ─── YAML → Timeline Compilation ──────────────────────────────────────────────

function compileTimeline(doc) {
    const events = [];

    function walkSequence(steps, startMs, repeatGroup, hasCondition) {
        if (!Array.isArray(steps)) return startMs;
        let currentMs = startMs;

        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            if (!step || typeof step !== 'object') continue;
            const type = detectStepType(step);

            if (type === 'action') {
                const actionName = (step.action || step.service || '').toLowerCase();
                if (actionName.includes('light.')) {
                    const data = step.data || {};
                    const transition = parseFloat(data.transition) || 0;
                    const isTemplate = hasTemplateIn(
                        data.rgb_color, data.hs_color, data.xy_color,
                        data.brightness_pct, data.transition
                    );
                    const ids = resolveEntityIds(step);

                    // Look ahead: absorb an immediately following delay as holdMs
                    const actionI = i; // save before possible i++ below
                    let holdMs = 0, delayRef = null, delayParent = null;
                    const nextStep = steps[i + 1];
                    if (nextStep && detectStepType(nextStep) === 'delay') {
                        holdMs     = parseDelayMs(nextStep.delay);
                        delayRef   = nextStep;
                        delayParent = steps;
                        i++; // skip the delay step in the loop
                    }

                    const actionIdx = actionI;

                    // Look behind using actionI (before i was incremented for post-delay)
                    const prevStep = actionI > 0 ? steps[actionI - 1] : null;
                    const preDelayRef = (prevStep && detectStepType(prevStep) === 'delay') ? prevStep : null;
                    const preDelayParent = preDelayRef ? steps : null;

                    ids.forEach(entityId => {
                        events.push({
                            entityId,
                            startMs:        currentMs,
                            durationMs:     Math.max(0, transition * 1000),
                            holdMs,
                            color:          isTemplate ? null : extractRgb(data),
                            brightness:     isTemplate ? null : extractBrightness(data),
                            isOff:          actionName.includes('turn_off'),
                            yamlPath:       step.__path || '',
                            stepRef:        step,
                            parentArray:    steps,
                            indexInParent:  actionIdx,
                            delayRef,
                            delayParent,
                            preDelayRef,
                            preDelayParent,
                            repeatGroup:    repeatGroup || null,
                            isTemplate,
                            hasCondition:   hasCondition || false,
                            prevColor:      [20, 20, 24], // filled in below
                            _isFirstInGroup: false,
                        });
                    });

                    currentMs += holdMs;
                }

            } else if (type === 'delay') {
                currentMs += parseDelayMs(step.delay);

            } else if (type === 'parallel') {
                const branches = Array.isArray(step.parallel) ? step.parallel : [];
                const branchEnds = branches.map(b => {
                    const seq = Array.isArray(b) ? b : (b.sequence || [b]);
                    return walkSequence(seq, currentMs, repeatGroup, hasCondition);
                });
                if (branchEnds.length > 0) currentMs = Math.max(...branchEnds);

            } else if (type === 'repeat') {
                const r = step.repeat || {};
                const seq = r.sequence || [];
                let label = '×?', iterCount = 1;
                if (r.count !== undefined && !hasTemplateIn(String(r.count))) {
                    iterCount = Math.max(1, parseInt(r.count) || 1);
                    label = `×${iterCount}`;
                } else if (r.for_each !== undefined) { label = '×item'; }
                  else if (r.while)                  { label = '×while'; }
                  else if (r.until)                  { label = '×until'; }

                const newGroup = { path: step.__path || `repeat_${i}`, count: label };
                const iterEnd  = walkSequence(seq, currentMs, newGroup, hasCondition);
                currentMs += Math.max(0, iterEnd - currentMs) * iterCount;

            } else if (type === 'choose') {
                const choices = Array.isArray(step.choose) ? step.choose : [];
                if (choices.length > 0) walkSequence(choices[0].sequence || [], currentMs, repeatGroup, true);

            } else if (type === 'if') {
                walkSequence(step.then || [], currentMs, repeatGroup, true);
            }
        }
        return currentMs;
    }

    const endMs = walkSequence(doc.sequence || [], 0, null, false);

    // Assign prevColor per entity (sorted by startMs)
    const prevColorByEntity = {};
    [...events].sort((a, b) => a.startMs - b.startMs).forEach(ev => {
        ev.prevColor = prevColorByEntity[ev.entityId]
            ? [...prevColorByEntity[ev.entityId]]
            : [20, 20, 24];
        if (ev.color) prevColorByEntity[ev.entityId] = ev.color;
    });

    // Mark first event in each repeat group
    const groupMinStart = {};
    events.forEach(ev => {
        if (ev.repeatGroup) {
            const k = ev.repeatGroup.path;
            if (!(k in groupMinStart) || ev.startMs < groupMinStart[k]) groupMinStart[k] = ev.startMs;
        }
    });
    events.forEach(ev => {
        if (ev.repeatGroup) ev._isFirstInGroup = ev.startMs === groupMinStart[ev.repeatGroup.path];
    });

    return { events, totalMs: Math.max(endMs, 1000) };
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderTimeline(events, totalMs) {
    const scrollArea  = document.getElementById('tl-scroll-area');
    const entityCol   = document.getElementById('tl-entity-col');
    const ruler       = document.getElementById('tl-ruler');
    const rulerScroll = document.getElementById('tl-ruler-scroll');
    const emptyState  = document.getElementById('tl-empty-state');
    if (!scrollArea || !entityCol || !ruler) return;

    // ── Loop metrics ───────────────────────────────────────────────────────
    // Timeline always shows a single iteration. The cursor wraps via _loopOneMs.
    const loopWrapper = _detectLoopWrapper(getCurrentDoc()?.sequence || []);
    let displayTotalMs = totalMs;
    if (loopWrapper) {
        const r = loopWrapper.repeat;
        if (r.while === true) {
            _loopOneMs = totalMs;          // compileTimeline returns 1 pass for while:true
        } else {
            const count = Math.max(1, r.count || 1);
            _loopOneMs = count > 1 ? totalMs / count : totalMs;
        }
        displayTotalMs = _loopOneMs;       // ruler + rows show only one loop
    } else {
        _loopOneMs = 0;
    }

    // Entity order: from YAML events + manually added extras
    const entityOrder = [], seen = new Set();
    events.forEach(ev => { if (!seen.has(ev.entityId)) { seen.add(ev.entityId); entityOrder.push(ev.entityId); } });
    _extraEntities.forEach(id => { if (!seen.has(id)) { seen.add(id); entityOrder.push(id); } });

    // Auto-fit scale only on first render (while _scale is still at default 0.1)
    const containerWidth = scrollArea.clientWidth || 600;
    if (_scale === 0.1) {
        _scale = Math.max(0.005, Math.min(0.3, (containerWidth - 40) / Math.max(displayTotalMs, 1)));
    }
    const totalPx = Math.max(containerWidth + 20, displayTotalMs * _scale + 100);

    // Update last-color tracking for new-block defaults
    events.forEach(ev => { if (ev.color) _lastColorByEntity[ev.entityId] = ev.color; });

    // ── Ruler ─────────────────────────────────────────────────────────────
    ruler.innerHTML = '';
    ruler.style.width = totalPx + 'px';
    const { major, minor, medium } = calculateTickInterval(_scale);
    const tickGcd = medium > 0 ? tickIntervalGcd(minor, medium) : minor;
    for (let tMs = 0; tMs <= displayTotalMs + major; tMs += tickGcd) {
        const isMajor  = tMs % major === 0;
        const isMedium = !isMajor && medium > 0 && tMs % medium === 0;
        const isMinor  = !isMajor && !isMedium && tMs % minor === 0;
        if (!isMajor && !isMedium && !isMinor) continue;
        const tick = document.createElement('div');
        tick.className = 'tl-tick' + (isMajor ? ' major' : isMedium ? ' medium' : '');
        tick.style.left = (tMs * _scale) + 'px';
        if (isMajor) {
            const lbl = document.createElement('span');
            lbl.className = 'tl-tick-label';
            lbl.textContent = formatTime(tMs);
            tick.appendChild(lbl);
        }
        ruler.appendChild(tick);
    }

    // ── Entity Column ──────────────────────────────────────────────────────
    entityCol.innerHTML = '';
    entityOrder.forEach(entityId => {
        const label = document.createElement('div');
        label.className = 'tl-entity-label';
        label.title = entityId;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'tl-entity-name';
        nameSpan.textContent = entityId.replace('light.', '');
        label.appendChild(nameSpan);

        const actions = document.createElement('div');
        actions.className = 'tl-entity-actions';

        const editBtn = document.createElement('button');
        editBtn.className = 'tl-entity-action-btn';
        editBtn.textContent = '✎';
        editBtn.title = 'Rename entity';
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            startTrackRename(label, nameSpan, entityId);
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'tl-entity-action-btn tl-entity-delete';
        delBtn.textContent = '✕';
        delBtn.title = 'Delete track';
        delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteTrack(entityId);
        });

        actions.appendChild(editBtn);
        actions.appendChild(delBtn);
        label.appendChild(actions);
        entityCol.appendChild(label);
    });
    // Add-entity button
    const addBtn = document.createElement('div');
    addBtn.className = 'tl-add-entity-btn';
    addBtn.title = t('tl_add_entity');
    addBtn.textContent = '+';
    addBtn.addEventListener('click', (e) => { e.stopPropagation(); promptAddEntity(entityCol, addBtn); });
    entityCol.appendChild(addBtn);

    // ── Scroll Area rows ───────────────────────────────────────────────────
    scrollArea.innerHTML = '';
    // Do NOT set min-width on the scroll container itself — that would make
    // scrollWidth === clientWidth and kill the scroll range. Only the rows
    // inside define the scrollable content width.

    const rowMap = {};
    entityOrder.forEach(entityId => {
        const row = document.createElement('div');
        row.className = 'tl-row';
        row.style.width = totalPx + 'px';
        row.dataset.entity = entityId;
        rowMap[entityId] = row;
        scrollArea.appendChild(row);
    });

    // ── Pre-zones (visual indicator for initial delay per entity) ──────────
    const firstByEntity = {};
    events.forEach(ev => {
        if (!(ev.entityId in firstByEntity) || ev.startMs < firstByEntity[ev.entityId]) {
            firstByEntity[ev.entityId] = ev.startMs;
        }
    });
    Object.entries(firstByEntity).forEach(([entityId, startMs]) => {
        if (startMs > 0) {
            const row = rowMap[entityId];
            if (!row) return;
            const preZone = document.createElement('div');
            preZone.className = 'tl-pre-zone';
            preZone.style.left = '0';
            preZone.style.width = (startMs * _scale) + 'px';
            row.appendChild(preZone);
        }
    });

    // ── Continuation zones (light holds last state between blocks) ────────
    const eventsByEntity = {};
    events.forEach(ev => {
        if (!eventsByEntity[ev.entityId]) eventsByEntity[ev.entityId] = [];
        eventsByEntity[ev.entityId].push(ev);
    });
    Object.entries(eventsByEntity).forEach(([entityId, entityEvents]) => {
        const row = rowMap[entityId];
        if (!row) return;
        const sorted = [...entityEvents].sort((a, b) => a.startMs - b.startMs);
        for (let i = 0; i < sorted.length - 1; i++) {
            const curr = sorted[i];
            const next = sorted[i + 1];
            // Gap starts after the block's transition (durationMs), not holdMs
            const gapStartMs = curr.startMs + (curr.durationMs || 0);
            const gapEndMs   = next.startMs;
            if (gapEndMs <= gapStartMs) continue;
            const zone = document.createElement('div');
            zone.className = 'tl-continuation-zone';
            zone.style.left  = (gapStartMs * _scale) + 'px';
            zone.style.width = ((gapEndMs - gapStartMs) * _scale) + 'px';
            if (curr.color) {
                const [r, g, b] = curr.color;
                zone.style.background      = `rgba(${r},${g},${b},0.10)`;
                zone.style.borderLeftColor = `rgba(${r},${g},${b},0.35)`;
            }
            row.appendChild(zone);
        }
    });

    // ── Blocks ─────────────────────────────────────────────────────────────
    events.forEach(event => {
        const row = rowMap[event.entityId];
        if (!row) return;
        row.appendChild(buildBlockElement(event));
    });

    // ── Cursor ─────────────────────────────────────────────────────────────
    const cursor = document.createElement('div');
    cursor.id = 'tl-cursor';
    cursor.style.height = (Math.max(1, entityOrder.length) * ROW_H) + 'px';
    scrollArea.appendChild(cursor);

    // ── Insert ghost ───────────────────────────────────────────────────────
    const ghost = document.createElement('div');
    ghost.id = 'tl-insert-ghost';
    ghost.style.height = (Math.max(1, entityOrder.length) * ROW_H) + 'px';
    scrollArea.appendChild(ghost);

    // ── Empty state ────────────────────────────────────────────────────────
    if (emptyState) emptyState.style.display = entityOrder.length === 0 ? 'flex' : 'none';

    // ── Horizontal scrollbar dummy content width ───────────────────────────
    const hscrollInner = document.getElementById('tl-hscroll-inner');
    const hscroll      = document.getElementById('tl-hscroll');
    if (hscrollInner) hscrollInner.style.width = totalPx + 'px';

    // ── Scroll sync ────────────────────────────────────────────────────────
    if (_scrollSyncHandler) scrollArea.removeEventListener('scroll', _scrollSyncHandler);
    _scrollSyncHandler = () => {
        if (_hScrollSyncing) return;
        _hScrollSyncing = true;
        if (entityCol)   entityCol.scrollTop    = scrollArea.scrollTop;
        if (rulerScroll) rulerScroll.scrollLeft = scrollArea.scrollLeft;
        if (hscroll)     hscroll.scrollLeft     = scrollArea.scrollLeft;
        _hScrollSyncing = false;
    };
    scrollArea.addEventListener('scroll', _scrollSyncHandler, { passive: true });

    // ── Zoom label ─────────────────────────────────────────────────────────
    updateZoomLabel();
}

function buildBlockElement(event) {
    const transitionPx = Math.max(0, event.durationMs * _scale);
    // Blocks represent only the transition. Instant changes (durationMs=0) → 4px marker.
    const totalPx = event.durationMs > 0 ? Math.max(8, transitionPx) : 16;

    const block = document.createElement('div');
    block.className = 'tl-block';
    if (event.durationMs === 0) block.classList.add('tl-block-instant');
    block.style.left  = (event.startMs * _scale) + 'px';
    block.style.width = totalPx + 'px';

    // ── Color logic ────────────────────────────────────────────────────────
    let thisRgb, textColor;
    const pr = event.prevColor || [20, 20, 24];

    if (event.isTemplate) {
        thisRgb   = null;
        textColor = '#ccc';
    } else if (event.isOff) {
        thisRgb   = [40, 40, 44];
        textColor = '#888';
    } else if (event.color) {
        thisRgb   = event.color;
        const [r, g, b] = thisRgb;
        textColor = (0.299 * r + 0.587 * g + 0.114 * b) > 140 ? '#1a1a1e' : '#f8f8f2';
    } else {
        thisRgb   = [80, 80, 88];
        textColor = '#eee';
    }

    // ── Ramp zone (covers full block width — transition only model) ────────
    const rampEl = document.createElement('div');
    rampEl.className = 'tl-block-ramp';
    rampEl.style.width = totalPx + 'px';

    if (event.durationMs > 0) {
        if (event.isTemplate) {
            rampEl.style.background = 'repeating-linear-gradient(45deg,#44475a 0 4px,#282a36 4px 8px)';
        } else {
            const effectiveRgb = thisRgb || [80, 80, 88];
            const [pr0, pr1, pr2] = pr;
            const [tr0, tr1, tr2] = effectiveRgb;
            const oldRgb = `rgb(${pr0},${pr1},${pr2})`;
            const newRgb = `rgb(${tr0},${tr1},${tr2})`;

            // Upper triangle: gradient old → new
            const topDiv = document.createElement('div');
            topDiv.style.cssText = `position:absolute;inset:0;background:linear-gradient(to right,${oldRgb},${newRgb});clip-path:polygon(0% 0%,100% 0%,0% 100%);pointer-events:none`;
            rampEl.appendChild(topDiv);

            // Lower triangle: solid new color
            const botDiv = document.createElement('div');
            botDiv.style.cssText = `position:absolute;inset:0;background:${newRgb};clip-path:polygon(100% 0%,100% 100%,0% 100%);pointer-events:none`;
            rampEl.appendChild(botDiv);
        }
    } else {
        // Instant change: solid color fill
        if (event.isTemplate) {
            rampEl.style.background = 'repeating-linear-gradient(45deg,#44475a 0 4px,#282a36 4px 8px)';
        } else if (thisRgb) {
            rampEl.style.background = `rgb(${thisRgb[0]},${thisRgb[1]},${thisRgb[2]})`;
        } else {
            rampEl.style.background = '#555';
        }
    }

    // ── Label overlay (transparent background, spans full block) ───────────
    const holdEl = document.createElement('div');
    holdEl.className = 'tl-block-hold';
    holdEl.style.left       = '0';
    holdEl.style.right      = '0';
    holdEl.style.background = 'transparent';
    holdEl.style.color      = textColor;

    // Inner label
    const inner = document.createElement('div');
    inner.className = 'tl-block-inner';
    inner.textContent = buildBlockLabel(event);
    holdEl.appendChild(inner);

    // Condition badge
    if (event.hasCondition) {
        const badge = document.createElement('div');
        badge.className = 'tl-block-badge';
        badge.textContent = '?';
        holdEl.appendChild(badge);
    }

    // ── Left handle (move left edge, extends transition left) ──────────────
    const handleLeft = document.createElement('div');
    handleLeft.className = 'tl-block-handle-left';
    handleLeft.style.left = '0';

    // ── Right handle (extend transition right) ─────────────────────────────
    const handle = document.createElement('div');
    handle.className = 'tl-block-handle';

    block.appendChild(rampEl);
    block.appendChild(holdEl);
    block.appendChild(handleLeft);
    block.appendChild(handle);
    block._tlEvent = event;
    return block;
}

// ─── Block Popover (edit existing block) ──────────────────────────────────────

function showBlockPopover(blockEl, event) {
    if (!event) return;
    closePopover();

    const popover = document.createElement('div');
    popover.id = 'tl-popover';
    popover.className = 'tl-popover';

    const data = event.stepRef?.data || {};

    // Color
    if (!event.isOff) {
        const row = makePopoverRow(t('tl_color'));
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.className = 'tl-popover-color';
        colorInput.value = rgbToHex(event.color || [255, 255, 255]);
        colorInput.addEventListener('change', () =>
            applyBlockEdit(event.stepRef, { rgb_color: hexToRgb(colorInput.value) })
        );
        row.appendChild(colorInput);
        popover.appendChild(row);
    }

    // Brightness
    const brRow = makePopoverRow(t('tl_brightness'));
    const brInput = makeNumberInput(data.brightness_pct ?? (event.brightness ?? ''), 0, 100, 1);
    brInput.addEventListener('change', () => applyBlockEdit(event.stepRef, { brightness_pct: brInput.value }));
    brRow.appendChild(brInput);
    popover.appendChild(brRow);

    // Transition
    const trRow = makePopoverRow(t('tl_transition'));
    const trInput = makeNumberInput(data.transition ?? '', 0, null, 0.1);
    trInput.addEventListener('change', () => applyBlockEdit(event.stepRef, { transition: trInput.value }));
    trRow.appendChild(trInput);
    popover.appendChild(trRow);

    // Delete
    const delBtn = document.createElement('button');
    delBtn.className = 'tl-popover-delete';
    delBtn.textContent = t('tl_delete_step');
    delBtn.addEventListener('click', () => { closePopover(); deleteStep(event); });
    popover.appendChild(delBtn);

    document.body.appendChild(popover);
    positionPopover(popover, blockEl.getBoundingClientRect());
    setTimeout(() => document.addEventListener('click', _closeOnOutside), 0);
}

// ─── New Block Popover (create from click) ────────────────────────────────────

function showNewBlockPopover(entityId, startMs, clickX, clickY) {
    closePopover();

    const popover = document.createElement('div');
    popover.id = 'tl-popover';
    popover.className = 'tl-popover';

    const defaultColor = _lastColorByEntity[entityId]
        ? rgbToHex(_lastColorByEntity[entityId])
        : '#ff9900';

    // Color
    const colorRow = makePopoverRow(t('tl_color'));
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'tl-popover-color';
    colorInput.value = defaultColor;
    colorRow.appendChild(colorInput);
    popover.appendChild(colorRow);

    // Brightness
    const brRow = makePopoverRow(t('tl_brightness'));
    const brInput = makeNumberInput(100, 0, 100, 1);
    brRow.appendChild(brInput);
    popover.appendChild(brRow);

    // Transition
    const trRow = makePopoverRow(t('tl_transition'));
    const trInput = makeNumberInput(1, 0, null, 0.1);
    trRow.appendChild(trInput);
    popover.appendChild(trRow);

    // Ghost helpers
    const doc = getCurrentDoc();
    const effectiveStartMs = resolveInsertMs(doc?.sequence || [], startMs, entityId);

    const buildGhostEvent = () => {
        const tr = (parseFloat(trInput.value) || 0) * 1000;
        return {
            entityId,
            startMs:      effectiveStartMs,
            durationMs:   tr,
            holdMs:       tr,
            color:        hexToRgb(colorInput.value),
            brightness:   parseFloat(brInput.value),
            isOff:        false,
            isTemplate:   false,
            prevColor:    _lastColorByEntity[entityId] || [20, 20, 24],
            hasCondition: false,
        };
    };

    const showGhost = () => {
        removeBlockGhost();
        const row = document.querySelector(`.tl-row[data-entity="${CSS.escape(entityId)}"]`);
        if (!row) return;
        const el = buildBlockElement(buildGhostEvent());
        el.id = 'tl-block-ghost';
        el.classList.add('tl-block-ghost');
        row.appendChild(el);
    };

    // Create button
    const createBtn = document.createElement('button');
    createBtn.className = 'tl-popover-create';
    createBtn.textContent = t('tl_create_block');
    createBtn.addEventListener('mouseenter', showGhost);
    createBtn.addEventListener('mouseleave', removeBlockGhost);
    createBtn.addEventListener('click', () => {
        const color      = hexToRgb(colorInput.value);
        const brightness = parseFloat(brInput.value);
        const transition = parseFloat(trInput.value) || 0;
        closePopover();
        createNewBlock(entityId, startMs, color, brightness, transition);
    });
    popover.appendChild(createBtn);

    // Live-update ghost when inputs change
    [colorInput, brInput, trInput].forEach(inp => {
        inp.addEventListener('input', () => {
            if (document.getElementById('tl-block-ghost')) showGhost();
        });
    });

    document.body.appendChild(popover);

    // Position relative to click
    const pw = popover.offsetWidth || 200, ph = popover.offsetHeight || 220;
    let left = clickX, top = clickY + 8;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (top  + ph > window.innerHeight - 8) top  = clickY - ph - 8;
    popover.style.left = Math.max(4, left) + 'px';
    popover.style.top  = Math.max(4, top)  + 'px';

    setTimeout(() => document.addEventListener('click', _closeOnOutside), 0);
}

function _closeOnOutside(e) {
    if (!e.target.closest('#tl-popover') && !e.target.closest('.tl-block')) closePopover();
}

function closePopover() {
    const p = document.getElementById('tl-popover');
    if (p) p.remove();
    document.removeEventListener('click', _closeOnOutside);
    removeBlockGhost();
}

function removeBlockGhost() {
    const g = document.getElementById('tl-block-ghost');
    if (g) g.remove();
}

function positionPopover(popover, rect) {
    const pw = popover.offsetWidth || 200, ph = popover.offsetHeight || 180;
    let left = rect.left, top = rect.bottom + 6;
    if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
    if (top  + ph > window.innerHeight - 8) top  = rect.top - ph - 6;
    popover.style.left = Math.max(4, left) + 'px';
    popover.style.top  = Math.max(4, top)  + 'px';
}

function makePopoverRow(labelText) {
    const row = document.createElement('div');
    row.className = 'tl-popover-row';
    const label = document.createElement('span');
    label.className = 'tl-popover-label';
    label.textContent = labelText;
    row.appendChild(label);
    return row;
}

function makeNumberInput(value, min, max, step) {
    const input = document.createElement('input');
    input.type = 'number';
    input.value = value;
    if (min !== null && min !== undefined) input.min = min;
    if (max !== null && max !== undefined) input.max = max;
    input.step = step;
    return input;
}

// ─── Track Edit / Delete ──────────────────────────────────────────────────────

function deleteTrack(entityId) {
    const doc = getCurrentDoc();
    if (!doc || !doc.sequence) return;
    removeEntityFromSequence(doc.sequence, entityId);
    _extraEntities = _extraEntities.filter(id => id !== entityId);
    pushTimelineToYaml();
}

function removeEntityFromSequence(seq, entityId) {
    let i = 0;
    while (i < seq.length) {
        const step = seq[i];
        const type = detectStepType(step);

        if (type === 'action') {
            if (resolveEntityIds(step).includes(entityId)) {
                const hasDelay = i + 1 < seq.length && detectStepType(seq[i + 1]) === 'delay';
                seq.splice(i, hasDelay ? 2 : 1);
                continue;
            }
        } else if (type === 'parallel') {
            // Remove branches entirely owned by this entity, clean others recursively
            step.parallel = step.parallel.filter(b => {
                const bSeq = Array.isArray(b) ? b : (b.sequence || []);
                const actions = bSeq.filter(s => detectStepType(s) === 'action');
                return !(actions.length > 0 && actions.every(s => resolveEntityIds(s).every(id => id === entityId)));
            });
            step.parallel.forEach(b => {
                const bSeq = Array.isArray(b) ? b : (b.sequence || []);
                removeEntityFromSequence(bSeq, entityId);
            });
            if (step.parallel.length === 0) {
                seq.splice(i, 1); continue;
            }
            if (step.parallel.length === 1) {
                const only = step.parallel[0];
                const bSeq = Array.isArray(only) ? only : (only.sequence || []);
                seq.splice(i, 1, ...bSeq); continue;
            }
        } else if (type === 'repeat') {
            removeEntityFromSequence(step.repeat?.sequence || [], entityId);
        } else if (type === 'choose') {
            (step.choose || []).forEach(c => removeEntityFromSequence(c.sequence || [], entityId));
        } else if (type === 'if') {
            removeEntityFromSequence(step.then || [], entityId);
            removeEntityFromSequence(step.else || [], entityId);
        }
        i++;
    }
}

function startTrackRename(labelEl, nameSpan, entityId) {
    const actions = labelEl.querySelector('.tl-entity-actions');
    if (actions) actions.style.display = 'none';
    nameSpan.style.display = 'none';

    const input = document.createElement('input');
    input.className = 'tl-entity-rename-input';
    input.value = entityId;
    labelEl.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
        const newId = input.value.trim();
        input.remove();
        nameSpan.style.display = '';
        if (actions) actions.style.display = '';
        if (newId && newId !== entityId) {
            renameTrack(entityId, newId);
        }
    };

    const cancel = () => {
        input.remove();
        nameSpan.style.display = '';
        if (actions) actions.style.display = '';
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter')  { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', commit);
}

function renameTrack(oldId, newId) {
    const doc = getCurrentDoc();
    if (!doc || !doc.sequence) return;
    _extraEntities = _extraEntities.map(id => id === oldId ? newId : id);
    renameEntityInSequence(doc.sequence, oldId, newId);
    pushTimelineToYaml();
}

function renameEntityInSequence(seq, oldId, newId) {
    seq.forEach(step => {
        const type = detectStepType(step);
        if (type === 'action') {
            if (step.target?.entity_id === oldId) {
                step.target.entity_id = newId;
            } else if (Array.isArray(step.target?.entity_id)) {
                step.target.entity_id = step.target.entity_id.map(id => id === oldId ? newId : id);
            }
        } else if (type === 'parallel') {
            step.parallel.forEach(b => renameEntityInSequence(Array.isArray(b) ? b : (b.sequence || []), oldId, newId));
        } else if (type === 'repeat') {
            renameEntityInSequence(step.repeat?.sequence || [], oldId, newId);
        } else if (type === 'choose') {
            (step.choose || []).forEach(c => renameEntityInSequence(c.sequence || [], oldId, newId));
        } else if (type === 'if') {
            renameEntityInSequence(step.then || [], oldId, newId);
            renameEntityInSequence(step.else || [], oldId, newId);
        }
    });
}

// ─── Add Entity ───────────────────────────────────────────────────────────────

function promptAddEntity(entityCol, addBtn) {
    addBtn.style.display = 'none';

    const input = document.createElement('input');
    input.className = 'tl-add-entity-input';
    input.placeholder = t('tl_entity_placeholder') || 'light.name';
    input.setAttribute('spellcheck', 'false');
    entityCol.appendChild(input);
    input.focus();

    let accepted = false;

    const cancel = () => {
        if (input.parentNode) input.remove();
        addBtn.style.display = '';
    };

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            accepted = true;
            const id = input.value.trim();
            cancel();
            if (id) confirmAddEntity(id);
        } else if (e.key === 'Escape') {
            cancel();
        }
        e.stopPropagation();
    });

    input.addEventListener('blur', () => {
        if (!accepted) setTimeout(cancel, 120);
    });
}

function confirmAddEntity(id) {
    const entityId = id.includes('.') ? id : 'light.' + id;
    if (!_extraEntities.includes(entityId)) _extraEntities.push(entityId);
    const doc = getCurrentDoc();
    if (doc) syncYamlToTimeline(doc);
}

// ─── YAML Mutations ───────────────────────────────────────────────────────────

function applyBlockEdit(stepRef, changes) {
    if (!stepRef) return;
    stepRef.data = stepRef.data || {};

    if ('rgb_color' in changes) {
        delete stepRef.data.hs_color;
        delete stepRef.data.xy_color;
        stepRef.data.rgb_color = changes.rgb_color;
    }
    if ('brightness_pct' in changes) {
        const v = parseFloat(changes.brightness_pct);
        if (!isNaN(v)) stepRef.data.brightness_pct = v;
        else delete stepRef.data.brightness_pct;
    }
    if ('transition' in changes) {
        const v = parseFloat(changes.transition);
        if (!isNaN(v) && v > 0) stepRef.data.transition = v;
        else delete stepRef.data.transition;
    }
    pushTimelineToYaml();
}

// Adjusts the delay step immediately before the action to shift the block's startMs.
function applyPreDelayEdit(event, newStartMs) {
    const delta = newStartMs - event.startMs;
    if (Math.abs(delta) < 1) return;

    if (event.preDelayRef) {
        const oldMs = parseDelayMs(event.preDelayRef.delay);
        const newSecs = Math.max(0, (oldMs + delta) / 1000);
        if (newSecs > 0) {
            event.preDelayRef.delay = { seconds: parseFloat(newSecs.toFixed(3)) };
        } else {
            const idx = event.preDelayParent?.indexOf(event.preDelayRef);
            if (idx !== undefined && idx >= 0) event.preDelayParent.splice(idx, 1);
        }
    } else if (delta > 0) {
        // No pre-delay exists (block was at t=0). Insert one before the action.
        const aIdx = event.parentArray?.indexOf(event.stepRef);
        if (aIdx !== undefined && aIdx >= 0) {
            event.parentArray.splice(aIdx, 0, { delay: { seconds: parseFloat((delta / 1000).toFixed(3)) } });
        }
    }
    // delta < 0 with no preDelayRef: already at t=0, can't move further left
}

function applyHoldEdit(event, newHoldMs) {
    const secs = parseFloat((newHoldMs / 1000).toFixed(2));
    if (event.delayRef) {
        if (secs > 0) {
            event.delayRef.delay = { seconds: secs };
        } else {
            const dIdx = event.delayParent ? event.delayParent.indexOf(event.delayRef) : -1;
            if (dIdx !== -1) event.delayParent.splice(dIdx, 1);
        }
    } else if (secs > 0) {
        const aIdx = event.parentArray ? event.parentArray.indexOf(event.stepRef) : -1;
        if (aIdx !== -1) event.parentArray.splice(aIdx + 1, 0, { delay: { seconds: secs } });
    }
    pushTimelineToYaml();
}

function deleteStep(event) {
    // Delete delay first (higher index) so action index is unaffected
    if (event.delayRef && event.delayParent) {
        const dIdx = event.delayParent.indexOf(event.delayRef);
        if (dIdx !== -1) event.delayParent.splice(dIdx, 1);
    }
    if (event.parentArray && event.stepRef) {
        const aIdx = event.parentArray.indexOf(event.stepRef);
        if (aIdx !== -1) event.parentArray.splice(aIdx, 1);
    }
    pushTimelineToYaml();
}

function createNewBlock(entityId, startMs, color, brightness, transition) {
    const doc = getCurrentDoc();
    if (!doc) return;
    if (!doc.sequence) doc.sequence = [];

    const actionStep = {
        action: 'light.turn_on',
        target: { entity_id: entityId },
        data: {},
    };
    if (color) actionStep.data.rgb_color = color;
    if (brightness != null && !isNaN(brightness)) actionStep.data.brightness_pct = parseFloat(brightness);
    if (transition > 0) actionStep.data.transition = parseFloat(transition);

    const stepsToInsert = [actionStep];
    if (transition > 0) stepsToInsert.push({ delay: { seconds: parseFloat(parseFloat(transition).toFixed(3)) } });

    appendBlockToBranch(doc.sequence, entityId, startMs, stepsToInsert);
    pushTimelineToYaml();
}

// Appends steps into entityId's branch in the top-level parallel block.
// Inserts a leading gap delay if targetMs > current branch end time.
// Creates a new parallel block (or new branch) if none exists.
function appendBlockToBranch(seq, entityId, targetMs, stepsToInsert) {
    // When loop mode is active, operate on the inner sequence inside the repeat wrapper
    const loopWrapper = _detectLoopWrapper(seq);
    const workSeq = loopWrapper ? (loopWrapper.repeat.sequence || []) : seq;

    // Find (or create) the top-level parallel step
    let parallelStep = workSeq.find(s => detectStepType(s) === 'parallel');
    if (!parallelStep) {
        parallelStep = { parallel: [] };
        workSeq.push(parallelStep);
    }

    // Find entity's branch
    const branchObj = parallelStep.parallel.find(b => {
        const bSeq = Array.isArray(b) ? b : (b.sequence || []);
        return bSeq.some(s => (s.action || s.service) && resolveEntityIds(s).includes(entityId));
    });
    const branchSeq = branchObj
        ? (Array.isArray(branchObj) ? branchObj : branchObj.sequence)
        : null;

    if (branchSeq) {
        // Compute current branch end (sum of all delays = time after last block's transition)
        let branchEndMs = 0;
        for (const s of branchSeq) {
            if (detectStepType(s) === 'delay') branchEndMs += parseDelayMs(s.delay);
        }
        const gapMs = Math.max(0, targetMs - branchEndMs);
        if (gapMs > 0) branchSeq.push({ delay: { seconds: parseFloat((gapMs / 1000).toFixed(3)) } });
        branchSeq.push(...stepsToInsert);
    } else {
        // New branch for this entity
        const newBranch = [];
        if (targetMs > 0) newBranch.push({ delay: { seconds: parseFloat((targetMs / 1000).toFixed(3)) } });
        newBranch.push(...stepsToInsert);
        parallelStep.parallel.push({ sequence: newBranch });
    }
}

function duplicateBlock(sourceEvent, targetEntityId, startMs) {
    const doc = getCurrentDoc();
    if (!doc || !doc.sequence) return;

    const dataCopy = JSON.parse(JSON.stringify(sourceEvent.stepRef?.data || {}));
    const actionStep = {
        action: 'light.turn_on',
        target: { entity_id: targetEntityId },
        data: dataCopy,
    };
    const stepsToInsert = [actionStep];
    if (sourceEvent.durationMs > 0) {
        stepsToInsert.push({ delay: { seconds: parseFloat((sourceEvent.durationMs / 1000).toFixed(3)) } });
    }

    appendBlockToBranch(doc.sequence, targetEntityId, startMs, stepsToInsert);
    pushTimelineToYaml();
}

// Finds the sequence array (mutable) of the branch in parallelBranches that contains entityId.
function findEntityBranch(parallelBranches, entityId) {
    for (const b of parallelBranches) {
        const bSeq = Array.isArray(b) ? b : (b.sequence || []);
        const hasEntity = bSeq.some(s => (s.action || s.service) && resolveEntityIds(s).includes(entityId));
        if (hasEntity) return Array.isArray(b) ? b : b.sequence;
    }
    return null;
}

function insertAtMs(seq, targetMs, stepsToInsert, entityId) {
    let ms = 0;

    for (let i = 0; i < seq.length; i++) {
        const type = detectStepType(seq[i]);

        if (type === 'parallel') {
            if (ms === targetMs) {
                // Exact start of block: add into existing entity branch or new branch
                if (entityId) {
                    const branchSeq = findEntityBranch(seq[i].parallel, entityId);
                    if (branchSeq) { branchSeq.push(...stepsToInsert); return; }
                }
                seq[i].parallel.push({ sequence: [...stepsToInsert] });
                return;
            }
            if (ms > targetMs) {
                seq.splice(i, 0, ...stepsToInsert);
                return;
            }
            const dur = parallelDurationMs(seq[i]);
            if (targetMs < ms + dur) {
                // Click falls WITHIN this parallel block's timespan.
                // Insert into the entity's own branch (appended after its last event).
                if (entityId) {
                    const branchSeq = findEntityBranch(seq[i].parallel, entityId);
                    if (branchSeq) {
                        branchSeq.push(...stepsToInsert);
                    } else {
                        // Entity not yet in this block — add new branch with leading delay
                        const preMs = targetMs - ms;
                        const newBranch = preMs > 0
                            ? [{ delay: { seconds: parseFloat((preMs / 1000).toFixed(3)) } }, ...stepsToInsert]
                            : [...stepsToInsert];
                        seq[i].parallel.push({ sequence: newBranch });
                    }
                    return;
                }
                // No entityId provided — fall through to append after block
            }
            ms += dur;

        } else if (type === 'action') {
            if (ms === targetMs) {
                // Same start time: wrap existing action (+its delay) and new steps in a parallel block
                const hasDelay = i + 1 < seq.length && detectStepType(seq[i + 1]) === 'delay';
                const existingSeq = hasDelay ? [seq[i], seq[i + 1]] : [seq[i]];
                seq.splice(i, hasDelay ? 2 : 1, { parallel: [{ sequence: existingSeq }, { sequence: [...stepsToInsert] }] });
                return;
            }
            // actions don't advance ms

        } else if (type === 'delay') {
            const delayMs = parseDelayMs(seq[i].delay);
            if (ms >= targetMs) {
                seq.splice(i, 0, ...stepsToInsert);
                return;
            }
            const actionStartMs = ms; // ms value at start of this delay step
            ms += delayMs;
            if (ms > targetMs) {
                // Target falls inside this delay.
                // If the previous step is an action (i.e. this is its hold delay),
                // wrap [action, delay] in a parallel block so the new block runs concurrently.
                if (i > 0 && detectStepType(seq[i - 1]) === 'action') {
                    const preMs = targetMs - actionStartMs;
                    const existingSeq = [seq[i - 1], seq[i]];
                    const newBranchSeq = preMs > 0
                        ? [{ delay: { seconds: parseFloat((preMs / 1000).toFixed(3)) } }, ...stepsToInsert]
                        : [...stepsToInsert];
                    seq.splice(i - 1, 2, { parallel: [{ sequence: existingSeq }, { sequence: newBranchSeq }] });
                } else {
                    // Gap delay (no preceding action) → insert after it
                    seq.splice(i + 1, 0, ...stepsToInsert);
                }
                return;
            }
        }
    }

    // Append at end
    seq.push(...stepsToInsert);
}

// Returns the effective ms position where a block for entityId would land.
// In the always-parallel model: new blocks append to the entity's branch end,
// or at targetMs if targetMs is past the branch end.
function resolveInsertMs(seq, targetMs, entityId) {
    const loopWrapper = _detectLoopWrapper(seq);
    const workSeq = loopWrapper ? (loopWrapper.repeat.sequence || []) : seq;
    for (const step of workSeq) {
        if (detectStepType(step) === 'parallel') {
            const branchSeq = findEntityBranch(step.parallel, entityId);
            if (branchSeq) {
                let branchEndMs = 0;
                for (const s of branchSeq) {
                    if (detectStepType(s) === 'delay') branchEndMs += parseDelayMs(s.delay);
                }
                return Math.max(targetMs, branchEndMs);
            }
            return targetMs; // entity not yet in any branch
        }
    }
    return targetMs; // no parallel block yet
}

function parallelDurationMs(step) {
    const branches = Array.isArray(step.parallel) ? step.parallel : [];
    return branches.reduce((max, b) => {
        const bSeq = Array.isArray(b) ? b : (b.sequence || []);
        const dur = bSeq.reduce((acc, s) => detectStepType(s) === 'delay' ? acc + parseDelayMs(s.delay) : acc, 0);
        return Math.max(max, dur);
    }, 0);
}

function pushTimelineToYaml() {
    if (!_cmEditor) return;
    const doc = getCurrentDoc();
    if (!doc) return;

    normalizeParallel(doc);

    const ordered = {};
    ordered.alias    = doc.alias    ?? 'My Script';
    ordered.mode     = doc.mode     ?? 'single';
    if ('icon'      in doc) ordered.icon      = doc.icon;
    if ('variables' in doc) ordered.variables = doc.variables;
    Object.keys(doc).forEach(k => {
        if (!['alias', 'mode', 'icon', 'variables', 'sequence'].includes(k)) ordered[k] = doc[k];
    });
    ordered.sequence = doc.sequence || [];

    _cmEditor.setValue(jsyaml.dump(ordered, { lineWidth: 120, noRefs: true }));
}

// ─── Parallel Normalization ────────────────────────────────────────────────────

// Detects the timeline-managed repeat wrapper:
//   [ { repeat: { count|while: X, sequence: [{ parallel: [...] }] } } ]
// Returns the repeat step or null.
function _detectLoopWrapper(seq) {
    if (!Array.isArray(seq) || seq.length !== 1) return null;
    const step = seq[0];
    if (detectStepType(step) !== 'repeat') return null;
    const inner = step.repeat?.sequence || [];
    if (inner.length !== 1 || detectStepType(inner[0]) !== 'parallel') return null;
    return step;
}

function normalizeParallel(doc) {
    const seq = doc.sequence || [];

    // If there's a timeline-managed loop wrapper, work on the inner sequence.
    const loopWrapper = _detectLoopWrapper(seq);
    const workSeq = loopWrapper ? (loopWrapper.repeat.sequence || []) : seq;

    const hasComplex = workSeq.some(s => {
        const t = detectStepType(s);
        return t === 'repeat' || t === 'choose' || t === 'if';
    });
    if (hasComplex) return;

    // Compile the inner sequence (via temporary doc so repeat group isn't set)
    const tempDoc = { sequence: workSeq };
    const { events } = compileTimeline(tempDoc);
    if (events.length === 0) return;
    const normalEvents = events.filter(ev => !ev.repeatGroup && !ev.hasCondition);
    if (normalEvents.length === 0) return;

    const newParallel = rebuildAsAlwaysParallel(normalEvents);

    if (loopWrapper) {
        loopWrapper.repeat.sequence = newParallel;
    } else {
        doc.sequence = newParallel;
    }
}

// ─── Loop Mode ────────────────────────────────────────────────────────────────

function _setLoopMode(enabled, count, infinite) {
    const doc = getCurrentDoc();
    if (!doc) return;
    const loopWrapper = _detectLoopWrapper(doc.sequence || []);
    if (enabled) {
        const innerSeq = loopWrapper ? (loopWrapper.repeat.sequence || []) : (doc.sequence || []).slice();
        const repeatDef = infinite ? { while: true } : { count: Math.max(2, count || 2) };
        repeatDef.sequence = innerSeq;
        doc.sequence = [{ repeat: repeatDef }];
    } else if (loopWrapper) {
        doc.sequence = loopWrapper.repeat.sequence || [];
    }
    pushTimelineToYaml();
}

function _updateLoopBtnLabel() {
    const btn      = document.getElementById('tl-loop-btn');
    const minusBtn = document.getElementById('tl-loop-minus');
    const countIn  = document.getElementById('tl-loop-count');
    const plusBtn  = document.getElementById('tl-loop-plus');
    const infBtn   = document.getElementById('tl-loop-inf');
    if (!btn) return;
    const wrapper = _detectLoopWrapper(getCurrentDoc()?.sequence || []);
    if (wrapper) {
        const isInf = wrapper.repeat.while === true;
        btn.classList.add('active');
        btn.title = 'Loop an — klicken zum Deaktivieren';
        if (countIn) { countIn.value = wrapper.repeat.count ?? 2; }
        const countDisabled = isInf;
        if (minusBtn) minusBtn.disabled = countDisabled;
        if (countIn)  countIn.disabled  = countDisabled;
        if (plusBtn)  plusBtn.disabled  = countDisabled;
        if (infBtn)   { infBtn.disabled = false; infBtn.classList.toggle('active', isInf); }
    } else {
        btn.classList.remove('active');
        btn.title = 'Loop aktivieren';
        if (minusBtn) minusBtn.disabled = true;
        if (countIn)  { countIn.disabled = true; countIn.value = 2; }
        if (plusBtn)  plusBtn.disabled  = true;
        if (infBtn)   { infBtn.disabled = true; infBtn.classList.remove('active'); }
    }
}

function setupLoopButton() {
    const btn      = document.getElementById('tl-loop-btn');
    const minusBtn = document.getElementById('tl-loop-minus');
    const countIn  = document.getElementById('tl-loop-count');
    const plusBtn  = document.getElementById('tl-loop-plus');
    const infBtn   = document.getElementById('tl-loop-inf');
    if (!btn) return;

    const getCount = () => Math.max(2, parseInt(countIn?.value) || 2);

    btn.addEventListener('click', () => {
        const isActive = !!_detectLoopWrapper(getCurrentDoc()?.sequence || []);
        _setLoopMode(!isActive, getCount(), false);
        _updateLoopBtnLabel();
    });

    minusBtn?.addEventListener('click', () => {
        if (!_detectLoopWrapper(getCurrentDoc()?.sequence || [])) return;
        const next = Math.max(2, getCount() - 1);
        if (countIn) countIn.value = next;
        _setLoopMode(true, next, false);
        _updateLoopBtnLabel();
    });

    plusBtn?.addEventListener('click', () => {
        if (!_detectLoopWrapper(getCurrentDoc()?.sequence || [])) return;
        const next = Math.min(999, getCount() + 1);
        if (countIn) countIn.value = next;
        _setLoopMode(true, next, false);
        _updateLoopBtnLabel();
    });

    countIn?.addEventListener('change', () => {
        if (_detectLoopWrapper(getCurrentDoc()?.sequence || [])) {
            _setLoopMode(true, getCount(), false);
            _updateLoopBtnLabel();
        }
    });

    infBtn?.addEventListener('click', () => {
        const wrapper = _detectLoopWrapper(getCurrentDoc()?.sequence || []);
        if (!wrapper) return;
        const isInf = wrapper.repeat.while === true;
        _setLoopMode(true, getCount(), !isInf);
        _updateLoopBtnLabel();
    });
}

// Rebuilds sequence as always-parallel: one branch per entity, all in a single parallel block.
// Block width = transition (durationMs). Gap delays separate from transition delays.
function rebuildAsAlwaysParallel(events) {
    if (events.length === 0) return [];

    // Group by entity, sort by startMs
    const byEntity = {};
    for (const ev of events) {
        (byEntity[ev.entityId] ??= []).push(ev);
    }
    for (const arr of Object.values(byEntity)) arr.sort((a, b) => a.startMs - b.startMs);

    // Build one branch per entity
    const branches = Object.entries(byEntity).map(([, evs]) => {
        const seq = [];
        let branchMs = 0;

        for (const ev of evs) {
            // Gap delay before this block (if any)
            if (ev.startMs > branchMs) {
                seq.push({ delay: { seconds: parseFloat(((ev.startMs - branchMs) / 1000).toFixed(3)) } });
            }
            seq.push(eventToActionStep(ev));
            // Transition delay (always = durationMs, so HA clock advances correctly)
            if (ev.durationMs > 0) {
                seq.push({ delay: { seconds: parseFloat((ev.durationMs / 1000).toFixed(3)) } });
            }
            branchMs = ev.startMs + (ev.durationMs || 0);
        }

        return { sequence: seq };
    });

    return [{ parallel: branches }];
}

function eventToActionStep(event) {
    const data = JSON.parse(JSON.stringify(event.stepRef?.data || {}));
    if (!event.isOff) {
        if (event.durationMs > 0) {
            data.transition = parseFloat((event.durationMs / 1000).toFixed(3));
        } else {
            delete data.transition;
        }
    } else {
        delete data.transition;
    }
    return {
        action: event.isOff ? 'light.turn_off' : 'light.turn_on',
        target: { entity_id: event.entityId },
        data,
    };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function detectStepType(step) {
    if (!step || typeof step !== 'object') return 'unknown';
    if (step.action || step.service) return 'action';
    if ('delay' in step)  return 'delay';
    if (step.parallel)    return 'parallel';
    if (step.repeat)      return 'repeat';
    if (step.choose)      return 'choose';
    if ('if' in step)     return 'if';
    if (step.variables)   return 'variables';
    return 'unknown';
}

function resolveEntityIds(step) {
    const raw = step.target?.entity_id ?? step.entity_id ?? [];
    const arr = Array.isArray(raw) ? raw : [raw];
    const result = [];
    arr.forEach(id => {
        if (typeof id !== 'string') return;
        id.split(',').forEach(part => {
            const cleaned = part.trim();
            if (cleaned && !cleaned.includes('{{')) {
                result.push(cleaned.includes('.') ? cleaned : 'light.' + cleaned);
            }
        });
    });
    return result;
}

function parseDelayMs(delay) {
    let ms = 0;
    if (typeof delay === 'object' && delay !== null) {
        if (delay.hours)        ms += (parseFloat(delay.hours)        || 0) * 3600000;
        if (delay.minutes)      ms += (parseFloat(delay.minutes)      || 0) * 60000;
        if (delay.seconds)      ms += (parseFloat(delay.seconds)      || 0) * 1000;
        if (delay.milliseconds) ms += (parseFloat(delay.milliseconds) || 0);
    } else {
        const raw = String(delay);
        if (raw.includes('{{')) return 0;
        if (raw.includes(':')) {
            const parts = raw.split(':').map(Number);
            if (parts.length === 3) ms = (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
        } else {
            ms = Math.max(0, parseFloat(raw) || 0) * 1000;
        }
    }
    return isNaN(ms) ? 0 : ms;
}

function extractRgb(data) {
    if (Array.isArray(data.rgb_color) && data.rgb_color.length >= 3)
        return [data.rgb_color[0], data.rgb_color[1], data.rgb_color[2]];
    if (Array.isArray(data.hs_color))  return hsToRgb(data.hs_color);
    if (Array.isArray(data.xy_color))  return xyToRgb(data.xy_color);
    return [200, 200, 200];
}

function extractBrightness(data) {
    if (data.brightness_pct !== undefined) return parseFloat(data.brightness_pct);
    if (data.brightness     !== undefined) return Math.round(parseFloat(data.brightness) / 255 * 100);
    return 100;
}

function hasTemplateIn(...vals) {
    return vals.some(v => typeof v === 'string' && v.includes('{{'));
}

function buildBlockLabel(event) {
    if (event.isOff) return 'off';
    return event.brightness != null ? `${Math.round(event.brightness)}%` : '';
}

function tickIntervalGcd(a, b) { return b === 0 ? a : tickIntervalGcd(b, a % b); }

function calculateTickInterval(scale) {
    const pps = scale * 1000; // px per second
    if (pps < 5)   return { major: 30000, minor: 10000, medium: 0 };
    if (pps < 10)  return { major: 10000, minor:  5000, medium: 0 };
    if (pps < 20)  return { major:  5000, minor:  1000, medium: 0 };
    if (pps < 50)  return { major:  2000, minor:   500, medium: 0 };
    if (pps < 100) return { major:  1000, minor:   500, medium: 0 };
    if (pps < 200) return { major:  1000, minor:   200, medium: 500 };
    return { major: 500, minor: 100, medium: 0 };
}

function snapMs(ms) {
    const { minor, medium } = calculateTickInterval(_scale);
    if (medium <= 0) return Math.max(0, Math.round(ms / minor) * minor);
    const a = Math.round(ms / minor) * minor;
    const b = Math.round(ms / medium) * medium;
    return Math.max(0, Math.abs(ms - a) <= Math.abs(ms - b) ? a : b);
}

function formatTime(ms) {
    if (ms === 0) return '0s';
    if (ms >= 60000) {
        const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
        return s > 0 ? `${m}m${s}s` : `${m}m`;
    }
    if (ms % 1000 === 0) return `${ms / 1000}s`;
    return `${(ms / 1000).toFixed(1)}s`;
}

function hsToRgb(hs) {
    let h = hs[0] / 360, s = hs[1] / 100, v = 1.0;
    let r, g, b;
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = v*(1-s), q = v*(1-f*s), t2 = v*(1-(1-f)*s);
    switch (i % 6) {
        case 0: r=v; g=t2; b=p;  break; case 1: r=q;  g=v;  b=p;  break;
        case 2: r=p; g=v;  b=t2; break; case 3: r=p;  g=q;  b=v;  break;
        case 4: r=t2;g=p;  b=v;  break; default: r=v;  g=p;  b=q;  break;
    }
    return [Math.round(r*255), Math.round(g*255), Math.round(b*255)];
}

function xyToRgb(xy) {
    const x = xy[0], y = xy[1], z = 1.0-x-y, Y = 1.0;
    const X = (Y/y)*x, Z = (Y/y)*z;
    let r = X*3.2406 - Y*1.5372 - Z*0.4986;
    let g = -X*0.9689 + Y*1.8758 + Z*0.0415;
    let b = X*0.0557  - Y*0.2040 + Z*1.0570;
    const mx = Math.max(r, g, b);
    if (mx > 1) { r/=mx; g/=mx; b/=mx; }
    const gc = v => v <= 0.0031308 ? 12.92*v : 1.055*Math.pow(v,1/2.4)-0.055;
    return [
        Math.max(0,Math.min(255,Math.round(gc(r)*255))),
        Math.max(0,Math.min(255,Math.round(gc(g)*255))),
        Math.max(0,Math.min(255,Math.round(gc(b)*255))),
    ];
}

function rgbToHex(rgb) {
    if (!Array.isArray(rgb) || rgb.length < 3) return '#ffffff';
    return '#' + rgb.map(x => Math.round(Math.max(0,Math.min(255,x))).toString(16).padStart(2,'0')).join('');
}

function hexToRgb(hex) {
    return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}
