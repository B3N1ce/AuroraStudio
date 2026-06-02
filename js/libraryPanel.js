// js/libraryPanel.js
// Skript-Bibliothek: Slots zum Speichern und Laden eigener Animationen.

import { compileTimeline, _detectLoopWrapper } from './timelineEditor.js';
import { resolveTemplate } from './templateEngine.js';
import { t } from './i18n.js';

const LS_KEY = 'ha_library_slots';

const SCRATCH_YAML = [
    'alias: New Animation',
    'description: "Clean slate"',
    'mode: single',
    'sequence: []',
].join('\n');

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let _slots = [];
let _activeSlotId = null;

let _deps = null;   // { getEditorValue, setEditorValue, validateAndSync, isPlaying }
let _container = null;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function loadSlots() {
    try { _slots = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); }
    catch { _slots = []; }
}

function saveSlots() {
    localStorage.setItem(LS_KEY, JSON.stringify(_slots));
}

// ---------------------------------------------------------------------------
// Metadata + mini timeline
// ---------------------------------------------------------------------------

function rgbToHex([r, g, b]) {
    return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
}


// Resolve a sequence in-place with a per-branch variable scope.
// Each parallel branch gets its own COPY of the current scope so variable
// assignments in one branch don't bleed into sibling branches.
function resolveSeqWithScope(steps, parentVars) {
    const cloned = JSON.parse(JSON.stringify(steps));
    const vars = Object.assign({}, parentVars);

    for (const step of cloned) {
        if (!step || typeof step !== 'object') continue;

        // variables: step — resolve values into the local scope
        if (step.variables) {
            for (const [k, v] of Object.entries(step.variables)) {
                try { vars[k] = resolveTemplate(v, vars); step.variables[k] = vars[k]; } catch {}
            }
        }

        // action data / delay — resolve with current scope
        if (step.data)  try { step.data  = resolveTemplate(step.data,  vars); } catch {}
        if (step.delay !== undefined) try { step.delay = resolveTemplate(step.delay, vars); } catch {}

        // parallel — each branch gets an independent copy of the current scope
        if (step.parallel) {
            step.parallel = (Array.isArray(step.parallel) ? step.parallel : []).map(b => {
                if (Array.isArray(b))  return resolveSeqWithScope(b, vars);
                if (b.sequence)        return { ...b, sequence: resolveSeqWithScope(b.sequence, vars) };
                // bare step (e.g. { repeat: {...} }) — wrap, resolve, unwrap
                return resolveSeqWithScope([b], vars)[0] ?? b;
            });
        }

        if (Array.isArray(step.sequence)) step.sequence = resolveSeqWithScope(step.sequence, vars);

        if (step.repeat?.sequence) {
            step.repeat = { ...step.repeat, sequence: resolveSeqWithScope(step.repeat.sequence, vars) };
            try { if (step.repeat.count !== undefined) step.repeat.count = resolveTemplate(step.repeat.count, vars); } catch {}
        }

        if (Array.isArray(step.choose)) {
            step.choose = step.choose.map(c => ({
                ...c,
                ...(c.sequence && { sequence: resolveSeqWithScope(c.sequence, vars) }),
                ...(c.default  && { default:  resolveSeqWithScope(c.default,  vars) }),
            }));
        }
    }
    return cloned;
}

function buildSnapshot(yaml) {
    let doc;
    try { doc = jsyaml.load(yaml); } catch { return null; }

    // Resolve each parallel branch with its own variable scope
    const topVars = Object.assign({}, doc.variables || {});
    let resolvedSeq;
    try { resolvedSeq = resolveSeqWithScope(doc.sequence || [], topVars); }
    catch { resolvedSeq = doc.sequence || []; }

    const resolvedDoc = { ...doc, sequence: resolvedSeq };

    let events, totalMs;
    try { ({ events, totalMs } = compileTimeline(resolvedDoc)); } catch { return null; }

    const loopWrapper = _detectLoopWrapper(doc.sequence || []);
    const entityIds = new Set(events.map(e => e.entityId).filter(Boolean));

    return {
        totalMs,
        loop: loopWrapper ? (loopWrapper.repeat.while ? '∞' : `${loopWrapper.repeat.count}×`) : null,
        entityCount: entityIds.size,
        hasVars: !!(doc.variables && Object.keys(doc.variables).length),
        hasJinja: yaml.includes('{{') && yaml.includes('}}'),
        events,
    };
}

