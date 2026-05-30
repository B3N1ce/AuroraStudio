import { breakpoints, toggleBreakpoint } from './simulator.js';
import { initEntityManager, updateLampEntities, resetLamps, hasModifiedLamps, setColorCurve, getAvailableEntities } from './entityManager.js';
import { t } from './i18n.js';
import { resolveTemplate } from './templateEngine.js';

let _editor = null;
let _isSyncing = false;
let _currentDoc = null; // live JS object (source of truth for nodes→YAML)
let _lastFocusedElement = null;
let _currentRuntimeVars = {};

// Pan/Zoom state
let panX = 0, panY = 0, zoom = 1.0;
let isPanning = false, panLastX = 0, panLastY = 0;
const ZOOM_MIN = 0.2, ZOOM_MAX = 2.5;

export function updateRuntimeVariablesUI(vars) {
    _currentRuntimeVars = { ...vars };
    for (const [key, val] of Object.entries(vars)) {
        const el = document.getElementById(`runtime-var-${key}`);
        if (el) {
            el.textContent = typeof val === 'object' ? JSON.stringify(val).substring(0, 30) : String(val).substring(0, 30);
        }
    }
}

export function resetRuntimeVariablesUI() {
    _currentRuntimeVars = {};
    const els = document.querySelectorAll('[id^="runtime-var-"]');
    els.forEach(el => el.textContent = '-');
    highlightExecutingNode(null);
}

const ICONS = {
    script: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l9 4.9V17L12 22l-9-4.9V7z"/></svg>`,
    action: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`,
    delay: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    parallel: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="9" y1="2" x2="9" y2="22"/><line x1="15" y1="2" x2="15" y2="22"/></svg>`,
    repeat: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`,
    choose: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>`,
    if: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5l-4-4H4"/><path d="M12 17l4-4h4"/><circle cx="12" cy="3" r="1"/></svg>`,
    wait: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M5 2h14"/><path d="M5 22h14"/><path d="M6 2v6.7c0 .8.4 1.5 1 2.1l4 3.2-4 3.2c-.6.6-1 1.3-1 2.1V22"/><path d="M18 2v6.7c0 .8-.4 1.5-1 2.1l-4 3.2 4 3.2c.6.6 1 1.3 1 2.1V22"/></svg>`,
    variables: `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>`
};

export function initNodeEditor(cmEditor) {
    _editor = cmEditor;

    // Global focus tracking for variable insertion
    document.addEventListener('focusin', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.classList.contains('CodeMirror-code')) {
            _lastFocusedElement = e.target;
        }
    });

    initPanZoom();
}

function initPanZoom() {
    const container = document.getElementById('node-container');
    if (!container) return;

    // Zoom via scroll wheel (zoom-to-cursor)
    container.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = container.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.1 : 0.9;
        const cx = (mx - panX) / zoom;
        const cy = (my - panY) / zoom;
        zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * factor));
        panX = mx - cx * zoom;
        panY = my - cy * zoom;
        applyTransform();
    }, { passive: false });

    // Pan via middle mouse button
    container.addEventListener('mousedown', (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        isPanning = true;
        panLastX = e.clientX;
        panLastY = e.clientY;
        container.classList.add('panning');
    });
    window.addEventListener('mousemove', (e) => {
        if (!isPanning) return;
        panX += e.clientX - panLastX;
        panY += e.clientY - panLastY;
        panLastX = e.clientX;
        panLastY = e.clientY;
        applyTransform();
    });
    window.addEventListener('mouseup', (e) => {
        if (e.button !== 1) return;
        isPanning = false;
        container.classList.remove('panning');
    });

    // Touch: 2-finger pinch-zoom + pan
    let _td = 0, _tmx = 0, _tmy = 0;
    container.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 2) return;
        e.preventDefault();
        const rect = container.getBoundingClientRect();
        const [t0, t1] = e.touches;
        _td  = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        _tmx = (t0.clientX + t1.clientX) / 2 - rect.left;
        _tmy = (t0.clientY + t1.clientY) / 2 - rect.top;
    }, { passive: false });
    container.addEventListener('touchmove', (e) => {
        if (e.touches.length !== 2) return;
        e.preventDefault();
        const rect = container.getBoundingClientRect();
        const [t0, t1] = e.touches;
        const nd  = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        const nmx = (t0.clientX + t1.clientX) / 2 - rect.left;
        const nmy = (t0.clientY + t1.clientY) / 2 - rect.top;
        const factor = nd / _td;
        const cx = (_tmx - panX) / zoom;
        const cy = (_tmy - panY) / zoom;
        zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * factor));
        panX = _tmx - cx * zoom + (nmx - _tmx);
        panY = _tmy - cy * zoom + (nmy - _tmy);
        _td = nd; _tmx = nmx; _tmy = nmy;
        applyTransform();
    }, { passive: false });
    container.addEventListener('touchend', () => { _td = 0; });

    // Double-click on empty area → reset view
    container.addEventListener('dblclick', (e) => {
        if (e.target === container || e.target.id === 'node-canvas') resetView();
    });

    // Zoom toolbar buttons
    document.getElementById('node-zoom-in')?.addEventListener('click', () => {
        zoom = Math.min(ZOOM_MAX, zoom + 0.1);
        applyTransform();
    });
    document.getElementById('node-zoom-out')?.addEventListener('click', () => {
        zoom = Math.max(ZOOM_MIN, zoom - 0.1);
        applyTransform();
    });
    document.getElementById('node-zoom-label')?.addEventListener('click', resetView);
}

function applyTransform() {
    const canvas = document.getElementById('node-canvas');
    if (canvas) canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    const label = document.getElementById('node-zoom-label');
    if (label) label.textContent = Math.round(zoom * 100) + '%';
}

function resetView() {
    const container = document.getElementById('node-container');
    const canvas = document.getElementById('node-canvas');
    if (!container || !canvas) return;
    zoom = 1.0;
    const cw = container.offsetWidth;
    const gw = canvas.scrollWidth;
    panX = Math.max(20, (cw - gw) / 2);
    panY = 30;
    applyTransform();
}

export function assignPaths(obj, currentPath = "root") {
    if (!obj || typeof obj !== 'object') return;
    
    Object.defineProperty(obj, '__path', { value: currentPath, enumerable: false, configurable: true });

    if (Array.isArray(obj)) {
        obj.forEach((item, idx) => assignPaths(item, `${currentPath}[${idx}]`));
    } else {
        for (const [k, v] of Object.entries(obj)) {
            assignPaths(v, `${currentPath}.${k}`);
        }
    }
}

// Called when switching TO the Nodes tab
export function syncYamlToNodes() {
    if (_isSyncing) return;
    const code = _editor.getValue().trim();
    const canvas = document.getElementById('node-canvas');
    if (!canvas) return;
    canvas.innerHTML = '';

    if (!code) {
        renderEmpty(canvas);
        requestAnimationFrame(resetView);
        return;
    }
    try {
        const loaded = jsyaml.load(code);
        _currentDoc = (loaded && typeof loaded === 'object') ? loaded : {};

        assignPaths(_currentDoc);

        // Ensure explicit defaults
        if (_currentDoc.alias === undefined) _currentDoc.alias = 'My Script';
        if (_currentDoc.mode === undefined) _currentDoc.mode = 'single';
        if (!_currentDoc.sequence) _currentDoc.sequence = [];

    } catch (e) {
        canvas.innerHTML = `<div class="node-empty"><span style="color:#ff5555">YAML error: ${e.message}</span></div>`;
        requestAnimationFrame(resetView);
        return;
    }
    renderGraph(canvas, _currentDoc);
    updateVariablePanel();
    requestAnimationFrame(resetView);
}

// Called after any node edit to push back to CodeMirror
function pushToYaml() {
    if (_isSyncing || !_currentDoc) return;
    _isSyncing = true;
    try {
        // Enforce a logical order for top-level keys
        const ordered = {};

        // Always explicit top-level fields
        ordered.alias = _currentDoc.alias ?? 'My Script';
        ordered.mode = _currentDoc.mode ?? 'single';

        if ('icon' in _currentDoc) ordered.icon = _currentDoc.icon;
        if ('variables' in _currentDoc) ordered.variables = _currentDoc.variables;

        // Copy any other keys (except sequence which should be last)
        Object.keys(_currentDoc).forEach(k => {
            if (!['alias', 'mode', 'icon', 'variables', 'sequence'].includes(k)) {
                ordered[k] = _currentDoc[k];
            }
        });

        ordered.sequence = _currentDoc.sequence || [];

        assignPaths(_currentDoc);
        
        const yaml = jsyaml.dump(ordered, { lineWidth: 120, noRefs: true });
        _editor.setValue(yaml);
        updateVariablePanel();
    } finally {
        _isSyncing = false;
    }
}

