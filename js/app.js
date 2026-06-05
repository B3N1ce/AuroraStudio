// js/app.js

import { initEntityManager, updateLampEntities, resetLamps, hasModifiedLamps, setColorCurve, resizeCanvas, resetSimView, toggleLabels, setBackgroundImage, toggleEntities, getEntitiesVisible, getLabelsVisible, setLightInfluence, getLightInfluence, setBlendMode, getBlendMode, setAmbientLevel, getAmbientLevel, setExposure, getExposure, hasBackgroundImage, setOnBackgroundChange, getDebugStats } from './entityManager.js';
import { ColorPicker } from './colorPicker.js';
import { startSimulation, stopSimulation, pauseSimulation, resumeSimulation, setVarUpdateCallback, toggleBreakpoint, breakpoints, getSimElapsedMs, isSimRunning } from './simulator.js';
import { initTimelineEditor, syncYamlToTimeline, startTimelineCursor, resetTimelineState, clearTimelineCursor } from './timelineEditor.js';
import { t, setLang, getLang, applyTranslations } from './i18n.js';
import { initNodeEditor, syncYamlToNodes, updateVariablePanel, updateRuntimeVariablesUI, resetRuntimeVariablesUI, getCurrentRuntimeVars, getCurrentDoc, assignPaths, setCurrentDoc, highlightExecutingNode } from './nodeEditor.js';
import { resolveTemplate } from './templateEngine.js';
import { initLibraryPanel } from './libraryPanel.js';

let isPlaying = false;
let isPausedState = false;
let _simMinRunTimer = null;
const SIM_MIN_RUN_MS = 500;
const _tooltipCache = new Map(); // caches resolved random-template values during a simulation run
let editor;
let colorPicker;
let activeLineHandle = null;

const toggleBtn = document.getElementById('toggle-btn');
const stopBtn = document.getElementById('stop-btn');
const btnValidate = document.getElementById('btn-validate');
const room = document.getElementById('room');
const btnColorCurve = document.getElementById('btn-color-curve');
const btnCopyCode = document.getElementById('btn-copy-code');

const COLOR_CURVE_ICONS = {
    linear:  `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2" y1="12" x2="12" y2="2"/></svg>`,
    srgb:    `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 12 C5 12 9 2 12 2"/></svg>`,
    gamma22: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 12 C4 11 7 3 12 2"/></svg>`,
    gamma28: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 12 C2 10 3 2 12 2"/></svg>`,
    cie:     `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M1 7 C3 3 11 3 13 7 C11 11 3 11 1 7 Z"/><circle cx="7" cy="7" r="2"/></svg>`,
};
const BLEND_MODE_ICONS = {
    'multiply-glow': `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="2.5"/><line x1="7" y1="1" x2="7" y2="3.5"/><line x1="7" y1="10.5" x2="7" y2="13"/><line x1="1" y1="7" x2="3.5" y2="7"/><line x1="10.5" y1="7" x2="13" y2="7"/><line x1="3" y1="3" x2="4.2" y2="4.2"/><line x1="9.8" y1="9.8" x2="11" y2="11"/><line x1="11" y1="3" x2="9.8" y2="4.2"/><line x1="4.2" y1="9.8" x2="3" y2="11"/></svg>`,
    'multiply': `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="5" cy="7" r="3.5"/><circle cx="9" cy="7" r="3.5"/></svg>`,
    'overlay': `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="4" width="8" height="7" rx="1"/><rect x="5" y="2" width="8" height="7" rx="1"/></svg>`,
    'color-dodge': `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 1 L8.3 5.5 L13 7 L8.3 8.5 L7 13 L5.7 8.5 L1 7 L5.7 5.5 Z"/></svg>`,
};

function setColorCurveUI(val) {
    if (btnColorCurve) btnColorCurve.innerHTML = COLOR_CURVE_ICONS[val] || COLOR_CURVE_ICONS.srgb;
    document.querySelectorAll('#color-curve-menu .dropdown-item').forEach(item => {
        item.classList.toggle('active', item.dataset.value === val);
    });
}
function setBlendModeUI(val) {
    const btn = document.getElementById('btn-blend-mode');
    if (btn) btn.innerHTML = BLEND_MODE_ICONS[val] || BLEND_MODE_ICONS['multiply-glow'];
    document.querySelectorAll('#blend-mode-menu .dropdown-item').forEach(item => {
        item.classList.toggle('active', item.dataset.value === val);
    });
}
const btnSaveCode = document.getElementById('btn-save-code');
const toastContainer = document.getElementById('toast-container');

const btnNotifications = document.getElementById('btn-notifications');
const notifModal = document.getElementById('notif-modal');
const btnCloseNotifs = document.getElementById('btn-close-notifs');
const btnClearNotifs = document.getElementById('btn-clear-notifs');
const notifBadge = document.getElementById('notif-badge');
const notifList = document.getElementById('notif-list');

let notifications = [];

let labelsVisible = true;

function updateNotifUI() {
    if (notifications.length > 0) {
        notifBadge.style.display = 'block';
        notifBadge.innerText = notifications.length;
    } else {
        notifBadge.style.display = 'none';
    }

    notifList.innerHTML = '';
    if (notifications.length === 0) {
        notifList.innerHTML = `<div style="color: #888; text-align: center; padding: 20px;">${t('no_messages')}</div>`;
        return;
    }

    notifications.forEach(n => {
        const div = document.createElement('div');
        div.className = `notif-item ${n.type}`;
        div.innerHTML = `
            <button class="notif-delete" data-id="${n.id}">&times;</button>
            <div class="notif-time">${n.time}</div>
            <div class="notif-text">${n.msg}</div>
        `;
        notifList.appendChild(div);
    });

    document.querySelectorAll('.notif-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = parseInt(e.target.dataset.id);
            notifications = notifications.filter(n => n.id !== id);
            updateNotifUI();
        });
    });
}

