// js/colorPicker.js
import { t } from './i18n.js';
import { insertVariableAtCursor } from './nodeEditor.js';

// --- Standalone conversion helpers (module-level, used by engine too) ---

function _rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0, s = max === 0 ? 0 : d / max, v = max;
    if (max !== min) {
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }
    return [h * 360, s * 100, v * 100];
}

function _hsvToRgb(h, s, v) {
    h /= 360; s /= 100; v /= 100;
    let r, g, b;
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const tv = v * (1 - (1 - f) * s);
    switch (i % 6) {
        case 0: r = v;  g = tv; b = p;  break;
        case 1: r = q;  g = v;  b = p;  break;
        case 2: r = p;  g = v;  b = tv; break;
        case 3: r = p;  g = q;  b = v;  break;
        case 4: r = tv; g = p;  b = v;  break;
        case 5: r = v;  g = p;  b = q;  break;
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

export function rgbToXy(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    r = (r > 0.04045) ? Math.pow((r + 0.055) / 1.055, 2.4) : r / 12.92;
    g = (g > 0.04045) ? Math.pow((g + 0.055) / 1.055, 2.4) : g / 12.92;
    b = (b > 0.04045) ? Math.pow((b + 0.055) / 1.055, 2.4) : b / 12.92;
    const X = r * 0.4124 + g * 0.3576 + b * 0.1805;
    const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const Z = r * 0.0193 + g * 0.1192 + b * 0.9505;
    const sum = X + Y + Z;
    return [sum === 0 ? 0 : X / sum, sum === 0 ? 0 : Y / sum];
}

export function xyToRgb(x, y, bri = 1) {
    x = Math.max(0.001, Math.min(0.999, parseFloat(x)));
    y = Math.max(0.001, Math.min(0.999, parseFloat(y)));
    const z = 1.0 - x - y;
    const Y = Math.max(0.01, bri);
    const X = (Y / y) * x;
    const Z = (Y / y) * z;
    let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
    let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
    let b = X * 0.051713 - Y * 0.121364 + Z * 1.011530;
    const comp = (c) => {
        c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
        return Math.round(Math.max(0, Math.min(1, c)) * 255);
    };
    const fR = comp(r), fG = comp(g), fB = comp(b);
    if (fR + fG + fB === 0 && bri > 0) return [50, 50, 50];
    return [fR, fG, fB];
}

export function rgbToHs(r, g, b) {
    const [h, s] = _rgbToHsv(r, g, b);
    return [h, s];
}

export function hsToRgb(h, s) {
    return _hsvToRgb(h, s, 100);
}

export function rgbToHex(rgb) {
    const [r, g, b] = rgb;
    return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

export function hexToRgb(hex) {
    const m = hex.replace('#', '').match(/.{2}/g);
    if (!m || m.length < 3) return [0, 0, 0];
    return m.slice(0, 3).map(c => parseInt(c, 16));
}

// --- ColorPicker class ---

export class ColorPicker {
    constructor(editorInstance) {
        this.editor = editorInstance;

        // Internal state: HSV
        this._h = 168;   // 0–360
        this._s = 100;   // 0–100
        this._v = 100;   // 0–100

        this.currentMode = 'rgb';
        this.favorites = JSON.parse(localStorage.getItem('colorFavorites')) || [];

        // Grab DOM elements (guard: they may not exist if called with null editor)
        this._svCanvas   = document.getElementById('cp-sv');
        this._hueCanvas  = document.getElementById('cp-hue');
        this._swatch     = document.getElementById('cp-swatch');
        this._hexInput   = document.getElementById('cp-hex');
        this._tabs       = document.querySelectorAll('.cp-tab[data-mode]');

        this._inR = document.getElementById('cp-r');
        this._inG = document.getElementById('cp-g');
        this._inB = document.getElementById('cp-b');
        this._inH = document.getElementById('cp-h');
        this._inS = document.getElementById('cp-s');
        this._inX = document.getElementById('cp-x');
        this._inY = document.getElementById('cp-y');

        this._groupRgb = document.getElementById('cp-group-rgb');
        this._groupHs  = document.getElementById('cp-group-hs');
        this._groupXy  = document.getElementById('cp-group-xy');

        this._btnInsert    = document.getElementById('btn-insert-color');
        this._btnAddFav    = document.getElementById('btn-add-favorite');
        this._favContainer = document.getElementById('favorites-container');

        this._scriptLabel  = document.getElementById('cp-script-label');
        this._scriptColors = document.getElementById('cp-script-colors');

        // Skip init if DOM isn't available (engine-only instantiation)
        if (!this._svCanvas) return;

        this._initCanvases();
        this._initEvents();
        this._syncAll();
        this.renderFavorites();
    }

    // ---- Canvas drawing ----

    _drawSV() {
        const canvas = this._svCanvas;
        if (!canvas) return;
        const w = canvas.offsetWidth || 200;
        const h = canvas.offsetHeight || 150;
        if (canvas.width !== w)  canvas.width  = w;
        if (canvas.height !== h) canvas.height = h;

        const ctx = canvas.getContext('2d');

        // Fill with pure hue
        ctx.fillStyle = `hsl(${this._h}, 100%, 50%)`;
        ctx.fillRect(0, 0, w, h);

        // White left-to-right gradient (saturation)
        const gW = ctx.createLinearGradient(0, 0, w, 0);
        gW.addColorStop(0, 'rgba(255,255,255,1)');
        gW.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gW;
        ctx.fillRect(0, 0, w, h);

        // Black top-to-bottom gradient (value)
        const gB = ctx.createLinearGradient(0, 0, 0, h);
        gB.addColorStop(0, 'rgba(0,0,0,0)');
        gB.addColorStop(1, 'rgba(0,0,0,1)');
        ctx.fillStyle = gB;
        ctx.fillRect(0, 0, w, h);

        // Cursor circle
        const cx = (this._s / 100) * w;
        const cy = (1 - this._v / 100) * h;
        ctx.beginPath();
        ctx.arc(cx, cy, 7, 0, 2 * Math.PI);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, 5.5, 0, 2 * Math.PI);
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    _drawHue() {
        const canvas = this._hueCanvas;
        if (!canvas) return;
        const w = canvas.offsetWidth || 200;
        const h = canvas.offsetHeight || 14;
        if (canvas.width !== w)  canvas.width  = w;
        if (canvas.height !== h) canvas.height = h;

        const ctx = canvas.getContext('2d');
        const grad = ctx.createLinearGradient(0, 0, w, 0);
        for (let i = 0; i <= 12; i++) {
            grad.addColorStop(i / 12, `hsl(${i * 30}, 100%, 50%)`);
        }
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        // Thumb line
        const x = Math.round((this._h / 360) * w);
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.fillRect(Math.max(0, x - 1), 0, 3, h);
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.max(0, x - 1), 0, 3, h);
    }

    _initCanvases() {
        // First draw after layout
        requestAnimationFrame(() => {
            this._drawSV();
            this._drawHue();
        });

        // Re-draw on resize
        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(() => {
                this._drawSV();
                this._drawHue();
            });
            ro.observe(this._svCanvas);
        }

        // SV canvas drag
        this._bindDrag(this._svCanvas, (ex, ey) => {
            const rect = this._svCanvas.getBoundingClientRect();
            const s = Math.max(0, Math.min(1, (ex - rect.left) / rect.width)) * 100;
            const v = (1 - Math.max(0, Math.min(1, (ey - rect.top) / rect.height))) * 100;
            this._s = s;
            this._v = v;
            this._syncAll();
        });

        // Hue canvas drag
        this._bindDrag(this._hueCanvas, (ex, ey) => {
            const rect = this._hueCanvas.getBoundingClientRect();
            const h = Math.max(0, Math.min(1, (ex - rect.left) / rect.width)) * 360;
            this._h = h;
            this._syncAll();
        });
    }

    _bindDrag(canvas, handler) {
        let dragging = false;

        const onMove = (e) => {
            if (!dragging) return;
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            handler(clientX, clientY);
        };

        const onUp = () => { dragging = false; };

        canvas.addEventListener('mousedown', (e) => {
            dragging = true;
            handler(e.clientX, e.clientY);
            e.preventDefault();
        });
        canvas.addEventListener('touchstart', (e) => {
            dragging = true;
            handler(e.touches[0].clientX, e.touches[0].clientY);
            e.preventDefault();
        }, { passive: false });

        window.addEventListener('mousemove', onMove);
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('mouseup', onUp);
        window.addEventListener('touchend', onUp);
    }

    // ---- Events ----

    _initEvents() {
        // Mode tabs
        this._tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                this._tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                this.currentMode = tab.dataset.mode;
                this._groupRgb.style.display = this.currentMode === 'rgb' ? 'grid' : 'none';
                this._groupHs.style.display  = this.currentMode === 'hs'  ? 'grid' : 'none';
                this._groupXy.style.display  = this.currentMode === 'xy'  ? 'grid' : 'none';
            });
        });

        // HEX input
        this._hexInput.addEventListener('input', () => {
            const val = this._hexInput.value;
            if (/^#[0-9a-fA-F]{6}$/.test(val)) {
                const [r, g, b] = hexToRgb(val);
                this._setFromRgbInternal(r, g, b);
            }
        });
        this._hexInput.addEventListener('blur', () => {
            this._hexInput.value = this._getHex().toUpperCase();
        });

        // RGB inputs
        [this._inR, this._inG, this._inB].forEach(inp => {
            inp.addEventListener('change', () => {
                this._setFromRgbInternal(
                    parseInt(this._inR.value) || 0,
                    parseInt(this._inG.value) || 0,
                    parseInt(this._inB.value) || 0
                );
            });
        });

        // HS inputs
        [this._inH, this._inS].forEach(inp => {
            inp.addEventListener('change', () => {
                const rgb = hsToRgb(parseInt(this._inH.value) || 0, parseInt(this._inS.value) || 0);
                this._setFromRgbInternal(rgb[0], rgb[1], rgb[2]);
            });
        });

        // XY inputs
        [this._inX, this._inY].forEach(inp => {
            inp.addEventListener('change', () => {
                const rgb = xyToRgb(parseFloat(this._inX.value) || 0, parseFloat(this._inY.value) || 0);
                this._setFromRgbInternal(rgb[0], rgb[1], rgb[2]);
            });
        });

        // Insert button
        this._btnInsert.addEventListener('click', () => {
            let valueOnly = '';
            let fullSnippet = '';
            if (this.currentMode === 'rgb') {
                valueOnly = `[${this._inR.value}, ${this._inG.value}, ${this._inB.value}]`;
                fullSnippet = `rgb_color: ${valueOnly}`;
            } else if (this.currentMode === 'xy') {
                valueOnly = `[${this._inX.value}, ${this._inY.value}]`;
                fullSnippet = `xy_color: ${valueOnly}`;
            } else if (this.currentMode === 'hs') {
                valueOnly = `[${this._inH.value}, ${this._inS.value}]`;
                fullSnippet = `hs_color: ${valueOnly}`;
            }
            const viewNodes = document.getElementById('view-nodes');
            const isNodeEditor = viewNodes && viewNodes.classList.contains('active');
            insertVariableAtCursor(isNodeEditor ? valueOnly : fullSnippet);
        });

        // Add favorite
        this._btnAddFav.addEventListener('click', () => {
            const hex = this._getHex().toUpperCase();
            if (!this.favorites.includes(hex)) {
                this.favorites.push(hex);
                localStorage.setItem('colorFavorites', JSON.stringify(this.favorites));
                this.renderFavorites();
            }
        });
    }

    // ---- Internal color sync ----

    _getHex() {
        const [r, g, b] = _hsvToRgb(this._h, this._s, this._v);
        return rgbToHex([r, g, b]);
    }

    _setFromRgbInternal(r, g, b) {
        r = Math.max(0, Math.min(255, Math.round(r)));
        g = Math.max(0, Math.min(255, Math.round(g)));
        b = Math.max(0, Math.min(255, Math.round(b)));
        const [h, s, v] = _rgbToHsv(r, g, b);
        this._h = h;
        this._s = s;
        this._v = v;
        this._syncAll();
    }

    _syncAll() {
        const [r, g, b] = _hsvToRgb(this._h, this._s, this._v);
        const hex = rgbToHex([r, g, b]).toUpperCase();

        // Swatch
        if (this._swatch) this._swatch.style.backgroundColor = hex;

        // HEX input (only if not focused to avoid caret jump)
        if (this._hexInput && document.activeElement !== this._hexInput) {
            this._hexInput.value = hex;
        }

        // RGB inputs
        if (this._inR) this._inR.value = r;
        if (this._inG) this._inG.value = g;
        if (this._inB) this._inB.value = b;

        // HS inputs
        const hs = rgbToHs(r, g, b);
        if (this._inH) this._inH.value = Math.round(hs[0]);
        if (this._inS) this._inS.value = Math.round(hs[1]);

        // XY inputs
        const xy = rgbToXy(r, g, b);
        if (this._inX) this._inX.value = xy[0].toFixed(3);
        if (this._inY) this._inY.value = xy[1].toFixed(3);

        // Redraw canvases
        this._drawSV();
        this._drawHue();
    }

    // ---- Public backward-compat API ----

    /**
     * Update color from RGB values (called from external code).
     */
    updateFromRgb(r, g, b) {
        if (!this._svCanvas) return;
        this._setFromRgbInternal(r, g, b);
    }

    /**
     * Set color from external source (e.g. entity click in simulation).
     * Accepts "rgb(r, g, b)" or "#rrggbb".
     */
    setColorFromExternal(rgbString) {
        if (!rgbString) return;
        if (rgbString.startsWith('rgb')) {
            const match = rgbString.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
            if (match) {
                this.updateFromRgb(parseInt(match[1]), parseInt(match[2]), parseInt(match[3]));
            }
        } else if (rgbString.startsWith('#')) {
            const [r, g, b] = hexToRgb(rgbString);
            this.updateFromRgb(r, g, b);
        }
    }

    /**
     * Scan a parsed YAML doc, extract all rgb_color / hs_color / xy_color arrays
     * and render them as swatches in #cp-script-colors.
     */
    updateScriptColors(doc) {
        if (!this._scriptColors) return;

        const colors = new Set();

        const traverse = (node) => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) {
                node.forEach(traverse);
                return;
            }
            for (const key of Object.keys(node)) {
                const val = node[key];
                if (key === 'rgb_color' && Array.isArray(val) && val.length >= 3) {
                    const hex = rgbToHex(val).toUpperCase();
                    colors.add(hex);
                } else if (key === 'hs_color' && Array.isArray(val) && val.length >= 2) {
                    const rgb = hsToRgb(val[0], val[1]);
                    colors.add(rgbToHex(rgb).toUpperCase());
                } else if (key === 'xy_color' && Array.isArray(val) && val.length >= 2) {
                    const rgb = xyToRgb(val[0], val[1]);
                    colors.add(rgbToHex(rgb).toUpperCase());
                } else {
                    traverse(val);
                }
            }
        };

        traverse(doc);

        // Feed popup's script swatches
        _scriptHexCache = Array.from(colors);
        if (_popupPicker) _popupPicker.setScriptColors(_scriptHexCache);

        this._scriptColors.innerHTML = '';

        if (colors.size === 0) {
            if (this._scriptLabel) this._scriptLabel.style.display = 'none';
            this._scriptColors.style.display = 'none';
            return;
        }

        if (this._scriptLabel) this._scriptLabel.style.display = '';
        this._scriptColors.style.display = 'flex';

        colors.forEach(hex => {
            const dot = document.createElement('div');
            dot.className = 'cp-swatch-dot';
            dot.style.backgroundColor = hex;
            dot.title = hex;
            dot.addEventListener('click', () => {
                const [r, g, b] = hexToRgb(hex);
                this.updateFromRgb(r, g, b);
            });
            this._scriptColors.appendChild(dot);
        });
    }

    renderFavorites() {
        if (!this._favContainer) return;
        this._favContainer.querySelectorAll('.favorite-color').forEach(f => f.remove());

        this.favorites.forEach(hex => {
            const div = document.createElement('div');
            div.className = 'favorite-color';
            div.style.backgroundColor = hex;
            div.title = t('fav_tooltip');

            div.onclick = () => {
                const [r, g, b] = hexToRgb(hex);
                this.updateFromRgb(r, g, b);
            };

            div.ondblclick = () => {
                this.favorites = this.favorites.filter(f => f !== hex);
                localStorage.setItem('colorFavorites', JSON.stringify(this.favorites));
                this.renderFavorites();
            };

            this._favContainer.insertBefore(div, this._btnAddFav);
        });
    }

    // Legacy instance methods kept for any external callers
    rgbToXy(r, g, b)     { return rgbToXy(r, g, b); }
    xyToRgb(x, y, bri)   { return xyToRgb(x, y, bri); }
    rgbToHs(r, g, b)     { return rgbToHs(r, g, b); }
    hsToRgb(h, s)        { return hsToRgb(h, s); }
}