// ─── TOP LEVEL RENDERING ───────────────────────────────────────────────────

function renderGraph(container, doc) {
    const graph = el('div', 'node-graph');

    // Header node (alias / mode / icon)
    graph.appendChild(renderHeaderNode(doc));

    // Variables (top-level)
    if (doc.variables) {
        graph.appendChild(connector());
        graph.appendChild(renderVariablesNode(doc, 'variables', doc.variables));
    }

    // Main sequence
    const seq = doc.sequence || [];
    graph.appendChild(connector());
    const seqEl = renderSequence(seq, doc, 'sequence');
    graph.appendChild(seqEl);

    container.appendChild(graph);
}

function renderEmpty(container) {
    const empty = el('div', 'node-empty');
    empty.innerHTML = '<span>No script yet. Start by clicking the button below.</span>';
    const addBtn = makeAddBtn(() => {
        _currentDoc = { alias: 'My Script', sequence: [] };
        pushToYaml();
        container.innerHTML = '';
        renderGraph(container, _currentDoc);
    });
    empty.appendChild(addBtn);
    container.appendChild(empty);
}

// ─── SEQUENCE ──────────────────────────────────────────────────────────────

function renderSequence(steps, parentObj, key) {
    const seqEl = el('div', 'node-sequence');

    const rebuild = () => {
        const canvas = document.getElementById('node-canvas');
        if (!canvas || !_currentDoc) return;
        assignPaths(_currentDoc);
        canvas.innerHTML = '';
        renderGraph(canvas, _currentDoc);
        pushToYaml();
    };

    // Add button at top of empty sequence
    if (steps.length === 0) {
        const addBtn = makeAddBtn(() => showAddMenu(addBtn, steps, null, () => rebuild()));
        seqEl.appendChild(addBtn);
        return seqEl;
    }

    // Add button before the first step (insert at position 0)
    const firstAddBtn = makeAddBtn(() => showAddMenu(firstAddBtn, steps, 0, () => rebuild()));
    seqEl.appendChild(firstAddBtn);
    seqEl.appendChild(connector());

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const wrapper = el('div', 'step-wrapper');

        const nodeEl = renderStepNode(step, steps, i, () => rebuild());
        wrapper.appendChild(nodeEl);

        // Connector + add button between steps
        wrapper.appendChild(connector());
        const addBtn = makeAddBtn(() => showAddMenu(addBtn, steps, i + 1, () => rebuild()));
        wrapper.appendChild(addBtn);
        if (i < steps.length - 1) wrapper.appendChild(connector());

        seqEl.appendChild(wrapper);
    }

    return seqEl;
}

// ─── STEP NODE DISPATCH ────────────────────────────────────────────────────

function renderStepNode(step, steps, index, onRebuild) {
    const type = detectType(step);
    const renderers = {
        action: renderActionNode,
        delay: renderDelayNode,
        parallel: renderParallelNode,
        repeat: renderRepeatNode,
        choose: renderChooseNode,
        if: renderIfNode,
        wait: renderWaitNode,
        variables: renderStepVariablesNode,
    };
    const renderer = renderers[type] || renderUnknownNode;
    return renderer(step, steps, index, onRebuild);
}

function detectType(step) {
    if (step.action !== undefined || step.service !== undefined) return 'action';
    if (step.delay !== undefined) return 'delay';
    if (step.parallel !== undefined) return 'parallel';
    if (step.repeat !== undefined) return 'repeat';
    if (step.choose !== undefined) return 'choose';
    if (step.if !== undefined) return 'if';
    if (step.wait_template !== undefined || step.wait_for_trigger !== undefined) return 'wait';
    if (step.variables !== undefined) return 'variables';
    return 'unknown';
}

// ─── HEADER NODE ───────────────────────────────────────────────────────────

function renderHeaderNode(doc) {
    const node = makeNode('node-type-header', ICONS.script, 'Script');
    const body = node.querySelector('.node-body');

    body.appendChild(makeField('Alias', makeInput(doc.alias || '', v => {
        doc.alias = v; // Keep even if empty string
        pushToYaml();
    })));
    body.appendChild(makeField('Mode', (() => {
        const sel = el('select', 'node-select');
        ['single', 'restart', 'queued', 'parallel'].forEach(m => {
            const o = document.createElement('option');
            o.value = m; o.textContent = m;
            if (doc.mode === m) o.selected = true;
            sel.appendChild(o);
        });
        sel.addEventListener('change', () => {
            doc.mode = sel.value;
            pushToYaml();
        });
        return sel;
    })()));

    return node;
}

// ─── ACTION NODE ───────────────────────────────────────────────────────────

function renderActionNode(step, steps, index, onRebuild) {
    const node = makeNode('node-type-action', ICONS.action, 'Action', step);
    addNodeControls(node, steps, index, onRebuild);
    const body = node.querySelector('.node-body');

    // Action (ComboBox)
    const actionList = ['light.turn_on', 'light.turn_off', 'light.toggle', 'switch.turn_on', 'switch.turn_off'];
    body.appendChild(makeField('Action', makeComboBox(step.action || step.service || '', actionList, v => {
        delete step.service;
        step.action = v;
        onRebuild(); // Rebuild to show/hide property sections
        pushToYaml();
    }, 'e.g. light.turn_on')));

    // Entity (ComboBox)
    const entityList = getAvailableEntities();
    const entityVal = step.target?.entity_id || step.entity_id || '';
    body.appendChild(makeField('Entity', makeComboBox(Array.isArray(entityVal) ? entityVal.join(', ') : entityVal, entityList, v => {
        const ids = v.split(',').map(s => s.trim()).filter(Boolean);
        step.target = step.target || {};
        step.target.entity_id = ids.length === 1 ? ids[0] : ids;
        pushToYaml();
    }, 'entity_id')));

    // Light Properties (always visible)
    const props = el('div', 'node-props-section');
    props.appendChild(makeSectionLabel('Light Properties'));

    step.data = step.data || {};

    props.appendChild(makeSmartRange('Brightness', step.data.brightness_pct, 0, 100, '%', v => {
        if (v === '') delete step.data.brightness_pct;
        else step.data.brightness_pct = (typeof v === 'string' && v.includes('{')) ? v : (isNaN(parseFloat(v)) ? v : parseFloat(v));
        pushToYaml();
    }));

    props.appendChild(makeSmartColor('Color', step.data, () => {
        pushToYaml();
    }));

    props.appendChild(makeSmartField('Transition', step.data.transition, 'seconds', v => {
        if (v === '') delete step.data.transition;
        else step.data.transition = isNaN(parseFloat(v)) ? v : parseFloat(v);
        pushToYaml();
    }));

    body.appendChild(props);

    // Data fields (Custom)
    const dataSection = el('div');
    dataSection.appendChild(makeSectionLabel('Custom Data'));
    const dataObj = step.data || {};
    step.data = dataObj;

    // Always filter smart keys so they don't appear twice
    const filteredData = {};
    const smartKeys = ['brightness_pct', 'rgb_color', 'hs_color', 'xy_color', 'transition'];
    Object.keys(dataObj).forEach(k => {
        if (!smartKeys.includes(k)) {
            filteredData[k] = dataObj[k];
        }
    });

    renderDataFields(dataSection, filteredData, () => {
        // Merge filtered data back
        Object.assign(step.data, filteredData);
        pushToYaml();
    });
    body.appendChild(dataSection);

    return node;
}

// ─── DELAY NODE ────────────────────────────────────────────────────────────