let colorMarks = [];
function updateColorPreviews(cm) {
    colorMarks.forEach(m => m.clear());
    colorMarks = [];

    const doc = cm.getDoc();
    const rgbRegex = /\[\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\]/g;

    for (let i = 0; i < doc.lineCount(); i++) {
        const text = doc.getLine(i);
        let match;
        while ((match = rgbRegex.exec(text)) !== null) {
            const r = parseInt(match[1]);
            const g = parseInt(match[2]);
            const b = parseInt(match[3]);
            if (r <= 255 && g <= 255 && b <= 255) {
                const marker = document.createElement('span');
                marker.style.display = 'inline-block';
                marker.style.width = '12px';
                marker.style.height = '12px';
                marker.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
                marker.style.border = '1px solid #000';
                marker.style.marginRight = '6px';
                marker.style.verticalAlign = 'middle';
                marker.style.borderRadius = '2px';
                marker.style.boxShadow = '0 0 2px rgba(0,0,0,0.5)';
                marker.title = `RGB: ${r}, ${g}, ${b}`;

                const mark = doc.setBookmark({ line: i, ch: match.index }, {
                    widget: marker,
                    insertLeft: true
                });
                colorMarks.push(mark);
            }
        }
    }
}

function init() {
    const appContainer = document.getElementById('app-container');
    const resizerLeft = document.getElementById('resizer-left');
    const resizerRight = document.getElementById('resizer-right');

    // 1. Init CodeMirror
    editor = CodeMirror.fromTextArea(document.getElementById('code-editor'), {
        mode: 'yaml',
        theme: 'dracula',
        lineNumbers: true,
        gutters: ["CodeMirror-linenumbers", "breakpoints"],
        tabSize: 2,
        extraKeys: {
            "Tab": function (cm) {
                if (cm.somethingSelected()) {
                    cm.indentSelection("add");
                } else {
                    cm.replaceSelection("  ", "end");
                }
            },
            "Shift-Tab": function (cm) {
                cm.indentSelection("subtract");
            }
        }
    });

    // 1.1 Persistenz: Gespeichertes Skript laden
    const savedScript = localStorage.getItem('ha_animation_script');
    if (savedScript) {
        editor.setValue(savedScript);
    }

    // 1.2 Persistenz: Layout laden (Bereits oben initialisiert)

    // 1.3 Persistenz: Farbraum laden
    // Migration: old 'linear' was sRGB decode, now renamed to 'srgb'
    let savedCurve = localStorage.getItem('ha_simulator_color_curve') || 'srgb';
    if (savedCurve === 'linear' && !localStorage.getItem('ha_simulator_curve_migrated')) {
        savedCurve = 'srgb';
        localStorage.setItem('ha_simulator_color_curve', 'srgb');
        localStorage.setItem('ha_simulator_curve_migrated', '1');
    }
    setColorCurve(savedCurve);
    setColorCurveUI(savedCurve);

    // 1.4 Persistenz: Mischmodus laden
    const savedBlendMode = localStorage.getItem('ha_simulator_blend_mode') || 'multiply-glow';
    setBlendMode(savedBlendMode);
    setBlendModeUI(savedBlendMode);

    // Fix: Remove trailing newlines on paste (avoids issues on some mobile devices/HASS copy)
    editor.on('paste', (cm, e) => {
        const text = e.clipboardData.getData('text/plain');
        if (text && text.endsWith('\n')) {
            e.preventDefault();
            const trimmed = text.trimEnd();
            cm.replaceSelection(trimmed);
        }
    });

    // 2. Init Color Picker
    colorPicker = new ColorPicker(editor);

    // 3. Init Node Editor
    initNodeEditor(editor);

    // 3b. Init Timeline Editor
    initTimelineEditor(editor);

    // 3c. Init Library Panel
    initLibraryPanel({
        getEditorValue: () => editor.getValue(),
        setEditorValue: (v) => { editor.setValue(v); localStorage.setItem('ha_animation_script', v); },
        validateAndSync,
        isPlaying: () => isPlaying,
        resetSim: () => { resetLamps(); resetTimelineState(); resetRuntimeVariablesUI(); },
    });

    // 4. Set Runtime Variable Callback
    setVarUpdateCallback(updateRuntimeVariablesUI);

    // Initial call
    updateColorPreviews(editor);

    editor.on("gutterClick", (cm, n) => {
        const result = mapLineToPath(cm, n);

        if (!result || !result.path) {
            showToast("Kein gültiger Breakpoint-Schritt gefunden.", "warning");
            return;
        }

        toggleBreakpoint(result.path);
        refreshBreakpointMarkers();

        // Push the state to node editor to update its buttons visually
        syncYamlToNodes();
    });

    function resolveTemplateForTooltip(templateStr, vars) {
        if (!/\|\s*random/.test(templateStr)) {
            return resolveTemplate(templateStr, vars);
        }
        if (!isSimRunning()) {
            // Show what the possible values are instead of picking one
            const listMatch = templateStr.match(/\{\{\s*(\[[\s\S]*?\])\s*\|\s*random\s*\}\}/);
            if (listMatch) return `Zufällig aus: ${listMatch[1]}`;
            const rangeMatch = templateStr.match(/\{\{\s*range\((\d+),\s*(\d+)\)\s*\|\s*random\s*\}\}/);
            if (rangeMatch) return `Zufällig: ${rangeMatch[1]}–${parseInt(rangeMatch[2]) - 1}`;
            return '(Zufallswert)';
        }
        // During simulation: evaluate once and cache so the value stays stable
        if (!_tooltipCache.has(templateStr)) {
            _tooltipCache.set(templateStr, resolveTemplate(templateStr, vars));
        }
        return _tooltipCache.get(templateStr);
    }

    // Template Resolution Hover & Gutter Highlighting
    document.addEventListener('mousemove', (e) => {
        // Only if YAML view is active
        const yamlView = document.getElementById('view-yaml');
        if (!yamlView || !yamlView.classList.contains('active')) return;

        // Clear all previous force-hovers
        document.querySelectorAll('.breakpoint-hint.force-hover').forEach(el => el.classList.remove('force-hover'));

        const tooltip = document.getElementById('template-tooltip');
        if (!tooltip) return;

        const vars = getCurrentRuntimeVars() || {};

        // Check if mouse is over the editor
        const wrapper = editor.getWrapperElement();
        const rect = wrapper.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
            tooltip.style.display = 'none';
            return;
        }

        const pos = editor.coordsChar({ left: e.clientX, top: e.clientY }, "window");

        // 1. Gutter Parent Highlighting
        const mapResult = mapLineToPath(editor, pos.line);
        if (mapResult && mapResult.line !== undefined) {
            const info = editor.lineInfo(mapResult.line);
            if (info && info.gutterMarkers && info.gutterMarkers.breakpoints) {
                info.gutterMarkers.breakpoints.classList.add('force-hover');
            }
        }

        // 2. Tooltip Logic
        const line = editor.getLine(pos.line);
        if (line && line.includes('{{')) {
            const regex = /\{\{.*?\}\}/g;
            let match;
            let found = false;
            while ((match = regex.exec(line)) !== null) {
                if (pos.ch >= match.index && pos.ch <= match.index + match[0].length) {
                    try {
                        const resolved = resolveTemplateForTooltip(match[0], vars);
                        let repeatText = "";
                        if (vars.repeat) {
                            const idx = (vars.repeat.index !== undefined) ? (vars.repeat.index + 1) : "?";
                            repeatText = `[Iter: ${idx}] `;
                        }

                        if (String(resolved) !== String(match[0])) {
                            tooltip.textContent = `↳ ${repeatText}${typeof resolved === 'object' ? JSON.stringify(resolved) : String(resolved)}`;
                        } else {
                            tooltip.textContent = `↳ ${repeatText}(Vorschau: Keine Laufzeitdaten)`;
                        }
                        tooltip.style.display = 'block';
                        tooltip.style.left = (e.clientX + 15) + 'px';
                        tooltip.style.top = (e.clientY + 15) + 'px';
                        found = true;
                        break;
                    } catch (err) { }
                }
            }
            if (found) return;
        }
        tooltip.style.display = 'none';
    });

    // Tab switching
    document.querySelectorAll('#panel-editor .panel-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            // Commit any in-progress field edit before switching views
            if (document.activeElement && document.activeElement !== document.body) {
                document.activeElement.blur();
            }
            document.querySelectorAll('#panel-editor .panel-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.editor-view').forEach(v => v.classList.remove('active'));
            tab.classList.add('active');
            const view = document.getElementById('view-' + tab.dataset.tab);
            if (view) view.classList.add('active');
            if (tab.dataset.tab === 'yaml') {
                editor.refresh();
                refreshBreakpointMarkers();
            } else if (tab.dataset.tab === 'nodes') {
                syncYamlToNodes();
            } else if (tab.dataset.tab === 'timeline') {
                const _tlDoc = getCurrentDoc();
                if (_tlDoc) syncYamlToTimeline(_tlDoc);
            } else if (tab.dataset.tab === 'library') {
                // Re-draw canvases now that the view has layout width
                document.querySelectorAll('#library-grid .lib-mini-timeline').forEach(canvas => {
                    canvas.dispatchEvent(new CustomEvent('lib-redraw'));
                });
            }
        });
    });

    document.addEventListener('breakpointsChanged', () => {
        refreshBreakpointMarkers();
    });

    // Initial apply translations
    applyTranslations();

    // 3. Init Entity Manager
    initEntityManager((entityId, bgColor) => {
        // Wenn eine Lampe angeklickt wird, füttere die Farbe in den Color Picker
        colorPicker.setColorFromExternal(bgColor);
    }, {
        getEditorValue: () => editor.getValue(),
        setEditorValue: (v) => { editor.setValue(v); localStorage.setItem('ha_animation_script', v); },
        isPlaying: () => isPlaying,
    });

    // 4. Desktop Resizer Logic
    // Fix initial layout glitch by setting explicit columns
    if (window.innerWidth > 900) {
        const savedLayout = localStorage.getItem('ha_simulator_layout');
        appContainer.style.gridTemplateColumns = savedLayout || "350px 8px 1fr 8px 320px";

        // WICHTIG: Canvas nach Layout-Wiederherstellung neu berechnen
        setTimeout(resetSimView, 50);
    }

    let isResizingLeft = false;
    let isResizingRight = false;

    if (resizerLeft) {
        resizerLeft.addEventListener('mousedown', (e) => {
            isResizingLeft = true;
            resizerLeft.classList.add('dragging');
            e.preventDefault();
        });
    }

    if (resizerRight) {
        resizerRight.addEventListener('mousedown', (e) => {
            isResizingRight = true;
            resizerRight.classList.add('dragging');
            e.preventDefault();
        });
    }

    document.addEventListener('mousemove', (e) => {
        if (!isResizingLeft && !isResizingRight) return;

        const containerRect = appContainer.getBoundingClientRect();
        const cols = window.getComputedStyle(appContainer).gridTemplateColumns.split(' ');
        let leftW = parseFloat(cols[0]);
        let rightW = parseFloat(cols[4]);

        if (isResizingLeft) {
            let newLeftW = e.clientX - containerRect.left;
            newLeftW = Math.max(200, Math.min(newLeftW, containerRect.width - rightW - 100));
            appContainer.style.gridTemplateColumns = `${newLeftW}px 8px 1fr 8px ${rightW}px`;
            editor.refresh();
            resetSimView();
        } else if (isResizingRight) {
            let newRightW = containerRect.right - e.clientX;
            newRightW = Math.max(200, Math.min(newRightW, containerRect.width - leftW - 100));
            appContainer.style.gridTemplateColumns = `${leftW}px 8px 1fr 8px ${newRightW}px`;
            resetSimView();
        }
    });

    document.addEventListener('mouseup', () => {
        if (isResizingLeft) resizerLeft.classList.remove('dragging');
        if (isResizingRight) resizerRight.classList.remove('dragging');
        if (isResizingLeft || isResizingRight) {
            // Layout speichern
            localStorage.setItem('ha_simulator_layout', appContainer.style.gridTemplateColumns);
        }
        isResizingLeft = false;
        isResizingRight = false;
    });

    // 5. Mobile Tabs Logic
    document.querySelectorAll('.mobile-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.mobile-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));

            tab.classList.add('active');
            const targetId = tab.dataset.target;
            document.getElementById(targetId).classList.add('active');

            if (targetId === 'panel-editor') {
                setTimeout(() => editor.refresh(), 50);
            }
        });
    });

    // 5. Editor Change Event
    editor.on('change', () => {
        updateColorPreviews(editor);
        if (!isPlaying) {
            validateAndSync();
        }
        // Persistenz: Script speichern
        localStorage.setItem('ha_animation_script', editor.getValue());
    });

    // Helper: position a fixed dropdown below its trigger button (right-aligned to button)
    function positionDropdown(triggerBtn, menu) {
        const rect = triggerBtn.getBoundingClientRect();
        menu.style.top = (rect.bottom + 4) + 'px';
        menu.style.left = 'auto';
        menu.style.right = (window.innerWidth - rect.right) + 'px';
    }

    // Close all dropdown menus
    function closeAllMenus() {
        document.querySelectorAll('.dropdown-menu.active').forEach(m => m.classList.remove('active'));
    }

    // Toggle a single menu, closing all others first
    function toggleDropdown(e, triggerBtn, menu) {
        e.stopPropagation();
        const isOpen = menu.classList.contains('active');
        closeAllMenus();
        if (!isOpen) {
            menu.classList.add('active');
            positionDropdown(triggerBtn, menu);
        }
    }

    // Single global handler: close all menus on outside click
    document.addEventListener('click', closeAllMenus);

    // 6. New Script Dropdown Logic
    const btnNewScript = document.getElementById('btn-new-script');
    const newScriptMenu = document.getElementById('new-script-menu');

    const SCRIPT_TEMPLATES = {
        scratch: [
            'alias: New Animation',
            'description: "Clean slate"',
            'mode: single',
            'sequence: []',
        ].join('\n'),

        tpl_beginner: [
            'alias: Erste Schritte',
            'description: "Eine Lampe einschalten"',
            'mode: single',
            'sequence:',
            '  - action: light.turn_on',
            '    target:',
            '      entity_id: light.living_room',
            '    data:',
            '      rgb_color: [98, 160, 234]',
            '      brightness_pct: 80',
            '      transition: 1',
        ].join('\n'),

        tpl_sequence: [
            'alias: Farbwechsel',
            'description: "Drei Farben nacheinander mit Delay"',
            'mode: single',
            'sequence:',
            '  - action: light.turn_on',
            '    target:',
            '      entity_id: light.living_room',
            '    data:',
            '      rgb_color: [98, 160, 234]',
            '      brightness_pct: 80',
            '      transition: 2',
            '  - delay:',
            '      seconds: 2',
            '  - action: light.turn_on',
            '    target:',
            '      entity_id: light.living_room',
            '    data:',
            '      rgb_color: [234, 98, 98]',
            '      brightness_pct: 60',
            '      transition: 2',
            '  - delay:',
            '      seconds: 2',
            '  - action: light.turn_on',
            '    target:',
            '      entity_id: light.living_room',
            '    data:',
            '      rgb_color: [98, 210, 140]',
            '      brightness_pct: 100',
            '      transition: 2',
        ].join('\n'),

        tpl_parallel: [
            'alias: Parallele Lampen',
            'description: "Zwei Lampen gleichzeitig animieren"',
            'mode: single',
            'sequence:',
            '  - parallel:',
            '    - sequence:',
            '      - action: light.turn_on',
            '        target:',
            '          entity_id: light.living_room',
            '        data:',
            '          rgb_color: [98, 160, 234]',
            '          brightness_pct: 100',
            '          transition: 2',
            '      - delay:',
            '          seconds: 2',
            '      - action: light.turn_on',
            '        target:',
            '          entity_id: light.living_room',
            '        data:',
            '          rgb_color: [234, 120, 80]',
            '          brightness_pct: 70',
            '          transition: 3',
            '    - sequence:',
            '      - delay:',
            '          seconds: 1',
            '      - action: light.turn_on',
            '        target:',
            '          entity_id: light.bedroom',
            '        data:',
            '          rgb_color: [160, 80, 234]',
            '          brightness_pct: 60',
            '          transition: 2',
        ].join('\n'),

        tpl_repeat: [
            'alias: Atemeffekt',
            'description: "Sanftes Pulsieren, 4 Wiederholungen"',
            'mode: single',
            'sequence:',
            '  - repeat:',
            '      count: 4',
            '      sequence:',
            '        - action: light.turn_on',
            '          target:',
            '            entity_id: light.living_room',
            '          data:',
            '            rgb_color: [98, 160, 234]',
            '            brightness_pct: 100',
            '            transition: 1.5',
            '        - delay:',
            '            seconds: 1.5',
            '        - action: light.turn_on',
            '          target:',
            '            entity_id: light.living_room',
            '          data:',
            '            rgb_color: [98, 160, 234]',
            '            brightness_pct: 5',
            '            transition: 1.5',
            '        - delay:',
            '            seconds: 1.5',
        ].join('\n'),

        tpl_choose: [
            'alias: Tageszeit-Stimmung',
            'description: "Farbe abhängig von Variable wählen"',
            'mode: single',
            'variables:',
            '  stimmung: entspannt',
            'sequence:',
            '  - choose:',
            '    - conditions:',
            '        - condition: template',
            '          value_template: "{{ stimmung == \'aktiv\' }}"',
            '      sequence:',
            '        - action: light.turn_on',
            '          target:',
            '            entity_id: light.living_room',
            '          data:',
            '            rgb_color: [255, 240, 180]',
            '            brightness_pct: 100',
            '            transition: 1',
            '    - conditions:',
            '        - condition: template',
            '          value_template: "{{ stimmung == \'entspannt\' }}"',
            '      sequence:',
            '        - action: light.turn_on',
            '          target:',
            '            entity_id: light.living_room',
            '          data:',
            '            rgb_color: [234, 100, 60]',
            '            brightness_pct: 35',
            '            transition: 2',
            '    default:',
            '      - action: light.turn_on',
            '        target:',
            '          entity_id: light.living_room',
            '        data:',
            '          rgb_color: [98, 160, 234]',
            '          brightness_pct: 50',
            '          transition: 1',
        ].join('\n'),
    };

    if (btnNewScript && newScriptMenu) {
        btnNewScript.addEventListener('click', (e) => toggleDropdown(e, btnNewScript, newScriptMenu));

        newScriptMenu.querySelectorAll('.dropdown-item').forEach(item => {
            item.addEventListener('click', () => {
                const action = item.dataset.action;
                const content = SCRIPT_TEMPLATES[action];
                newScriptMenu.classList.remove('active');
                if (content !== undefined) {
                    showConfirmModal({
                        title: t('new_script'),
                        message: t('confirm_new_script'),
                        confirmLabel: t('lib_overwrite'),
                        onConfirm: () => {
                            editor.setValue(content);
                            localStorage.setItem('ha_animation_script', content);
                            localStorage.removeItem('ha_simulator_breakpoints');
                            if (breakpoints) breakpoints.clear();
                            refreshBreakpointMarkers();
                            if (typeof validateAndSync === 'function') validateAndSync();
                            const activeTab = document.querySelector('#panel-editor .panel-tab.active');
                            if (activeTab && activeTab.dataset.tab === 'nodes') syncYamlToNodes();
                            resetTimelineState();
                            if (activeTab && activeTab.dataset.tab === 'timeline') { const _d = getCurrentDoc(); if (_d) syncYamlToTimeline(_d); }
                            showToast(t('new_script_created') || "Neues Skript erstellt", "success");
                        }
                    });
                }
            });
        });
    }

    // 6. Toggle Play/Stop/Pause
    function setUIRunning(running, paused = false) {
        isPlaying = running;
        isPausedState = paused;
        editor.setOption('readOnly', running);

        if (running) document.body.classList.add('simulation-running');
        else document.body.classList.remove('simulation-running');

        const wrapper = editor.getWrapperElement();
        if (running) {
            wrapper.classList.add('disabled-dim');
            toggleBtn.innerHTML = paused ? t('resume') : t('pause');
            toggleBtn.className = 'btn-header btn-pause-style';

            stopBtn.innerHTML = t('stop');
            stopBtn.className = 'btn-header btn-stop-style';
            stopBtn.disabled = false;
            stopBtn.classList.remove('btn-disabled');
            if (btnNewScript) { btnNewScript.disabled = true; btnNewScript.classList.add('btn-disabled'); }
        } else {
            wrapper.classList.remove('disabled-dim');
            toggleBtn.innerHTML = t('start');
            toggleBtn.className = 'btn-header btn-start';

            stopBtn.innerHTML = t('reset');
            stopBtn.className = 'btn-header btn-reset-style';

            // Reset Button nur aktivieren wenn Lampen modifiziert sind
            const canReset = hasModifiedLamps();
            stopBtn.disabled = !canReset;
            if (canReset) stopBtn.classList.remove('btn-disabled');
            else stopBtn.classList.add('btn-disabled');
            if (btnNewScript) { btnNewScript.disabled = false; btnNewScript.classList.remove('btn-disabled'); }
        }
    }

    window.onBreakpointHit = (path) => {
        setUIRunning(true, true);
        showToast(`Breakpoint erreicht: ${path}`, 'info');
        highlightExecutingNode(path);
        highlightLineByPath(path);
    };

    toggleBtn.addEventListener('click', () => {
        if (isPlaying) {
            // Wenn es läuft, dann Pause/Resume
            if (isPausedState) {
                highlightExecutingNode(null);
                highlightLineByPath(null);
                resumeSimulation();
                setUIRunning(true, false);
            } else {
                pauseSimulation();
                setUIRunning(true, true);
            }
            return;
        }

        const doc = validateAndSync();
        if (!doc) return;

        resetRuntimeVariablesUI();
        setUIRunning(true, false);

        // Start timeline cursor if timeline tab is active
        const _atSim = document.querySelector('#panel-editor .panel-tab.active');
        if (_atSim && _atSim.dataset.tab === 'timeline') startTimelineCursor();

        _tooltipCache.clear();
        const _simStart = Date.now();
        startSimulation(doc, () => {
            const delay = Math.max(0, SIM_MIN_RUN_MS - (Date.now() - _simStart));
            _simMinRunTimer = setTimeout(() => {
                _simMinRunTimer = null;
                setUIRunning(false, false);
            }, delay);
        }, (err) => {
            if (_simMinRunTimer) { clearTimeout(_simMinRunTimer); _simMinRunTimer = null; }
            showToast(t('script_error') + err.message, 'error');
            setUIRunning(false, false);
        });
    });

    stopBtn.addEventListener('click', () => {
        if (_simMinRunTimer) { clearTimeout(_simMinRunTimer); _simMinRunTimer = null; }
        if (isPlaying || isPausedState) {
            stopSimulation();
            setUIRunning(false, false);
            highlightExecutingNode(null);
            highlightLineByPath(null);
        } else {
            resetLamps();
            resetRuntimeVariablesUI();
            clearTimelineCursor();
            setUIRunning(false, false);
        }
    });

    // 7. Standalone YAML Validate
    btnValidate.addEventListener('click', () => {
        const code = editor.getValue();
        if (!code.trim()) {
            showToast(t('enter_code'), 'error');
            return;
        }
        try {
            jsyaml.load(code);
            showToast(t('yaml_correct'), 'success');
        } catch (e) {
            showToast(t('yaml_error') + e.message, 'error');
        }
    });

    // 8. Color Curve Dropdown
    const colorCurveMenu = document.getElementById('color-curve-menu');
    if (btnColorCurve && colorCurveMenu) {
        btnColorCurve.addEventListener('click', (e) => toggleDropdown(e, btnColorCurve, colorCurveMenu));
        colorCurveMenu.querySelectorAll('.dropdown-item').forEach(item => {
            item.addEventListener('click', () => {
                const val = item.dataset.value;
                setColorCurve(val);
                setColorCurveUI(val);
                localStorage.setItem('ha_simulator_color_curve', val);
                if (!isPlaying) validateAndSync();
            });
        });
    }

    // 8.1 Blend Mode Dropdown
    const btnBlendMode = document.getElementById('btn-blend-mode');
    const blendModeMenu = document.getElementById('blend-mode-menu');
    if (btnBlendMode && blendModeMenu) {
        btnBlendMode.addEventListener('click', (e) => toggleDropdown(e, btnBlendMode, blendModeMenu));
        blendModeMenu.querySelectorAll('.dropdown-item').forEach(item => {
            item.addEventListener('click', () => {
                const val = item.dataset.value;
                setBlendMode(val);
                setBlendModeUI(val);
                localStorage.setItem('ha_simulator_blend_mode', val);
                if (!isPlaying) validateAndSync();
            });
        });
    }

    // 9. Copy & Save
    btnCopyCode.addEventListener('click', () => {
        navigator.clipboard.writeText(editor.getValue()).then(() => {
            showToast(t('code_copied'), 'success');
        });
    });

    // 10. Label Toggle
    const btnToggleLabels = document.getElementById('btn-toggle-labels');
    if (btnToggleLabels) {
        btnToggleLabels.style.color = getLabelsVisible() ? '#f8f8f2' : '#555';
        btnToggleLabels.addEventListener('click', () => {
            const isVisible = toggleLabels();
            btnToggleLabels.style.color = isVisible ? '#f8f8f2' : '#555';
        });
    }

    // 10.1 Entity Visibility Toggle
    const btnToggleEntities = document.getElementById('btn-toggle-entities');
    if (btnToggleEntities) {
        btnToggleEntities.style.color = getEntitiesVisible() ? '#f8f8f2' : '#555';
        btnToggleEntities.addEventListener('click', () => {
            const isVisible = toggleEntities();
            btnToggleEntities.style.color = isVisible ? '#f8f8f2' : '#555';
        });
    }

    // 10.2 Light Influence Slider + Textbox
    const inputLightInfluence = document.getElementById('input-light-influence');
    const inputLightInfluenceText = document.getElementById('input-light-influence-text');
    if (inputLightInfluence && inputLightInfluenceText) {
        const initVal = getLightInfluence();
        inputLightInfluence.value = Math.min(5.0, Math.max(0.1, initVal));
        inputLightInfluenceText.value = parseFloat(initVal).toFixed(1);

        inputLightInfluence.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            setLightInfluence(val);
            inputLightInfluenceText.value = val.toFixed(1);
        });

        inputLightInfluenceText.addEventListener('change', (e) => {
            let val = parseFloat(e.target.value);
            if (isNaN(val) || val <= 0) val = 1.0;
            setLightInfluence(val);
            inputLightInfluenceText.value = val.toFixed(1);
            // Clamp slider to its range, but the actual value can exceed it
            inputLightInfluence.value = Math.min(5.0, Math.max(0.1, val));
        });

        inputLightInfluenceText.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.target.blur(); }
        });
    }

    // 10.3 Ambient Level Slider + Textbox
    const inputAmbient = document.getElementById('input-ambient');
    const inputAmbientText = document.getElementById('input-ambient-text');
    if (inputAmbient && inputAmbientText) {
        const initAmb = getAmbientLevel();
        const initAmbPct = (initAmb * 100);
        inputAmbient.value = Math.min(50, Math.max(0, initAmbPct));
        inputAmbientText.value = initAmbPct.toFixed(1) + '%';

        inputAmbient.addEventListener('input', (e) => {
            const pct = parseFloat(e.target.value);
            setAmbientLevel(pct / 100);
            inputAmbientText.value = pct.toFixed(1) + '%';
        });

        inputAmbientText.addEventListener('change', (e) => {
            let raw = e.target.value.replace('%', '').trim();
            let pct = parseFloat(raw);
            if (isNaN(pct) || pct < 0) pct = 2;
            setAmbientLevel(pct / 100);
            inputAmbientText.value = pct.toFixed(1) + '%';
            inputAmbient.value = Math.min(50, Math.max(0, pct));
        });

        inputAmbientText.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.target.blur(); }
        });
    }

    // 10.4 Exposure Slider + Textbox
    const inputExposure = document.getElementById('input-exposure');
    const inputExposureText = document.getElementById('input-exposure-text');
    if (inputExposure && inputExposureText) {
        const initExp = getExposure();
        inputExposure.value = Math.min(4.0, Math.max(0.1, initExp));
        inputExposureText.value = parseFloat(initExp).toFixed(1) + 'x';

        inputExposure.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            setExposure(val);
            inputExposureText.value = val.toFixed(1) + 'x';
        });

        inputExposureText.addEventListener('change', (e) => {
            let raw = e.target.value.replace('x', '').trim();
            let val = parseFloat(raw);
            if (isNaN(val) || val <= 0) val = 1.0;
            setExposure(val);
            inputExposureText.value = val.toFixed(1) + 'x';
            inputExposure.value = Math.min(4.0, Math.max(0.1, val));
        });

        inputExposureText.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.target.blur(); }
        });
    }

    // Blur range inputs on pointer-up so the slider collapses when the mouse leaves
    // (range inputs keep :focus after a click/drag, which would keep :focus-within active)
    ['input-light-influence', 'input-ambient', 'input-exposure'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('pointerup', () => el.blur());
    });

    // 11. Background Menu Logic
    const btnBgMenu = document.getElementById('btn-bg-menu');
    const bgDropdownMenu = document.getElementById('bg-dropdown-menu');
    const inputRoomImage = document.getElementById('input-room-image');

    const BG_MODE_ICONS = {
        'backgrounds/living_room.png': `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 2 L12 6 L12 12 L2 12 L2 6 Z"/><path d="M5 12 L5 9 L9 9 L9 12"/></svg>`,
        'backgrounds/bedroom.png': `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="1" y="7" width="12" height="5" rx="1"/><path d="M1 9 L13 9"/><path d="M7 7 L7 9"/><circle cx="4" cy="5" r="1.5"/></svg>`,
        'backgrounds/office.png': `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="1" y="2" width="12" height="8" rx="1"/><path d="M4 10 L4 12 M10 10 L10 12 M3 12 L11 12"/></svg>`,
        'backgrounds/lightstudio.png': `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="5" r="3"/><path d="M5 8 Q5 10 7 10 Q9 10 9 8"/><line x1="5.5" y1="10" x2="8.5" y2="10"/><line x1="6" y1="11.5" x2="8" y2="11.5"/></svg>`,
        upload: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 9 L7 2"/><path d="M4 5 L7 2 L10 5"/><path d="M2 11 L2 13 L12 13 L12 11"/></svg>`,
        reset: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="10" height="10" rx="1.5"/></svg>`,
    };

    function setBgUI(url) {
        const btn = document.getElementById('btn-bg-menu');
        const iconKey = !url ? 'reset' : (url.startsWith('data:') ? 'upload' : url);
        if (btn) btn.innerHTML = BG_MODE_ICONS[iconKey] || BG_MODE_ICONS.reset;
        document.querySelectorAll('#bg-dropdown-menu .dropdown-item').forEach(item => {
            const isActive =
                (!url && item.dataset.action === 'reset') ||
                (url && item.dataset.bg === url) ||
                (url && url.startsWith('data:') && item.dataset.action === 'upload');
            item.classList.toggle('active', !!isActive);
        });
    }

    // Helper: show/hide blend-mode button and update bg button icon
    function updatePhotoModeUI() {
        const blendContainer = document.getElementById('blend-mode-container');
        if (blendContainer) {
            blendContainer.style.display = hasBackgroundImage() ? '' : 'none';
        }
        setBgUI(localStorage.getItem('ha_simulator_bg'));
    }

    // Register callback so ANY background change (wall color picker, menu, etc.) updates UI
    setOnBackgroundChange(updatePhotoModeUI);

    if (btnBgMenu && bgDropdownMenu) {
        btnBgMenu.addEventListener('click', (e) => toggleDropdown(e, btnBgMenu, bgDropdownMenu));

        // Handle Item Clicks
        bgDropdownMenu.querySelectorAll('.dropdown-item').forEach(item => {
            item.addEventListener('click', () => {
                const action = item.dataset.action;
                const bgUrl = item.dataset.bg;

                if (bgUrl) {
                    setBackgroundImage(bgUrl);
                    bgDropdownMenu.classList.remove('active');
                } else if (action === 'upload') {
                    inputRoomImage.click();
                    bgDropdownMenu.classList.remove('active');
                } else if (action === 'reset') {
                    setBackgroundImage(null);
                }
            });
        });

        // Handle Custom Upload Input
        inputRoomImage.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (ev) => {
                    setBackgroundImage(ev.target.result);
                };
                reader.readAsDataURL(file);
            }
        });

        // Restore from localStorage
        const savedBg = localStorage.getItem('ha_simulator_bg');
        if (savedBg) {
            setBackgroundImage(savedBg);
        } else {
            updatePhotoModeUI();
        }
    }

    btnSaveCode.addEventListener('click', () => {
        const code = editor.getValue();
        let filename = "animation.yaml";
        try {
            const doc = jsyaml.load(code);
            if (doc && doc.alias) {
                filename = doc.alias.replace(/[^a-z0-9_]/gi, '_').toLowerCase() + ".yaml";
            } else {
                // Zeitstempel als Backup
                const now = new Date();
                const ts = now.toISOString().split('T')[0] + "_" + now.getHours() + now.getMinutes();
                filename = `animation_${ts}.yaml`;
            }
        } catch (e) { }

        const blob = new Blob([code], { type: "text/yaml" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });

    // 10. Notifications Modal
    let _statsInterval = null;

    function updateDebugStats() {
        const s = getDebugStats();

        const fpsEl = document.getElementById('dbg-fps');
        const dotEl = document.getElementById('dbg-fps-dot');
        if (fpsEl) fpsEl.textContent = s.rendering ? `${s.fps}` : '—';
        if (dotEl) {
            const col = !s.rendering ? '#444'
                : s.fps >= 55 ? '#50fa7b'
                    : s.fps >= 30 ? '#f1fa8c'
                        : '#ff5555';
            dotEl.style.color = col;
        }

        const fmEl = document.getElementById('dbg-framems');
        if (fmEl) fmEl.textContent = s.rendering ? `${s.frameMs} ms` : '—';

        const cvEl = document.getElementById('dbg-canvas');
        if (cvEl) cvEl.textContent = s.canvasW ? `${s.canvasW}×${s.canvasH}` : '—';

        const lmEl = document.getElementById('dbg-lm');
        if (lmEl) lmEl.textContent = s.lmW ? `${s.lmW}×${s.lmH}` : '—';

        const lpEl = document.getElementById('dbg-lamps');
        if (lpEl) lpEl.textContent = `${s.lampActive}/${s.lampTotal} aktiv, ${s.lampTransitioning} trans.`;

        const simEl = document.getElementById('dbg-sim');
        if (simEl) {
            if (isPlaying && !isPausedState) {
                simEl.textContent = '▶ läuft';
                simEl.style.color = '#50fa7b';
            } else if (isPausedState) {
                simEl.textContent = '⏸ pausiert';
                simEl.style.color = '#f1fa8c';
            } else {
                simEl.textContent = '⏹ idle';
                simEl.style.color = '#555';
            }
        }
    }

    btnNotifications.addEventListener('click', () => {
        notifModal.style.display = 'flex';
        updateNotifUI();
        updateDebugStats();
        _statsInterval = setInterval(updateDebugStats, 250);
    });
    btnCloseNotifs.addEventListener('click', () => {
        notifModal.style.display = 'none';
        clearInterval(_statsInterval);
        _statsInterval = null;
    });
    btnClearNotifs.addEventListener('click', () => {
        notifications = [];
        updateNotifUI();
    });

    // 11. Language Toggle
    const btnLanguage = document.getElementById('btn-language');
    if (btnLanguage) {
        btnLanguage.addEventListener('click', () => {
            const nextLang = getLang() === 'de' ? 'en' : 'de';
            setLang(nextLang);
        });
    }

    document.addEventListener('languageChanged', () => {
        validateAndSync();
    });

    // Initiale Synchronisation
    validateAndSync();
}

function validateAndSync() {
    const code = editor.getValue();

    // Wenn das Editor-Fenster komplett leer ist
    if (!code.trim()) {
        updateLampEntities({}, room);
        updateVariablePanel({});
        if (!isPlaying) {
            toggleBtn.disabled = true;
            toggleBtn.classList.add('btn-disabled');
        }
        return null;
    }

    try {
        const doc = jsyaml.load(code);
        if (doc) setCurrentDoc(doc);
        updateLampEntities(doc || {}, room);

        // Sync active editor view
        const _atSync = document.querySelector('#panel-editor .panel-tab.active');
        if (_atSync && _atSync.dataset.tab === 'timeline' && doc) syncYamlToTimeline(doc);
        else if (_atSync && _atSync.dataset.tab === 'nodes') syncYamlToNodes();

        // Update Global Variable Panel with full discovery
        updateVariablePanel(doc);

        // Update color picker script swatches
        if (colorPicker) colorPicker.updateScriptColors(doc);

        // Update Breakpoint Markers in YAML Gutter
        refreshBreakpointMarkers();

        // Prüfen ob das Skript ausführbaren Inhalt hat (sequence nicht leer)
        const hasContent = doc && doc.sequence && Array.isArray(doc.sequence) && doc.sequence.length > 0;

        if (!isPlaying) {
            toggleBtn.disabled = !hasContent;
            if (hasContent) toggleBtn.classList.remove('btn-disabled');
            else toggleBtn.classList.add('btn-disabled');
        }
        return doc;
    } catch (e) {
        if (!isPlaying) {
            toggleBtn.disabled = true;
            toggleBtn.classList.add('btn-disabled');
        }
        return null;
    }
}

window.showConfirmModal = function ({ title, message, confirmLabel, danger = false, onConfirm }) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    const modal = document.createElement('div');
    modal.className = 'modal-content';
    modal.style.maxWidth = '380px';

    const header = document.createElement('div');
    header.className = 'modal-header';
    const htitle = document.createElement('span');
    htitle.textContent = title;
    header.appendChild(htitle);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => overlay.remove());
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'modal-body';
    if (message) {
        const msg = document.createElement('p');
        msg.style.cssText = 'margin:0;color:#ccc;font-size:13px;line-height:1.5;';
        msg.textContent = message;
        body.appendChild(msg);
    }

    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-modal-cancel';
    cancelBtn.textContent = t('cancel');
    cancelBtn.addEventListener('click', () => overlay.remove());
    const confirmBtn = document.createElement('button');
    confirmBtn.className = danger ? 'btn-modal-save btn-modal-danger' : 'btn-modal-save';
    confirmBtn.textContent = confirmLabel;
    confirmBtn.addEventListener('click', () => { overlay.remove(); onConfirm(); });
    footer.appendChild(cancelBtn);
    footer.appendChild(confirmBtn);

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    confirmBtn.focus();
};

window.showToast = function (msg, type = 'success') {
    // Add to notification log
    const time = new Date().toLocaleTimeString();
    notifications.unshift({ id: Date.now() + Math.floor(Math.random() * 1000), time, msg, type });
    if (notifications.length > 10) notifications.pop();
    updateNotifUI();

    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerText = msg;
    toastContainer.appendChild(t);

    // Trigger Reflow for animation
    void t.offsetWidth;
    t.classList.add('show');

    setTimeout(() => {
        t.classList.remove('show');
        setTimeout(() => t.remove(), 300);
    }, 4000);
}

function mapLineToPath(cm, startLine) {
    let targetLine = startLine;
    let m = null;
    let key = null;

    const allowedKeys = ['action', 'service', 'delay', 'parallel', 'repeat', 'choose', 'if', 'wait_template', 'wait_for_trigger', 'variables'];

    while (targetLine >= 0) {
        const text = cm.getLine(targetLine);
        const match = text.match(/^\s*-?\s*([a-z_]+):/);
        if (match && allowedKeys.includes(match[1])) {
            m = match;
            key = match[1];
            break;
        }
        targetLine--;
    }

    if (!m) return { path: null, line: startLine };

    let occurrence = 0;
    for (let i = 0; i <= targetLine; i++) {
        const l = cm.getLine(i);
        const match = l.match(/^\s*-?\s*([a-z_]+):/);
        if (match && match[1] === key) {
            occurrence++;
        }
    }

    let currentOccurrence = 0;
    let foundPath = null;

    function traverse(obj) {
        if (!obj || typeof obj !== 'object' || foundPath) return;
        if (Array.isArray(obj)) {
            obj.forEach(traverse);
        } else {
            if (obj[key] !== undefined && obj.__path) {
                currentOccurrence++;
                if (currentOccurrence === occurrence) {
                    foundPath = obj.__path;
                    return;
                }
            }
            Object.values(obj).forEach(traverse);
        }
    }

    traverse(getCurrentDoc());
    return { path: foundPath, line: targetLine };
}

function refreshBreakpointMarkers() {
    if (!editor) return;
    editor.clearGutter("breakpoints");
    const lineCount = editor.lineCount();
    const allowedKeys = ['action', 'service', 'delay', 'parallel', 'repeat', 'choose', 'if', 'wait_template', 'wait_for_trigger', 'variables'];

    for (let i = 0; i < lineCount; i++) {
        const line = editor.getLine(i);
        const match = line.match(/^\s*-?\s*([a-z_]+):/);
        if (match && allowedKeys.includes(match[1])) {
            const result = mapLineToPath(editor, i);
            if (result && result.path) {
                const isActive = breakpoints.has(result.path);
                const marker = document.createElement("div");
                if (isActive) {
                    marker.className = "breakpoint-marker";
                    marker.innerHTML = "●";
                } else {
                    marker.className = "breakpoint-hint";
                    marker.innerHTML = "○";
                    marker.title = "Breakpoint hier setzen";
                }
                editor.setGutterMarker(i, "breakpoints", marker);
            }
        }
    }
}

function highlightLineByPath(path) {
    if (activeLineHandle) {
        editor.removeLineClass(activeLineHandle, "background", "cm-active-step-line");
        activeLineHandle = null;
    }

    if (!path) return;

    const lineCount = editor.lineCount();
    for (let i = 0; i < lineCount; i++) {
        const result = mapLineToPath(editor, i);
        if (result && result.path === path) {
            activeLineHandle = editor.addLineClass(i, "background", "cm-active-step-line");
            editor.scrollIntoView({ line: i, ch: 0 }, 200);
            break;
        }
    }
}



// App starten, sobald DOM bereit
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