// --- Floating popup color picker ---

let _popup         = null;
let _popupPicker   = null;
let _currentOnPick = null;
let _popupCloseCb  = null;
let _popupLastRgb  = [255, 255, 255];
let _scriptHexCache = [];

class _PopupPicker {
    constructor(container, onPickFn) {
        this._h = 0; this._s = 100; this._v = 100;
        this._onPick = onPickFn;

        this._svCanvas = document.createElement('canvas');
        this._svCanvas.className = 'cp-popup-sv';

        this._hueCanvas = document.createElement('canvas');
        this._hueCanvas.className = 'cp-popup-hue';

        const row = document.createElement('div');
        row.className = 'cp-popup-row';
        this._swatch = document.createElement('div');
        this._swatch.className = 'cp-popup-swatch-preview';
        this._hexInput = document.createElement('input');
        this._hexInput.className = 'cp-popup-hex';
        this._hexInput.type = 'text';
        this._hexInput.maxLength = 7;
        this._hexInput.placeholder = '#RRGGBB';
        row.append(this._swatch, this._hexInput);

        this._swatchRow = document.createElement('div');
        this._swatchRow.className = 'cp-popup-swatches';
        this._swatchRow.style.display = 'none';

        container.append(this._svCanvas, this._hueCanvas, row, this._swatchRow);

        this._bindDrags();
        this._bindHex();
        requestAnimationFrame(() => { this._drawSV(); this._drawHue(); });
    }