function renderDelayNode(step, steps, index, onRebuild) {
    const node = makeNode('node-type-delay', ICONS.delay, 'Delay', step);
    addNodeControls(node, steps, index, onRebuild);
    const body = node.querySelector('.node-body');

    let displayVal = '';
    if (typeof step.delay === 'object' && step.delay !== null) {
        displayVal = JSON.stringify(step.delay);
    } else {
        displayVal = String(step.delay ?? '');
    }

    body.appendChild(makeField('Duration', makeInput(displayVal, v => {
        // Try to parse as number, object, or leave as string (HH:MM:SS)
        if (v.startsWith('{')) {
            try { step.delay = JSON.parse(v); } catch { step.delay = v; }
        } else if (!isNaN(parseFloat(v)) && !v.includes(':')) {
            step.delay = parseFloat(v);
        } else {
            step.delay = v;
        }
        pushToYaml();
    }, 'seconds, HH:MM:SS, or {seconds: 2}')));

    return node;
}

// ─── PARALLEL NODE ─────────────────────────────────────────────────────────

function renderParallelNode(step, steps, index, onRebuild) {
    const node = makeNode('node-type-parallel', ICONS.parallel, 'Parallel', step);
    addNodeControls(node, steps, index, onRebuild, () => {
        const branches = Array.isArray(step.parallel) ? step.parallel : [step.parallel];
        return branches.flatMap(b => {
            if (Array.isArray(b)) return b;
            if (b?.sequence) return b.sequence;
            return [b];
        });
    });
    const body = node.querySelector('.node-body');

    const branches = Array.isArray(step.parallel) ? step.parallel : [step.parallel];
    step.parallel = branches;

    const branchesEl = el('div', 'node-branches');
    renderBranchColumns(branchesEl, branches, onRebuild);
    body.appendChild(branchesEl);

    // Add branch button
    const addBranchBtn = el('button', 'btn-add-field');
    addBranchBtn.textContent = '+ Add branch';
    addBranchBtn.onclick = () => {
        branches.push({ action: 'light.turn_on' }); // Default to a simple action
        onRebuild();
        pushToYaml();
    };
    body.appendChild(addBranchBtn);

    return node;
}

function renderBranchColumns(container, branches, onRebuild) {
    branches.forEach((branch, i) => {
        const branchEl = el('div', 'node-branch');
        const label = el('div', 'node-branch-label');
        label.textContent = `Branch ${i + 1}`;

        if (branches.length > 1) {
            const rmBtn = document.createElement('button');
            rmBtn.textContent = ' ✕';
            rmBtn.style.cssText = 'background:none;border:none;color:#ff5555;cursor:pointer;font-size:10px;';
            rmBtn.classList.add('btn-remove-field');
            rmBtn.onclick = () => { branches.splice(i, 1); onRebuild(); pushToYaml(); };
            label.appendChild(rmBtn);
        }

        branchEl.appendChild(label);

        // Normalize branch to a sequence for rendering.
        // Three valid forms from Home Assistant / Timeline Editor:
        //   1. { sequence: [...] }  — named-sequence form (Timeline output)
        //   2. [step, step, ...]    — plain array
        //   3. { action: ... }      — single step → normalize to array
        let seqParent, seqKey;
        if (branch && typeof branch === 'object' && !Array.isArray(branch) && Array.isArray(branch.sequence)) {
            // Named-sequence wrapper: render inner array but keep wrapper for YAML
            seqParent = branch;
            seqKey = 'sequence';
        } else {
            if (!Array.isArray(branch)) {
                branches[i] = [branch];
            }
            seqParent = branches;
            seqKey = i;
        }

        branchEl.appendChild(renderSequence(seqParent[seqKey], seqParent, seqKey));
        container.appendChild(branchEl);
    });
}

// ─── REPEAT NODE ───────────────────────────────────────────────────────────

function renderRepeatNode(step, steps, index, onRebuild) {
    const node = makeNode('node-type-repeat', ICONS.repeat, 'Repeat', step);
    addNodeControls(node, steps, index, onRebuild, () => step.repeat?.sequence || []);
    const body = node.querySelector('.node-body');
    const r = step.repeat || {};
    step.repeat = r;

    // Mode selector
    const modeMap = { count: 'Count', while: 'While', until: 'Until', for_each: 'For Each' };
    let currentMode = r.count !== undefined ? 'count' : r.while !== undefined ? 'while' : r.until !== undefined ? 'until' : r.for_each !== undefined ? 'for_each' : 'count';

    const modeEl = makeField('Mode', (() => {
        const sel = el('select', 'node-select');
        Object.entries(modeMap).forEach(([v, l]) => {
            const o = document.createElement('option');
            o.value = v; o.textContent = l;
            if (v === currentMode) o.selected = true;
            sel.appendChild(o);
        });
        sel.addEventListener('change', () => {
            const m = sel.value;
            delete r.count; delete r.while; delete r.until; delete r.for_each;
            if (m === 'count') r.count = 1;
            else if (m === 'while') r.while = '';
            else if (m === 'until') r.until = '';
            else r.for_each = '';
            onRebuild(); pushToYaml();
        });
        return sel;
    })());
    body.appendChild(modeEl);

    if (currentMode === 'count') {
        body.appendChild(makeField('Count', makeInput(String(r.count ?? 1), v => { r.count = parseInt(v) || 1; pushToYaml(); })));
    } else if (currentMode === 'while') {
        body.appendChild(makeField('While', makeInput(String(r.while || ''), v => { r.while = v; pushToYaml(); }, '{{ condition }}')));
    } else if (currentMode === 'until') {
        body.appendChild(makeField('Until', makeInput(String(r.until || ''), v => { r.until = v; pushToYaml(); }, '{{ condition }}')));
    } else {
        body.appendChild(makeField('For Each', makeInput(typeof r.for_each === 'string' ? r.for_each : JSON.stringify(r.for_each), v => { r.for_each = v; pushToYaml(); })));
    }

    // Nested sequence
    body.appendChild(makeSectionLabel('Sequence'));
    r.sequence = r.sequence || [];
    body.appendChild(renderSequence(r.sequence, r, 'sequence'));

    return node;
}

// ─── CHOOSE NODE ───────────────────────────────────────────────────────────

function renderChooseNode(step, steps, index, onRebuild) {
    const node = makeNode('node-type-choose', ICONS.choose, 'Choose', step);
    addNodeControls(node, steps, index, onRebuild);
    const body = node.querySelector('.node-body');
    const choices = Array.isArray(step.choose) ? step.choose : [step.choose].filter(Boolean);
    step.choose = choices;

    const rebuildChoices = () => { onRebuild(); pushToYaml(); };

    choices.forEach((choice, i) => {
        const sec = el('div');
        sec.appendChild(makeSectionLabel(`Option ${i + 1}`));
        choice.conditions = choice.conditions || [];
        const condVal = Array.isArray(choice.conditions)
            ? choice.conditions.map(c => c.value_template || JSON.stringify(c)).join('\n')
            : String(choice.conditions);
        sec.appendChild(makeField('Condition', makeInput(condVal, v => {
            choice.conditions = [{ condition: 'template', value_template: v }];
            pushToYaml();
        }, '{{ template }}')));
        choice.sequence = choice.sequence || [];
        sec.appendChild(renderSequence(choice.sequence, choice, 'sequence'));

        if (choices.length > 1) {
            const rmBtn = el('button', 'btn-add-field');
            rmBtn.textContent = `Remove Option ${i + 1}`;
            rmBtn.style.color = '#ff5555';
            rmBtn.onclick = () => { choices.splice(i, 1); rebuildChoices(); };
            sec.appendChild(rmBtn);
        }
        body.appendChild(sec);
    });

    const addChoiceBtn = el('button', 'btn-add-field');
    addChoiceBtn.textContent = '+ Add option';
    addChoiceBtn.onclick = () => { choices.push({ conditions: [], sequence: [] }); rebuildChoices(); };
    body.appendChild(addChoiceBtn);

    // Default sequence
    body.appendChild(makeSectionLabel('Default (fallback)'));
    step.default = step.default || [];
    body.appendChild(renderSequence(step.default, step, 'default'));

    return node;
}

// ─── IF/THEN/ELSE NODE ─────────────────────────────────────────────────────