function renderMiniTimeline(canvas, yaml) {
    const W = canvas.offsetWidth || 260;
    const meta = buildSnapshot(yaml);

    if (!meta || meta.events.length === 0 || meta.totalMs === 0) {
        canvas.width  = W;
        canvas.height = 8;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#2a2a2a';
        ctx.fillRect(0, 0, W, 8);
        return;
    }

    // Group events by entity (stable insertion order)
    const byEntity = new Map();
    for (const ev of meta.events) {
        if (!ev.entityId) continue;
        if (!byEntity.has(ev.entityId)) byEntity.set(ev.entityId, []);
        byEntity.get(ev.entityId).push(ev);
    }

    const entityList = [...byEntity.keys()];
    const TRACK_H = 10;
    const GAP = 2;
    const H = entityList.length * TRACK_H + (entityList.length - 1) * GAP;

    canvas.width  = W;
    canvas.height = Math.max(H, 8);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, canvas.height);

    entityList.forEach((entityId, row) => {
        const y = row * (TRACK_H + GAP);
        // Gray track background
        ctx.fillStyle = '#2a2a2a';
        ctx.fillRect(0, y, W, TRACK_H);

        for (const ev of byEntity.get(entityId)) {
            if (ev.isOff || !ev.color) continue;
            const x      = (ev.startMs / meta.totalMs) * W;
            const transW = Math.max(2, (ev.durationMs / meta.totalMs) * W);
            const totalW = Math.max(transW, ((ev.durationMs + (ev.holdMs || 0)) / meta.totalMs) * W);

            // Transition gradient over the transition portion, then solid hold
            if (ev.prevColor && ev.prevColor !== ev.color) {
                const grad = ctx.createLinearGradient(x, 0, x + transW, 0);
                grad.addColorStop(0, rgbToHex(ev.prevColor));
                grad.addColorStop(1, rgbToHex(ev.color));
                ctx.fillStyle = grad;
                ctx.fillRect(x, y, transW, TRACK_H);
                ctx.fillStyle = rgbToHex(ev.color);
                ctx.fillRect(x + transW, y, totalW - transW, TRACK_H);
            } else {
                ctx.fillStyle = rgbToHex(ev.color);
                ctx.fillRect(x, y, totalW, TRACK_H);
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Card builders
// ---------------------------------------------------------------------------

function el(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
}

function makeIconBtn(title, svgInner, onClick) {
    const btn = el('button', 'lib-icon-btn');
    btn.title = title;
    btn.innerHTML = svgInner;
    btn.addEventListener('click', onClick);
    return btn;
}

const ICON_EDIT   = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M12.85 1.15a1.5 1.5 0 0 1 0 2.12L5 11.12 2 12l.88-3L10.73 1.15a1.5 1.5 0 0 1 2.12 0z"/></svg>';
const ICON_DELETE = '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M6 2h4v1H6V2zM3 4h10v1H3V4zm1 2h8l-.8 8H4.8L4 6zm2 2v4h1V8H6zm3 0v4h1V8H9z"/></svg>';

function buildSlotCard(slot) {
    const card = el('div', 'lib-slot-card');
    if (slot.id === _activeSlotId) card.classList.add('lib-slot-active');

    // Header
    const header = el('div', 'lib-slot-header');
    const nameEl = el('span', 'lib-slot-name');
    nameEl.textContent = slot.name || t('lib_unnamed');
    header.appendChild(nameEl);

    const btnRow = el('div', 'lib-slot-icon-btns');
    btnRow.appendChild(makeIconBtn(t('lib_rename'), ICON_EDIT, () => openEditModal(slot)));
    btnRow.appendChild(makeIconBtn(t('lib_delete'), ICON_DELETE, () => deleteSlot(slot.id)));
    header.appendChild(btnRow);
    card.appendChild(header);

    // Description
    if (slot.description) {
        const desc = el('p', 'lib-slot-desc');
        desc.textContent = slot.description;
        card.appendChild(desc);
    }

    // Mini timeline canvas
    const canvas = el('canvas', 'lib-mini-timeline');
    canvas.height = 8;
    card.appendChild(canvas);
    // Render after layout (needs offsetWidth); also re-render when tab becomes visible
    requestAnimationFrame(() => renderMiniTimeline(canvas, slot.yaml));
    canvas.addEventListener('lib-redraw', () => renderMiniTimeline(canvas, slot.yaml));

    // Meta chips
    const meta = buildSnapshot(slot.yaml);
    if (meta) {
        const chips = el('div', 'lib-meta-row');
        const dur = meta.totalMs > 0
            ? (meta.totalMs >= 1000 ? `${(meta.totalMs / 1000).toFixed(1)}s` : `${meta.totalMs}ms`)
            : null;
        if (dur) chips.appendChild(makeChip('⏱ ' + dur));
        if (meta.loop) chips.appendChild(makeChip('↺ ' + meta.loop));
        if (meta.entityCount > 0) chips.appendChild(makeChip('💡 ' + meta.entityCount));
        if (meta.hasVars) chips.appendChild(makeChip('{x}'));
        if (meta.hasJinja) chips.appendChild(makeChip('{{ }}'));
        if (chips.children.length) card.appendChild(chips);
    }

    // Action buttons
    const actions = el('div', 'lib-actions');
    const loadBtn = el('button', 'lib-btn lib-btn-primary');
    loadBtn.textContent = t('lib_load');
    loadBtn.addEventListener('click', () => loadSlot(slot));
    const saveBtn = el('button', 'lib-btn');
    saveBtn.textContent = t('lib_overwrite');
    saveBtn.addEventListener('click', () => saveToSlot(slot.id));
    actions.appendChild(loadBtn);
    actions.appendChild(saveBtn);
    card.appendChild(actions);

    return card;
}

function makeChip(text) {
    const c = el('span', 'lib-meta-chip');
    c.textContent = text;
    return c;
}

function buildEmptyCard() {
    const card = el('div', 'lib-slot-card lib-slot-empty');

    const title = el('span', 'lib-slot-name');
    title.textContent = t('lib_empty_slot');
    card.appendChild(title);

    const desc = el('p', 'lib-slot-desc');
    desc.textContent = t('lib_empty_desc');
    card.appendChild(desc);

    const actions = el('div', 'lib-actions');
    const loadBtn = el('button', 'lib-btn');
    loadBtn.textContent = t('lib_load_scratch');
    loadBtn.addEventListener('click', loadEmpty);
    const saveBtn = el('button', 'lib-btn lib-btn-primary');
    saveBtn.textContent = t('lib_save_here');
    saveBtn.addEventListener('click', saveToNewSlot);
    actions.appendChild(loadBtn);
    actions.appendChild(saveBtn);
    card.appendChild(actions);

    return card;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderLibrary() {
    if (!_container) return;
    _container.innerHTML = '';

    const sorted = [..._slots].sort((a, b) => b.savedAt - a.savedAt);
    for (const slot of sorted) {
        _container.appendChild(buildSlotCard(slot));
    }
    _container.appendChild(buildEmptyCard());
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function loadSlot(slot) {
    if (_deps.isPlaying()) return;
    window.showConfirmModal?.({
        title: t('confirm_load_title'),
        message: t('confirm_load_msg'),
        confirmLabel: t('lib_load'),
        onConfirm: () => {
            _deps.setEditorValue(slot.yaml);
            _deps.validateAndSync();
            _activeSlotId = slot.id;
            renderLibrary();
        }
    });
}

function loadEmpty() {
    if (_deps.isPlaying()) return;
    window.showConfirmModal?.({
        title: t('confirm_load_title'),
        message: t('confirm_load_msg'),
        confirmLabel: t('lib_load'),
        onConfirm: () => {
            _deps.setEditorValue(SCRATCH_YAML);
            _deps.validateAndSync();
            _activeSlotId = null;
            renderLibrary();
        }
    });
}

function saveToSlot(slotId) {
    const slot = _slots.find(s => s.id === slotId);
    if (!slot) return;
    window.showConfirmModal?.({
        title: t('lib_overwrite'),
        message: t('confirm_overwrite_slot_msg'),
        confirmLabel: t('lib_overwrite'),
        onConfirm: () => {
            const yaml = _deps.getEditorValue();
            let doc;
            try { doc = jsyaml.load(yaml); } catch { window.showToast?.(t('lib_invalid_yaml'), 'error'); return; }
            slot.yaml = yaml;
            slot.name = doc?.alias || slot.name;
            slot.description = doc?.description || slot.description;
            slot.savedAt = Date.now();
            saveSlots();
            _activeSlotId = slot.id;
            renderLibrary();
            window.showToast?.(t('lib_saved'), 'success');
        }
    });
}

function saveToNewSlot() {
    const yaml = _deps.getEditorValue();
    let doc;
    try { doc = jsyaml.load(yaml); } catch { window.showToast?.(t('lib_invalid_yaml'), 'error'); return; }
    const slot = {
        id: String(Date.now()),
        name: doc?.alias || t('lib_unnamed_script'),
        description: doc?.description || '',
        yaml,
        savedAt: Date.now(),
    };
    _slots.unshift(slot);
    saveSlots();
    _activeSlotId = slot.id;
    renderLibrary();
    window.showToast?.(t('lib_saved'), 'success');
}

function deleteSlot(slotId) {
    const slot = _slots.find(s => s.id === slotId);
    window.showConfirmModal?.({
        title: t('confirm_delete_slot_title'),
        message: t('confirm_delete_slot_msg'),
        confirmLabel: t('lib_delete'),
        danger: true,
        onConfirm: () => {
            _slots = _slots.filter(s => s.id !== slotId);
            if (_activeSlotId === slotId) _activeSlotId = null;
            saveSlots();
            renderLibrary();
        }
    });
}

// ---------------------------------------------------------------------------
// Edit modal
// ---------------------------------------------------------------------------

function openEditModal(slot) {
    const overlay = el('div', 'modal-overlay');
    const modal   = el('div', 'modal-content');
    modal.style.maxWidth = '420px';

    const header = el('div', 'modal-header');
    const htitle = el('span');
    htitle.textContent = t('lib_edit_slot');
    header.appendChild(htitle);
    const closeBtn = el('button', 'modal-close-btn');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => overlay.remove());
    header.appendChild(closeBtn);

    const body = el('div', 'modal-body');
    body.style.gap = '10px';

    const nameLabel = el('label');
    nameLabel.textContent = t('lib_name');
    nameLabel.style.cssText = 'font-size:12px;color:#aaa;display:block;margin-bottom:3px;';
    const nameInput = el('input', 'node-input');
    nameInput.value = slot.name || '';
    nameInput.style.width = '100%';

    const descLabel = el('label');
    descLabel.textContent = t('lib_description');
    descLabel.style.cssText = 'font-size:12px;color:#aaa;display:block;margin-bottom:3px;margin-top:8px;';
    const descInput = el('textarea', 'node-input');
    descInput.value = slot.description || '';
    descInput.style.cssText = 'width:100%;height:60px;resize:vertical;';

    body.appendChild(nameLabel);
    body.appendChild(nameInput);
    body.appendChild(descLabel);
    body.appendChild(descInput);

    const footer = el('div', 'modal-footer');
    const cancelBtn = el('button', 'btn-modal-cancel');
    cancelBtn.textContent = t('cancel');
    cancelBtn.addEventListener('click', () => overlay.remove());
    const saveBtn = el('button', 'btn-modal-save');
    saveBtn.textContent = t('lib_save');
    saveBtn.addEventListener('click', () => {
        const newName = nameInput.value.trim() || slot.name;
        const newDesc = descInput.value.trim();

        // Update in-memory slot
        slot.name = newName;
        slot.description = newDesc;

        // Sync alias + description into the slot's stored YAML
        try {
            const doc = jsyaml.load(slot.yaml) || {};
            doc.alias       = newName;
            doc.description = newDesc;
            // Preserve field order: alias first, then description, then rest
            const ordered = {};
            ordered.alias       = doc.alias;
            ordered.description = doc.description;
            for (const k of Object.keys(doc)) {
                if (k !== 'alias' && k !== 'description') ordered[k] = doc[k];
            }
            slot.yaml = jsyaml.dump(ordered, { lineWidth: 120, noRefs: true });
        } catch { /* keep existing yaml if parse fails */ }

        saveSlots();
        renderLibrary();
        overlay.remove();
    });
    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    nameInput.focus();
    nameInput.select();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initLibraryPanel({ getEditorValue, setEditorValue, validateAndSync, isPlaying }) {
    _deps = { getEditorValue, setEditorValue, validateAndSync, isPlaying };
    _container = document.getElementById('library-grid');
    if (!_container) return;
    loadSlots();
    renderLibrary();
}