    setRgb(r, g, b) {
        [this._h, this._s, this._v] = _rgbToHsv(r, g, b);
        this._sync();
    }

    setScriptColors(hexArr) {
        this._swatchRow.innerHTML = '';
        hexArr.forEach(hex => {
            const dot = document.createElement('div');
            dot.className = 'cp-popup-dot';
            dot.style.background = hex;
            dot.title = hex;
            dot.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                const [r, g, b] = hexToRgb(hex);
                this.setRgb(r, g, b);
                this._onPick(..._hsvToRgb(this._h, this._s, this._v));
            });
            this._swatchRow.appendChild(dot);
        });
        this._swatchRow.style.display = hexArr.length ? 'flex' : 'none';
    }

    _drawSV() {
        const canvas = this._svCanvas;
        const w = canvas.offsetWidth || 220;
        const h = canvas.offsetHeight || 150;
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = `hsl(${this._h}, 100%, 50%)`;
        ctx.fillRect(0, 0, w, h);
        const gW = ctx.createLinearGradient(0, 0, w, 0);
        gW.addColorStop(0, 'rgba(255,255,255,1)');
        gW.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = gW; ctx.fillRect(0, 0, w, h);
        const gB = ctx.createLinearGradient(0, 0, 0, h);
        gB.addColorStop(0, 'rgba(0,0,0,0)');
        gB.addColorStop(1, 'rgba(0,0,0,1)');
        ctx.fillStyle = gB; ctx.fillRect(0, 0, w, h);
        const cx = (this._s / 100) * w;
        const cy = (1 - this._v / 100) * h;
        ctx.beginPath(); ctx.arc(cx, cy, 7, 0, 2 * Math.PI);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2; ctx.stroke();
        ctx.beginPath(); ctx.arc(cx, cy, 5.5, 0, 2 * Math.PI);
        ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1; ctx.stroke();
    }

    _drawHue() {
        const canvas = this._hueCanvas;
        const w = canvas.offsetWidth || 220;
        const h = canvas.offsetHeight || 16;
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
        const ctx = canvas.getContext('2d');
        const grad = ctx.createLinearGradient(0, 0, w, 0);
        for (let i = 0; i <= 12; i++) grad.addColorStop(i / 12, `hsl(${i * 30}, 100%, 50%)`);
        ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
        const x = Math.round((this._h / 360) * w);
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.fillRect(Math.max(0, x - 1), 0, 3, h);
        ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1;
        ctx.strokeRect(Math.max(0, x - 1), 0, 3, h);
    }

    _sync() {
        const [r, g, b] = _hsvToRgb(this._h, this._s, this._v);
        const hex = rgbToHex([r, g, b]).toUpperCase();
        this._swatch.style.backgroundColor = hex;
        if (document.activeElement !== this._hexInput) this._hexInput.value = hex;
        this._drawSV();
        this._drawHue();
    }

    _bindDrags() {
        const bindOne = (canvas, handler) => {
            let active = false;
            const move = (e) => {
                if (!active) return;
                const cx = e.touches ? e.touches[0].clientX : e.clientX;
                const cy = e.touches ? e.touches[0].clientY : e.clientY;
                handler(cx, cy);
            };
            const up = () => { active = false; };
            canvas.addEventListener('mousedown', (e) => {
                active = true; handler(e.clientX, e.clientY); e.preventDefault();
            });
            canvas.addEventListener('touchstart', (e) => {
                active = true; handler(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault();
            }, { passive: false });
            window.addEventListener('mousemove', move);
            window.addEventListener('touchmove', move, { passive: false });
            window.addEventListener('mouseup', up);
            window.addEventListener('touchend', up);
        };

        bindOne(this._svCanvas, (ex, ey) => {
            const rect = this._svCanvas.getBoundingClientRect();
            this._s = Math.max(0, Math.min(1, (ex - rect.left) / rect.width)) * 100;
            this._v = (1 - Math.max(0, Math.min(1, (ey - rect.top) / rect.height))) * 100;
            this._sync();
            this._onPick(..._hsvToRgb(this._h, this._s, this._v));
        });

        bindOne(this._hueCanvas, (ex) => {
            const rect = this._hueCanvas.getBoundingClientRect();
            this._h = Math.max(0, Math.min(1, (ex - rect.left) / rect.width)) * 360;
            this._sync();
            this._onPick(..._hsvToRgb(this._h, this._s, this._v));
        });
    }

    _bindHex() {
        this._hexInput.addEventListener('input', () => {
            const val = this._hexInput.value;
            if (/^#[0-9a-fA-F]{6}$/.test(val)) {
                const [r, g, b] = hexToRgb(val);
                [this._h, this._s, this._v] = _rgbToHsv(r, g, b);
                this._sync();
                this._onPick(r, g, b);
            }
        });
        this._hexInput.addEventListener('blur', () => {
            const [r, g, b] = _hsvToRgb(this._h, this._s, this._v);
            this._hexInput.value = rgbToHex([r, g, b]).toUpperCase();
        });
    }
}