function renderIfNode(step, steps, index, onRebuild) {
    const node = makeNode('node-type-if', ICONS.if, 'If / Then / Else', step);
    addNodeControls(node, steps, index, onRebuild);
    const body = node.querySelector('.node-body');

    const condVal = Array.isArray(step.if)
        ? step.if.map(c => c.value_template || JSON.stringify(c)).join('\n')
        : String(step.if || '');

    body.appendChild(makeField('If', makeInput(condVal, v => {
        step.if = [{ condition: 'template', value_template: v }];
        pushToYaml();
    }, '{{ template }}')));

    body.appendChild(makeSectionLabel('Then'));
    step.then = step.then || [];
    body.appendChild(renderSequence(step.then, step, 'then'));

    body.appendChild(makeSectionLabel('Else'));
    step.else = step.else || [];
    body.appendChild(renderSequence(step.else, step, 'else'));

    return node;
}

// ─── WAIT NODE ─────────────────────────────────────────────────────────────

function renderWaitNode(step, steps, index, onRebuild) {
    const node = makeNode('node-type-wait', ICONS.wait, 'Wait', step);
    addNodeControls(node, steps, index, onRebuild);
    const body = node.querySelector('.node-body');

    // Type Selector: Template vs Trigger
    const modeMap = { wait_template: 'Template', wait_for_trigger: 'Trigger' };
    let currentMode = step.wait_for_trigger !== undefined ? 'wait_for_trigger' : 'wait_template';

    const modeEl = makeField('Wait For', (() => {
        const sel = el('select', 'node-select');
        Object.entries(modeMap).forEach(([v, l]) => {
            const o = document.createElement('option');
            o.value = v; o.textContent = l;
            if (v === currentMode) o.selected = true;
            sel.appendChild(o);
        });
        sel.addEventListener('change', () => {
            const m = sel.value;
            delete step.wait_template;
            delete step.wait_for_trigger;
            if (m === 'wait_template') step.wait_template = '';
            else step.wait_for_trigger = [];
            onRebuild(); pushToYaml();
        });
        return sel;
    })());
    body.appendChild(modeEl);

    // Main Input
    if (currentMode === 'wait_template') {
        const val = step.wait_template || '';
        body.appendChild(makeField('Template', makeInput(String(val), v => {
            step.wait_template = v;
            pushToYaml();
        }, '{{ is_state(...) }}')));
    } else {
        const val = step.wait_for_trigger || '';
        body.appendChild(makeField('Trigger', makeInput(typeof val === 'object' ? JSON.stringify(val) : String(val), v => {
            try { step.wait_for_trigger = JSON.parse(v); } catch(e) { step.wait_for_trigger = v; }
            pushToYaml();
        }, '[{"platform": "state"...}]')));
    }

    // Timeout
    body.appendChild(makeField('Timeout', makeInput(step.timeout !== undefined ? (typeof step.timeout === 'object' ? JSON.stringify(step.timeout) : String(step.timeout)) : '', v => { 
        if (v.trim() === '') {
            delete step.timeout;
            delete step.continue_on_timeout;
            onRebuild(); // Rebuild to remove Continue field
        } else {
            let parsed = v;
            if (!isNaN(parseFloat(v)) && String(parseFloat(v)) === v) parsed = parseFloat(v);
            else { try { parsed = JSON.parse(v); } catch(e){} }
            
            const wasEmpty = step.timeout === undefined;
            step.timeout = parsed;
            if (wasEmpty) onRebuild(); // Rebuild to show Continue field
        }
        pushToYaml(); 
    }, 'e.g. 10, "00:01:00"')));

    // Continue on timeout (only if timeout exists)
    if (step.timeout !== undefined && step.timeout !== '') {
        const contVal = step.continue_on_timeout !== false; // HA default is true
        const sel = el('select', 'node-select');
        ['true', 'false'].forEach(m => {
            const o = document.createElement('option');
            o.value = m; o.textContent = m;
            if (m === String(contVal)) o.selected = true;
            sel.appendChild(o);
        });
        sel.addEventListener('change', () => {
            step.continue_on_timeout = sel.value === 'true';
            pushToYaml();
        });
        body.appendChild(makeField('Continue', sel));
    }

    return node;
}

// ─── VARIABLES NODES ───────────────────────────────────────────────────────

function renderVariablesNode(parentObj, key, vars) {
    const node = makeNode('node-type-variables', ICONS.variables, 'Variables', parentObj);
    const body = node.querySelector('.node-body');
    renderDataFields(body, vars, () => { parentObj[key] = vars; pushToYaml(); });
    return node;
}

function renderStepVariablesNode(step, steps, index, onRebuild) {
    const node = makeNode('node-type-variables', ICONS.variables, 'Set Variables', step);
    addNodeControls(node, steps, index, onRebuild);
    const body = node.querySelector('.node-body');
    step.variables = step.variables || {};
    renderDataFields(body, step.variables, () => pushToYaml());
    return node;
}

function renderUnknownNode(step, steps, index, onRebuild) {
    const node = makeNode('node-type-variables', '?', 'Unknown Step', step);
    addNodeControls(node, steps, index, onRebuild);
    const body = node.querySelector('.node-body');
    body.innerHTML = `<span style="color:#888;font-size:10px">${JSON.stringify(step)}</span>`;
    return node;
}

// ─── DATA FIELDS (key-value) ───────────────────────────────────────────────

function renderDataFields(container, obj, onChange) {
    const list = el('div');
    list.style.display = 'flex';
    list.style.flexDirection = 'column';
    list.style.gap = '4px';

    const rebuild = () => {
        list.innerHTML = '';
        renderRows();
    };

    const isPossibleColor = (k, v) => {
        if (!Array.isArray(v)) return false;
        if (v.length === 3 && v.every(n => typeof n === 'number' && n >= 0 && n <= 255)) return true;
        if (v.length === 2 && v.every(n => typeof n === 'number') && (k.includes('xy') || k.includes('hs') || k.includes('color'))) return true;
        return false;
    };

    const renderRows = () => {
        Object.keys(obj).forEach(k => {
            const row = el('div', 'node-data-row');
            
            const keyIn = el('input', 'node-input node-input-key');
            keyIn.placeholder = 'key';
            keyIn.value = k;
            keyIn.addEventListener('change', () => {
                const oldVal = obj[k];
                delete obj[k];
                obj[keyIn.value] = oldVal;
                rebuild();
                onChange();
            });

            const isComplex = typeof obj[k] === 'object' && obj[k] !== null;
            const isColor = isPossibleColor(k, obj[k]);

            const valIn = el(isComplex && !isColor ? 'textarea' : 'input', 'node-input');
            valIn.placeholder = 'value (JSON allowed)';
            valIn.value = isComplex ? JSON.stringify(obj[k], null, 2) : String(obj[k] ?? '');

            if (isComplex && !isColor) {
                valIn.style.height = 'auto';
                valIn.style.minHeight = '40px';
                valIn.style.resize = 'vertical';
            }

            const valContainer = el('div');
            valContainer.style.display = 'flex';
            valContainer.style.flex = '1';
            valContainer.style.gap = '5px';
            valContainer.appendChild(valIn);

            if (isColor) {
                const picker = el('input', 'node-color-picker');
                picker.type = 'color';
                picker.style.width = '30px';
                picker.style.height = '28px';
                picker.style.padding = '0';
                picker.style.cursor = 'pointer';
                picker.style.flexShrink = '0';
                
                let rgb = [255, 255, 255];
                if (obj[k].length === 3) rgb = obj[k];
                else if (k.includes('hs')) rgb = hsToRgb(obj[k]);
                else if (k.includes('xy')) rgb = xyToRgb(obj[k]);
                picker.value = rgbToHex(rgb);
                
                picker.addEventListener('input', () => {
                    const hex = picker.value;
                    const r = parseInt(hex.slice(1, 3), 16);
                    const g = parseInt(hex.slice(3, 5), 16);
                    const b = parseInt(hex.slice(5, 7), 16);
                    
                    let newArr = [r, g, b];
                    if (obj[k].length === 2) {
                        if (k.includes('hs')) newArr = rgbToHs(newArr);
                        else newArr = rgbToXy(newArr);
                    }
                    
                    obj[keyIn.value] = newArr;
                    valIn.value = JSON.stringify(newArr);
                    valIn.style.borderColor = '#50fa7b';
                    onChange();
                });
                
                valContainer.appendChild(picker);
            }

            valIn.addEventListener('input', () => {
                const v = valIn.value.trim();
                if ((v.startsWith('[') && v.endsWith(']')) || (v.startsWith('{') && v.endsWith('}'))) {
                    try {
                        JSON.parse(v);
                        valIn.style.borderColor = '#50fa7b';
                    } catch (e) {
                        valIn.style.borderColor = '#ff5555';
                    }
                } else {
                    valIn.style.borderColor = '';
                }
            });

            valIn.addEventListener('change', () => {
                const v = valIn.value.trim();
                let parsed = v;
                if (v === 'true') parsed = true;
                else if (v === 'false') parsed = false;
                else if (!isNaN(parseFloat(v)) && String(parseFloat(v)) === v) parsed = parseFloat(v);
                else if ((v.startsWith('[') && v.endsWith(']')) || (v.startsWith('{') && v.endsWith('}'))) {
                    try { parsed = JSON.parse(v); } catch (e) { }
                }
                obj[keyIn.value] = parsed;
                onChange();
                
                // Rebuild if color state changed or we need to update the picker's color
                const isNowColor = isPossibleColor(keyIn.value, parsed);
                if (isColor !== isNowColor || isNowColor) {
                    rebuild();
                }
            });

            const rm = el('button', 'btn-remove-field');
            rm.textContent = '✕';
            rm.addEventListener('click', () => { delete obj[keyIn.value]; rebuild(); onChange(); });

            row.appendChild(keyIn);
            row.appendChild(valContainer);
            row.appendChild(rm);
            list.appendChild(row);
        });

        const addBtn = el('button', 'btn-add-field');
        addBtn.textContent = '+ Add field';
        addBtn.onclick = () => {
            let newKey = 'key';
            let n = 1;
            while (obj[newKey]) newKey = `key_${n++}`;
            obj[newKey] = '';
            rebuild();
            onChange();
        };
        list.appendChild(addBtn);
    };

    renderRows();
    container.appendChild(list);
}

// ─── UNWRAP ────────────────────────────────────────────────────────────────

// Adds an "unwrap" button to a container node's header.
// getInner() must return the flat array of steps to splice in place.

// ─── WRAP MENU ─────────────────────────────────────────────────────────────

const WRAP_TYPES = [
    { icon: ICONS.repeat,   label: 'Repeat',   wrap: s => ({ repeat:   { count: 2, sequence: [s] } }) },
    { icon: ICONS.parallel, label: 'Parallel', wrap: s => ({ parallel: [{ sequence: [s] }] }) },
    { icon: ICONS.choose,   label: 'Choose',   wrap: s => ({ choose: [{ conditions: [], sequence: [s] }], default: [] }) },
    { icon: ICONS.if,       label: 'If / Then',wrap: s => ({ if: [], then: [s], else: [] }) },
];

function showWrapMenu(anchorBtn, steps, index, onRebuild) {
    document.querySelectorAll('.node-add-menu.open').forEach(m => m.remove());
    const menu = el('div', 'node-add-menu open');

    const title = el('div', 'node-add-menu-title');
    title.textContent = 'Wrap in…';
    menu.appendChild(title);

    WRAP_TYPES.forEach(({ icon, label, wrap }) => {
        const item = el('div', 'node-add-menu-item');
        item.innerHTML = `<span class="menu-icon">${icon}</span>${label}`;
        item.onclick = () => {
            const original = steps[index];
            steps.splice(index, 1, wrap(original));
            menu.remove();
            onRebuild();
            pushToYaml();
        };
        menu.appendChild(item);
    });

    document.body.appendChild(menu);

    const anchor = anchorBtn.getBoundingClientRect();
    const mW = menu.offsetWidth  || 160;
    const mH = menu.offsetHeight || (WRAP_TYPES.length * 29 + 24);
    const vW = window.innerWidth, vH = window.innerHeight, gap = 6;
    let left = anchor.left + anchor.width / 2 - mW / 2;
    left = Math.max(8, Math.min(left, vW - mW - 8));
    let top = (anchor.bottom + gap + mH > vH && anchor.top - gap - mH >= 0)
        ? anchor.top - gap - mH : anchor.bottom + gap;
    top = Math.max(8, Math.min(top, vH - mH - 8));
    menu.style.left = `${left}px`;
    menu.style.top  = `${top}px`;

    const close = (e) => {
        if (!menu.contains(e.target) && e.target !== anchorBtn) {
            menu.remove();
            document.removeEventListener('click', close);
            document.removeEventListener('scroll', close, true);
        }
    };
    setTimeout(() => {
        document.addEventListener('click', close);
        document.addEventListener('scroll', close, true);
    }, 0);
}

// ─── ADD STEP MENU ─────────────────────────────────────────────────────────

const STEP_TYPES = [
    { type: 'action', icon: ICONS.action, label: 'Action', template: () => ({ action: 'light.turn_on', target: { entity_id: '' }, data: {} }) },
    { type: 'delay', icon: ICONS.delay, label: 'Delay', template: () => ({ delay: '00:00:01' }) },
    { type: 'parallel', icon: ICONS.parallel, label: 'Parallel', template: () => ({ parallel: [] }) },
    { type: 'repeat', icon: ICONS.repeat, label: 'Repeat', template: () => ({ repeat: { count: 1, sequence: [] } }) },
    { type: 'choose', icon: ICONS.choose, label: 'Choose', template: () => ({ choose: [{ conditions: [], sequence: [] }], default: [] }) },
    { type: 'if', icon: ICONS.if, label: 'If/Then/Else', template: () => ({ if: [], then: [], else: [] }) },
    { type: 'wait', icon: ICONS.wait, label: 'Wait', template: () => ({ wait_template: '', timeout: '' }) },
    { type: 'variables', icon: ICONS.variables, label: 'Variables', template: () => ({ variables: {} }) },
];

function showAddMenu(anchorBtn, steps, insertAt, onAdded) {
    // Close any open menus
    document.querySelectorAll('.node-add-menu.open').forEach(m => m.remove());

    const menu = el('div', 'node-add-menu open');
    STEP_TYPES.forEach(({ type, icon, label, template }) => {
        const item = el('div', 'node-add-menu-item');
        item.innerHTML = `<span class="menu-icon">${icon}</span>${label}`;
        item.onclick = () => {
            const newStep = template();
            if (insertAt === null || insertAt === undefined) {
                steps.push(newStep);
            } else {
                steps.splice(insertAt, 0, newStep);
            }
            menu.remove();
            onAdded();
        };
        menu.appendChild(item);
    });

    // Attach to body so overflow/stacking-context of node editor can't clip it
    document.body.appendChild(menu);

    // Smart positioning: measure after attach, then place
    const anchor = anchorBtn.getBoundingClientRect();
    const mW = menu.offsetWidth  || 160;
    const mH = menu.offsetHeight || (STEP_TYPES.length * 29 + 8);
    const vW = window.innerWidth;
    const vH = window.innerHeight;
    const gap = 6;

    // Horizontal: centre on button, clamp inside viewport
    let left = anchor.left + anchor.width / 2 - mW / 2;
    left = Math.max(8, Math.min(left, vW - mW - 8));

    // Vertical: prefer below, flip above if too close to bottom edge
    let top;
    if (anchor.bottom + gap + mH > vH && anchor.top - gap - mH >= 0) {
        top = anchor.top - gap - mH; // open upward
    } else {
        top = anchor.bottom + gap;   // open downward
    }
    top = Math.max(8, Math.min(top, vH - mH - 8));

    menu.style.left = `${left}px`;
    menu.style.top  = `${top}px`;

    // Close on outside click or any scroll inside the node editor
    function close(e) {
        if (!menu.contains(e.target) && e.target !== anchorBtn) {
            menu.remove();
            document.removeEventListener('click', close);
            document.removeEventListener('scroll', close, true);
        }
    }
    setTimeout(() => {
        document.addEventListener('click', close);
        document.addEventListener('scroll', close, true);
    }, 0);
}

// ─── NODE CONTROLS (move up/down, delete) ──────────────────────────────────