export function dismissColorPickerPopup() {
    _dismissPopup();
}

export function setPopupScriptColors(hexArr) {
    _scriptHexCache = hexArr || [];
    if (_popupPicker) _popupPicker.setScriptColors(_scriptHexCache);
}

export function openColorPicker(anchorEl, initialRgb, { onPick, onClose } = {}) {
    if (!_popup) {
        _popup = document.createElement('div');
        _popup.className = 'cp-popup';
        document.body.appendChild(_popup);
        _popupPicker = new _PopupPicker(_popup, (r, g, b) => {
            _popupLastRgb = [r, g, b];
            if (_currentOnPick) _currentOnPick(r, g, b);
        });
    }
    _currentOnPick = onPick || null;
    _popupCloseCb  = onClose || null;
    const [r, g, b] = initialRgb;
    _popupLastRgb = [r, g, b];
    _popup.style.display = 'block';
    _positionPopup(anchorEl);
    // Set color after popup is visible so canvas.offsetWidth is correct
    _popupPicker.setRgb(r, g, b);
    _popupPicker.setScriptColors(_scriptHexCache);
    setTimeout(() => {
        document.addEventListener('mousedown', _popupOutsideClose);
        document.addEventListener('keydown', _popupEscClose);
    }, 0);
}

function _positionPopup(anchor) {
    const r  = anchor.getBoundingClientRect();
    const pw = _popup.offsetWidth  || 240;
    const ph = _popup.offsetHeight || 280;
    let left = r.left;
    let top  = r.bottom + 6;
    if (left + pw > window.innerWidth  - 8) left = window.innerWidth  - pw - 8;
    if (top  + ph > window.innerHeight - 8) top  = r.top - ph - 6;
    _popup.style.left = Math.max(4, left) + 'px';
    _popup.style.top  = Math.max(4, top)  + 'px';
}