function addNodeControls(node, steps, index, onRebuild, unwrapFn = null) {
    const actions = node.querySelector('.node-header-actions');

    const sep = () => {
        const s = document.createElement('span');
        s.className = 'node-actions-sep';
        return s;
    };

    // ── Group 1: Move ──────────────────────────────────────────────────────
    const hasMoveUp   = index > 0;
    const hasMoveDown = index < steps.length - 1;
    if (hasMoveUp || hasMoveDown) {
        actions.appendChild(sep());
        if (hasMoveUp) {
            const btn = document.createElement('button');
            btn.textContent = '↑'; btn.title = 'Move up';
            btn.classList.add('btn-move-up');
            btn.onclick = () => { [steps[index], steps[index-1]] = [steps[index-1], steps[index]]; onRebuild(); pushToYaml(); };
            actions.appendChild(btn);
        }
        if (hasMoveDown) {
            const btn = document.createElement('button');
            btn.textContent = '↓'; btn.title = 'Move down';
            btn.classList.add('btn-move-down');
            btn.onclick = () => { [steps[index], steps[index+1]] = [steps[index+1], steps[index]]; onRebuild(); pushToYaml(); };
            actions.appendChild(btn);
        }
    }

    // ── Group 2: Structure (Wrap + optional Unwrap) ────────────────────────
    actions.appendChild(sep());
    const wrapBtn = document.createElement('button');
    wrapBtn.textContent = '⊡'; wrapBtn.title = 'Wrap in container';
    wrapBtn.classList.add('btn-wrap');
    wrapBtn.onclick = (e) => { e.stopPropagation(); showWrapMenu(wrapBtn, steps, index, onRebuild); };
    actions.appendChild(wrapBtn);

    if (unwrapFn) {
        const unwrapBtn = document.createElement('button');
        unwrapBtn.textContent = '⊠'; unwrapBtn.title = 'Unwrap — Inhalt einsetzen';
        unwrapBtn.classList.add('btn-unwrap');
        unwrapBtn.onclick = (e) => {
            e.stopPropagation();
            const inner = unwrapFn();
            if (inner.length > 0) steps.splice(index, 1, ...inner);
            else steps.splice(index, 1);
            onRebuild(); pushToYaml();
        };
        actions.appendChild(unwrapBtn);
    }

    // ── Group 3: Delete ────────────────────────────────────────────────────
    actions.appendChild(sep());
    const delBtn = document.createElement('button');
    delBtn.textContent = '✕'; delBtn.title = 'Delete step';
    delBtn.classList.add('btn-entity-header-delete');
    delBtn.onclick = () => { steps.splice(index, 1); onRebuild(); pushToYaml(); };
    actions.appendChild(delBtn);
}

// ─── DOM HELPERS ───────────────────────────────────────────────────────────

function el(tag, className) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    return e;
}

function connector() {
    return el('div', 'step-connector');
}

function makeNode(typeClass, icon, title, stepObj = null) {
    const node = el('div', `node-item ${typeClass}`);
    if (stepObj && stepObj.__path) {
        node.dataset.path = stepObj.__path;
    }
    
    // Check if this step has an active breakpoint
    const hasBp = stepObj && stepObj.__path && breakpoints.has(stepObj.__path);
    const bpClass = hasBp ? 'bp-active' : '';

    node.innerHTML = `
        <div class="node-header">
            <div class="node-header-left">
                ${stepObj ? `<button class="btn-breakpoint ${bpClass}" title="Toggle Breakpoint" style="color: ${hasBp ? '#ff5555' : '#444'};">&#x23FA;</button>` : '<span class="node-header-bp-spacer"></span>'}
                <div class="node-header-title">
                    <span class="node-header-icon">${icon}</span>
                    <span>${title}</span>
                </div>
            </div>
            <div class="node-header-actions"></div>
        </div>
        <div class="node-body"></div>
    `;

    if (stepObj && stepObj.__path) {
        const bpBtn = node.querySelector('.btn-breakpoint');
        if (bpBtn) {
            bpBtn.onclick = (e) => {
                e.stopPropagation();
                toggleBreakpoint(stepObj.__path);
                const isActive = breakpoints.has(stepObj.__path);
                bpBtn.style.color = isActive ? '#ff5555' : '#555';
                if (isActive) bpBtn.classList.add('bp-active');
                else bpBtn.classList.remove('bp-active');
                
                // Inform others (YAML Editor) to refresh markers
                document.dispatchEvent(new CustomEvent('breakpointsChanged'));
            };
        }
    }
    
    return node;
}

function makeField(label, inputEl) {
    const field = el('div', 'node-field');
    const lbl = el('span', 'node-field-label');
    lbl.textContent = label;
    field.appendChild(lbl);
    field.appendChild(inputEl);
    return field;
}

function makeInput(value, onChange, placeholder) {
    const inp = el('input', 'node-input');
    inp.type = 'text';
    inp.value = value;
    if (placeholder) inp.placeholder = placeholder;
    inp.addEventListener('change', () => onChange(inp.value));
    return inp;
}

function makeAddBtn(onClick) {
    const btn = el('button', 'node-add-btn');
    btn.textContent = '+';
    btn.title = 'Add step';
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(btn); });
    return btn;
}

function makeSectionLabel(text) {
    const s = el('div', 'node-section-label');
    s.textContent = text;
    return s;
}

// ─── SMART UI HELPERS ──────────────────────────────────────────────────────

function makeComboBox(value, options, onChange, placeholder) {
    const container = el('div', 'node-combo-container');
    const input = el('input', 'node-input');
    input.value = value;
    input.placeholder = placeholder;

    const dlId = 'dl-' + Math.random().toString(36).substr(2, 9);
    const dl = el('datalist');
    dl.id = dlId;
    options.forEach(opt => {
        const o = el('option');
        o.value = opt;
        dl.appendChild(o);
    });
    container.appendChild(dl);
    input.setAttribute('list', dlId);

    input.addEventListener('change', () => onChange(input.value));
    container.appendChild(input);
    return container;
}

function makeSmartRange(label, value, min, max, unit, onChange) {
    const field = el('div', 'node-field node-field-smart');
    const lbl = el('span', 'node-field-label');
    lbl.textContent = label;

    const controlRow = el('div', 'node-smart-row');

    const slider = el('input', 'node-slider');
    slider.type = 'range';
    slider.min = min;
    slider.max = max;
    slider.value = (typeof value === 'number') ? value : (isNaN(parseFloat(value)) ? 0 : parseFloat(value));

    const override = el('input', 'node-input node-input-override');
    override.value = (value === undefined || value === null) ? '' : (Array.isArray(value) ? JSON.stringify(value) : value);
    override.placeholder = 'Value or {{...}}';

    slider.addEventListener('input', () => {
        override.value = slider.value;
        onChange(parseFloat(slider.value));
    });

    override.addEventListener('change', () => {
        const v = override.value;
        if (!isNaN(parseFloat(v)) && !v.includes('{')) {
            slider.value = parseFloat(v);
            onChange(parseFloat(v));
        } else {
            onChange(v);
        }
    });

    controlRow.appendChild(slider);
    controlRow.appendChild(override);
    field.appendChild(lbl);
    field.appendChild(controlRow);
    return field;
}

function makeSmartColor(label, dataObj, onChange) {
    const field = el('div', 'node-field node-field-smart');
    const headRow = el('div', 'node-smart-head');

    const lbl = el('span', 'node-field-label');
    lbl.textContent = label;
    headRow.appendChild(lbl);

    // Mode selector
    const modes = ['rgb_color', 'hs_color', 'xy_color'];
    let currentMode = modes.find(m => dataObj[m] !== undefined) || 'rgb_color';

    const modeSel = el('select', 'node-input-mode');
    modes.forEach(m => {
        const o = el('option');
        o.value = m; o.textContent = m.split('_')[0].toUpperCase();
        if (m === currentMode) o.selected = true;
        modeSel.appendChild(o);
    });
    headRow.appendChild(modeSel);
    field.appendChild(headRow);

    const controlRow = el('div', 'node-smart-row');
    const picker = el('input', 'node-color-picker');
    picker.type = 'color';

    const override = el('input', 'node-input node-input-override');
    override.placeholder = 'Value or {{...}}';

    const updateUI = () => {
        const val = dataObj[currentMode];
        override.value = (val === undefined || val === null) ? '' : (Array.isArray(val) ? JSON.stringify(val) : val);

        let rgb = [255, 255, 255];
        if (val) {
            if (currentMode === 'rgb_color') rgb = val;
            else if (currentMode === 'hs_color') rgb = hsToRgb(val);
            else if (currentMode === 'xy_color') rgb = xyToRgb(val);
        }
        picker.value = rgbToHex(rgb);
    };

    modeSel.addEventListener('change', () => {
        const oldMode = currentMode;
        currentMode = modeSel.value;
        const oldVal = dataObj[oldMode];

        if (oldVal !== undefined) {
            let rgb = [255, 255, 255];
            if (oldMode === 'rgb_color') rgb = oldVal;
            else if (oldMode === 'hs_color') rgb = hsToRgb(oldVal);
            else if (oldMode === 'xy_color') rgb = xyToRgb(oldVal);

            delete dataObj[oldMode];
            if (currentMode === 'rgb_color') dataObj[currentMode] = rgb;
            else if (currentMode === 'hs_color') dataObj[currentMode] = rgbToHs(rgb);
            else if (currentMode === 'xy_color') dataObj[currentMode] = rgbToXy(rgb);
        } else {
            // Default if nothing was there
            dataObj[currentMode] = (currentMode === 'rgb_color') ? [255, 255, 255] : (currentMode === 'hs_color' ? [0, 0] : [0.323, 0.329]);
        }

        updateUI();
        onChange();
    });

    picker.addEventListener('input', () => {
        const rgb = hexToRgb(picker.value);
        if (currentMode === 'rgb_color') dataObj[currentMode] = rgb;
        else if (currentMode === 'hs_color') dataObj[currentMode] = rgbToHs(rgb);
        else if (currentMode === 'xy_color') dataObj[currentMode] = rgbToXy(rgb);

        override.value = JSON.stringify(dataObj[currentMode]);
        onChange();
    });

    override.addEventListener('change', () => {
        const v = override.value.trim();
        if (v === '') {
            delete dataObj[currentMode];
            onChange();
            return;
        }
        if (v.startsWith('[') && v.endsWith(']')) {
            try {
                dataObj[currentMode] = JSON.parse(v);
                updateUI();
                onChange();
            } catch (e) { dataObj[currentMode] = v; onChange(); }
        } else {
            dataObj[currentMode] = v;
            onChange();
        }
    });

    updateUI();

    controlRow.appendChild(picker);
    controlRow.appendChild(override);
    field.appendChild(controlRow);
    return field;
}

function makeSmartField(label, value, unit, onChange) {
    const field = el('div', 'node-field node-field-smart');
    const lbl = el('span', 'node-field-label');
    lbl.textContent = label;

    const input = el('input', 'node-input');
    input.value = (value === undefined || value === null) ? '' : value;
    input.placeholder = `Value in ${unit} or {{...}}`;
    input.addEventListener('change', () => onChange(input.value));

    field.appendChild(lbl);
    field.appendChild(input);
    return field;
}

// ─── VARIABLE DISCOVERY & PANEL ───────────────────────────────────────────

export function updateVariablePanel(externalDoc = null) {
    const container = document.getElementById('variable-list');
    if (!container) return;

    const docToUse = externalDoc || _currentDoc;

    if (!docToUse) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = '';

    const vars = discoverVariables(docToUse);
    const sortedKeys = Object.keys(vars).sort();

    if (sortedKeys.length === 0) {
        container.innerHTML = `<div style="padding:10px;color:#666;font-size:11px;text-align:center;">${t('no_vars_found')}</div>`;
        return;
    }

    sortedKeys.forEach(key => {
        const row = el('div', 'entity-item');
        row.style.cursor = 'pointer';
        row.title = t('click_to_insert');

        const insertBtn = el('button', 'btn-var-insert');
        insertBtn.innerHTML = '←';
        insertBtn.title = t('click_to_insert');
        const info = el('div', 'entity-info');
        info.style.flex = "1";
        info.style.minWidth = "0";

        const name = el('div', 'entity-name');
        name.textContent = key;

        const valPreview = el('div', 'entity-id');
        valPreview.textContent = String(vars[key]).substring(0, 30);

        info.appendChild(name);
        info.appendChild(valPreview);
        
        const runtimeInfo = el('div', 'entity-info');
        runtimeInfo.style.flex = "1";
        runtimeInfo.style.minWidth = "0";
        runtimeInfo.style.borderLeft = "1px solid #444";
        runtimeInfo.style.paddingLeft = "8px";

        const runtimeLbl = el('div', 'entity-name');
        runtimeLbl.textContent = "Runtime";
        runtimeLbl.style.color = "#50fa7b";

        const runtimeVal = el('div', 'entity-id');
        runtimeVal.id = `runtime-var-${key}`;
        runtimeVal.textContent = _currentRuntimeVars && _currentRuntimeVars[key] !== undefined ? 
                                 String(_currentRuntimeVars[key]).substring(0,30) : "-";
        runtimeVal.style.color = "#f8f8f2";
        
        runtimeInfo.appendChild(runtimeLbl);
        runtimeInfo.appendChild(runtimeVal);

        row.appendChild(insertBtn);
        row.appendChild(info);
        row.appendChild(runtimeInfo);

        // Keep the detail dialog click handler on the info/row
        info.onclick = () => {
            showVariableEditor(key, vars[key]);
        };
        runtimeInfo.onclick = () => {
            showVariableEditor(key, _currentRuntimeVars && _currentRuntimeVars[key] !== undefined ? _currentRuntimeVars[key] : vars[key]);
        };

        insertBtn.onclick = (e) => {
            e.stopPropagation();
            insertVariableAtCursor(`{{ ${key} }}`);
        };

        container.appendChild(row);
    });
}

function discoverVariables(doc) {
    const vars = {};

    // 1. Top level
    if (doc.variables) {
        Object.assign(vars, doc.variables);
    }

    // 2. Recursive scan of sequence
    const scanSequence = (seq) => {
        if (!Array.isArray(seq)) return;
        seq.forEach(step => {
            if (step.variables) {
                Object.assign(vars, step.variables);
            }
            // Nested structures
            if (step.repeat?.sequence) scanSequence(step.repeat.sequence);
            if (step.parallel) {
                step.parallel.forEach(branch => {
                    if (Array.isArray(branch)) scanSequence(branch);
                    else if (branch.sequence) scanSequence(branch.sequence);
                });
            }
            if (step.choose) {
                step.choose.forEach(choice => scanSequence(choice.sequence));
                if (step.default) scanSequence(step.default);
            }
            if (step.if) {
                scanSequence(step.then);
                scanSequence(step.else);
            }
        });
    };

    scanSequence(doc.sequence);
    return vars;
}

export function insertVariableAtCursor(text) {
    // 1. Check if CodeMirror is focused (YAML Editor)
    if (_lastFocusedElement && (_lastFocusedElement.closest('.CodeMirror') || _lastFocusedElement.classList.contains('CodeMirror-code'))) {
        _editor.focus();
        const doc = _editor.getDoc();
        const cursor = doc.getCursor();
        doc.replaceRange(text, cursor);
        return;
    }

    // 2. Check for standard inputs (Node Editor)
    if (_lastFocusedElement && (_lastFocusedElement.tagName === 'INPUT' || _lastFocusedElement.tagName === 'TEXTAREA')) {
        const el = _lastFocusedElement;
        const start = el.selectionStart;
        const end = el.selectionEnd;
        const val = el.value;
        el.value = val.slice(0, start) + text + val.slice(end);
        el.selectionStart = el.selectionEnd = start + text.length;
        el.focus();

        // Trigger 'change' event for node editor sync
        el.dispatchEvent(new Event('change'));
    } else {
        // Fallback: Copy to clipboard and show toast
        navigator.clipboard.writeText(text);
        if (window.showToast) window.showToast(t('copied_to_clipboard'));
    }
}

function showVariableEditor(key, value) {
    // Create Modal
    const overlay = el('div', 'modal-overlay');
    overlay.style.display = 'flex';
    overlay.style.zIndex = '2000';

    const modal = el('div', 'modal-content');
    modal.style.width = '400px';
    modal.style.maxWidth = '90vw';

    const header = el('div', 'modal-header');
    header.innerHTML = `<h3>Edit Variable: ${key}</h3>`;
    const closeBtn = el('button', 'close-btn');
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = () => overlay.remove();
    header.appendChild(closeBtn);

    const body = el('div', 'modal-body');
    body.style.padding = '15px';

    const textarea = el('textarea', 'node-input');
    textarea.style.width = '100%';
    textarea.style.minHeight = '150px';
    textarea.style.fontFamily = 'monospace';
    textarea.style.fontSize = '12px';
    textarea.style.background = '#1a1a1a';
    textarea.style.color = '#bd93f9';
    textarea.value = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);

    const footer = el('div', 'modal-footer');
    footer.style.justifyContent = 'flex-end';
    footer.style.padding = '10px';
    footer.style.gap = '10px';

    const saveBtn = el('button', 'btn-header btn-start btn-var-save');
    saveBtn.textContent = 'Save Changes';
    saveBtn.style.width = 'auto';
    saveBtn.onclick = () => {
        let newVal = textarea.value.trim();
        // Try auto-parse
        if (newVal === 'true') newVal = true;
        else if (newVal === 'false') newVal = false;
        else if (!isNaN(parseFloat(newVal)) && String(parseFloat(newVal)) === newVal) newVal = parseFloat(newVal);
        else if ((newVal.startsWith('[') && newVal.endsWith(']')) || (newVal.startsWith('{') && newVal.endsWith('}'))) {
            try { newVal = JSON.parse(newVal); } catch (e) { }
        }

        let docObj;
        try {
            docObj = jsyaml.load(_editor.getValue()) || {};
        } catch(e) {
            docObj = _currentDoc || {};
        }
        
        updateVariableInDoc(docObj, key, newVal);
        
        const yaml = jsyaml.dump(docObj, { lineWidth: 120, noRefs: true });
        _editor.setValue(yaml);
        
        if (document.getElementById('view-nodes').classList.contains('active')) {
             syncYamlToNodes();
        }
        overlay.remove();
    };

    footer.appendChild(saveBtn);
    modal.appendChild(header);
    modal.appendChild(body);
    body.appendChild(textarea);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
}

function updateVariableInDoc(doc, key, newVal) {
    if (!doc) return;
    // Recursive search and replace
    if (doc.variables && doc.variables[key] !== undefined) {
        doc.variables[key] = newVal;
    }

    const scan = (seq) => {
        if (!Array.isArray(seq)) return;
        seq.forEach(step => {
            if (step.variables && step.variables[key] !== undefined) {
                step.variables[key] = newVal;
            }
            if (step.repeat?.sequence) scan(step.repeat.sequence);
            if (step.parallel) {
                step.parallel.forEach(b => {
                    if (Array.isArray(b)) scan(b);
                    else if (b.sequence) scan(b.sequence);
                });
            }
            if (step.choose) {
                step.choose.forEach(c => scan(c.sequence));
                if (step.default) scan(step.default);
            }
            if (step.if) {
                scan(step.then);
                scan(step.else);
            }
        });
    };
    scan(doc.sequence);
}

function rgbToHs(rgb) {
    let r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    let max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, v = max;
    let d = max - min;
    s = max === 0 ? 0 : d / max;
    if (max === min) h = 0;
    else {
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    return [Math.round(h * 360), Math.round(s * 100)];
}

function hsToRgb(hs) {
    let h = hs[0] / 360, s = hs[1] / 100, v = 1.0; // Use full brightness for pure chromaticity
    let r, g, b;
    let i = Math.floor(h * 6);
    let f = h * 6 - i;
    let p = v * (1 - s);
    let q = v * (1 - f * s);
    let t = v * (1 - (1 - f) * s);
    switch (i % 6) {
        case 0: r = v, g = t, b = p; break;
        case 1: r = q, g = v, b = p; break;
        case 2: r = p, g = v, b = t; break;
        case 3: r = p, g = q, b = v; break;
        case 4: r = t, g = p, b = v; break;
        case 5: r = v, g = p, b = q; break;
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function rgbToXy(rgb) {
    let r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    // Gamma correction
    r = (r > 0.04045) ? Math.pow((r + 0.055) / 1.055, 2.4) : (r / 12.92);
    g = (g > 0.04045) ? Math.pow((g + 0.055) / 1.055, 2.4) : (g / 12.92);
    b = (b > 0.04045) ? Math.pow((b + 0.055) / 1.055, 2.4) : (b / 12.92);

    let X = r * 0.4124 + g * 0.3576 + b * 0.1805;
    let Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    let Z = r * 0.0193 + g * 0.1192 + b * 0.9505;

    let sum = X + Y + Z;
    if (sum === 0) return [0.3127, 0.329]; // D65 white point

    let x = X / sum;
    let y = Y / sum;
    return [parseFloat(x.toFixed(4)), parseFloat(y.toFixed(4))];
}

function xyToRgb(xy) {
    let x = xy[0], y = xy[1];
    let z = 1.0 - x - y;
    let Y = 1.0;
    let X = (Y / y) * x;
    let Z = (Y / y) * z;

    // Reverse transformation
    let r = X * 3.2406 - Y * 1.5372 - Z * 0.4986;
    let g = -X * 0.9689 + Y * 1.8758 + Z * 0.0415;
    let b = X * 0.0557 - Y * 0.2040 + Z * 1.0570;

    // Normalize if any component > 1.0
    let max = Math.max(r, g, b);
    if (max > 1.0) {
        r /= max; g /= max; b /= max;
    }

    // Reverse Gamma
    r = r <= 0.0031308 ? 12.92 * r : 1.055 * Math.pow(r, (1.0 / 2.4)) - 0.055;
    g = g <= 0.0031308 ? 12.92 * g : 1.055 * Math.pow(g, (1.0 / 2.4)) - 0.055;
    b = b <= 0.0031308 ? 12.92 * b : 1.055 * Math.pow(b, (1.0 / 2.4)) - 0.055;

    return [
        Math.max(0, Math.min(255, Math.round(r * 255))),
        Math.max(0, Math.min(255, Math.round(g * 255))),
        Math.max(0, Math.min(255, Math.round(b * 255)))
    ];
}

function hexToRgb(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return [r, g, b];
}

function rgbToHex(rgb) {
    if (!Array.isArray(rgb) || rgb.length !== 3) return '#ffffff';
    return '#' + rgb.map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
}

export function getCurrentRuntimeVars() {
    return _currentRuntimeVars;
}

export function getCurrentDoc() {
    return _currentDoc;
}

export function setCurrentDoc(doc) {
    // During pushToYaml the editor fires a change event synchronously.
    // Overwriting _currentDoc here would break all live object references
    // held by rendered node fields, causing subsequent edits to be lost.
    if (_isSyncing) return;
    _currentDoc = doc;
    if (_currentDoc) assignPaths(_currentDoc);
}

export function highlightExecutingNode(path) {
    // Clear old highlight
    document.querySelectorAll('.node-item.is-executing').forEach(n => n.classList.remove('is-executing'));
    
    if (!path) return;

    // Find node with matching path
    const node = document.querySelector(`.node-item[data-path="${path}"]`);
    if (node) {
        node.classList.add('is-executing');
        node.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    }
}

document.addEventListener('mousemove', (e) => {
    const tooltip = document.getElementById('template-tooltip');
    if (!tooltip) return;

    let target = e.target;
    
    // Check if we are hovering the field itself (which should be enabled)
    // or an input inside it
    if (target && (target.classList.contains('node-field') || target.classList.contains('node-field-smart'))) {
        target = target.querySelector('input, textarea');
    }

    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        const val = target.value;
        if (typeof val === 'string' && val.includes('{{')) {
            try {
                const resolved = resolveTemplate(val, _currentRuntimeVars);
                let repeatText = "";
                if (_currentRuntimeVars && _currentRuntimeVars.repeat) {
                    const idx = (_currentRuntimeVars.repeat.index !== undefined) ? (_currentRuntimeVars.repeat.index + 1) : "?";
                    repeatText = `[Iter: ${idx}] `;
                }

                if (String(resolved) !== String(val)) {
                    tooltip.textContent = `↳ ${repeatText}${typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved)}`;
                } else {
                    tooltip.textContent = `↳ ${repeatText}(Vorschau: Keine Laufzeitdaten)`;
                }
                tooltip.style.display = 'block';
                
                // Keep within viewport bounds
                let x = e.clientX + 15;
                let y = e.clientY + 15;
                tooltip.style.left = x + 'px';
                tooltip.style.top = y + 'px';
                return;
            } catch(err) {}
        }
    }
    tooltip.style.display = 'none';
});

// Interaction blocking handled via CSS pointer-events: none on inputs
// but allowing it on .node-field for tooltips.