function _popupOutsideClose(e) {
    if (_popup && !_popup.contains(e.target)) _dismissPopup();
}

function _popupEscClose(e) {
    if (e.key === 'Escape') _dismissPopup();
}

function _dismissPopup() {
    if (!_popup || _popup.style.display === 'none') return;
    _popup.style.display = 'none';
    document.removeEventListener('mousedown', _popupOutsideClose);
    document.removeEventListener('keydown', _popupEscClose);
    if (_popupCloseCb) {
        _popupCloseCb(..._popupLastRgb);
        _popupCloseCb = null;
    }
    _currentOnPick = null;
}

// --- Engine utility (kept export for backward compat) ---

export function calculateRgbFromInputs(data, vars, resolveTemplate) {
    let b = 100;
    if (data.brightness_pct !== undefined) {
        b = Math.max(0, Math.min(100, parseFloat(resolveTemplate(data.brightness_pct, vars)) || 100));
    } else if (data.brightness !== undefined) {
        b = Math.max(0, Math.min(100, (parseFloat(resolveTemplate(data.brightness, vars)) || 255) / 2.55));
    }

    let rgb = [255, 255, 255];

    if (data.xy_color) {
        let xy = resolveTemplate(data.xy_color, vars);
        if (typeof xy === 'string') xy = xy.split(',').map(n => parseFloat(n.trim()));
        if (Array.isArray(xy) && xy.length >= 2) {
            rgb = xyToRgb(xy[0], xy[1], b / 100);
        }
    } else if (data.rgb_color) {
        let col = resolveTemplate(data.rgb_color, vars);
        if (typeof col === 'string') {
            const clean = col.trim().replace(/^\[|\]$/g, '');
            col = clean.split(',').map(n => parseInt(n.trim()));
        }
        if (Array.isArray(col) && col.length >= 3) {
            rgb = [col[0] * (b / 100), col[1] * (b / 100), col[2] * (b / 100)];
        }
    } else if (data.hs_color) {
        let hs = resolveTemplate(data.hs_color, vars);
        if (typeof hs === 'string') hs = hs.split(',').map(n => parseFloat(n.trim()));
        if (Array.isArray(hs) && hs.length >= 2) {
            rgb = hsToRgb(hs[0], hs[1]);
            rgb = [rgb[0] * (b / 100), rgb[1] * (b / 100), rgb[2] * (b / 100)];
        }
    }

    return {
        rgbString: `rgb(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])})`,
        rgbArray:  [Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2])],
        brightness: b
    };
}
