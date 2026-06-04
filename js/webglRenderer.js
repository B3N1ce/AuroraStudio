// js/webglRenderer.js
// WebGL HDR rendering pipeline: linear-light accumulation → Khronos PBR Neutral
// tone mapping → TPDF triangle-noise dithering → sRGB output.
// Replaces the Canvas 2D lightmap approach to eliminate color banding.

const MAX_LAMPS = 64;

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const VS = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FS = `
precision highp float;
#define MAX_LAMPS 64

uniform sampler2D u_bg;
uniform int       u_has_bg;
uniform vec3      u_wall;
uniform float     u_ambient;
uniform float     u_exposure;
uniform int       u_blend;
uniform int       u_lamp_n;
uniform vec2      u_lamp_pos[MAX_LAMPS];
uniform vec3      u_lamp_rgb[MAX_LAMPS];
uniform float     u_lamp_r[MAX_LAMPS];
uniform float     u_lamp_a[MAX_LAMPS];
uniform vec2      u_res;

// sRGB ↔ linear conversions (IEC 61966-2-1)
vec3 srgb_to_lin(vec3 c) {
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 lin_to_srgb(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

// Khronos PBR Neutral Tone Mapper
// https://github.com/KhronosGroup/ToneMapping/blob/main/PBR_Neutral/pbrNeutral.glsl
// Preserves saturation below compression start; desaturates only in highlights.
vec3 tone_map(vec3 color) {
    const float startCompression = 0.8 - 0.04;
    const float desaturation = 0.15;
    float x = min(color.r, min(color.g, color.b));
    float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
    color -= offset;
    float peak = max(color.r, max(color.g, color.b));
    if (peak < startCompression) return color;
    const float d = 1.0 - startCompression;
    float newPeak = 1.0 - d * d / (peak + d - startCompression);
    color *= newPeak / peak;
    float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
    return mix(color, vec3(newPeak), g);
}

// TPDF (Triangular Probability Density Function) dithering.
// Two independent hash samples → triangle distribution, zero mean, ±1 LSB.
// Breaks 8-bit quantisation steps without any visible spatial pattern.
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
vec3 dither(vec3 c) {
    float n = hash(gl_FragCoord.xy) + hash(gl_FragCoord.xy + vec2(1.0, 0.0)) - 1.0;
    return c + n / 255.0;
}

// Normalised inverse-square falloff: f(0)=1, f(radius)≈0
// Uses the same k=18 constant as the old Canvas gradient for visual parity,
// but computed per-pixel in linear float — no gradient interpolation artefacts.
float lamp_falloff(vec2 frag, vec2 lpos, float r) {
    const float k = 18.0;
    float t = length(frag - lpos) / max(r, 1.0);
    float edgeVal = 1.0 / (1.0 + k);
    return max(0.0, (1.0 / (1.0 + k * t * t) - edgeVal) / (1.0 - edgeVal));
}

void main() {
    vec2 px = gl_FragCoord.xy;
    vec2 uv = vec2(px.x / u_res.x, 1.0 - px.y / u_res.y);

    // Background in linear light
    vec3 bg = (u_has_bg == 1)
        ? srgb_to_lin(texture2D(u_bg, uv).rgb)
        : u_wall;

    // Accumulate lamp contributions (HDR, no clamping)
    vec3 lgt = vec3(u_ambient);
    for (int i = 0; i < MAX_LAMPS; i++) {
        if (i >= u_lamp_n) break;
        lgt += u_lamp_rgb[i] * u_lamp_a[i] * lamp_falloff(px, u_lamp_pos[i], u_lamp_r[i]);
    }

    // Blend mode
    // Overlay and color-dodge rely on tonal variation in the background to produce contrast.
    // Without a background image the wall is a uniform colour, which makes them degenerate
    // (e.g. overlay on white → always white). Fall back to multiply-glow in that case,
    // matching the behaviour of the old Canvas 2D pipeline.
    // When a background image is present, multiply-glow uses a reduced glow term so the
    // photographic detail remains visible and the light doesn't wash out the image.
    vec3 col;
    if (u_has_bg == 0) {
        col = bg * lgt + lgt * 0.5;                                                  // no bg: full multiply-glow
    } else if (u_blend == 0) {
        col = bg * lgt + lgt * 0.15;                                                 // multiply-glow + bg: subtle glow halo
    } else if (u_blend == 1) {
        col = bg * lgt;                                                               // multiply
    } else if (u_blend == 2) {
        col = mix(2.0*bg*lgt, 1.0-2.0*(1.0-bg)*(1.0-lgt), step(vec3(0.5), bg));     // overlay
    } else {
        col = bg / max(vec3(0.001), 1.0 - lgt);                                      // color-dodge
    }

    // Exposure → tone map → sRGB encode → dither
    col = tone_map(col * u_exposure);
    col = lin_to_srgb(col);
    col = dither(col);               // ±1 LSB im sRGB-Ausgaberaum = perceptual uniform
    gl_FragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let gl        = null;
let glCanvas  = null;
let prog      = null;
let posBuf    = null;
let bgTex     = null;
let _hasBg    = false;

// Cached uniform / attribute locations
let aPos, uBg, uHasBg, uWall, uAmbient, uExposure, uBlend, uLampN, uRes;
const uLampPos = [], uLampRgb = [], uLampR = [], uLampA = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error('WebGL shader compile error:', gl.getShaderInfoLog(s));
        gl.deleteShader(s);
        return null;
    }
    return s;
}

// sRGB byte [0-255] → linear float [0-1]
function sToL(c) {
    const n = c / 255;
    return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
}

// sRGB byte [0-255] → linear float with optional colour-curve pre-processing
function applyLampCurve(c, curve) {
    const n = c / 255;
    if (curve === 'linear')  return n;                                                    // true linear: c/255, no decode
    if (curve === 'gamma22') return Math.pow(n, 2.2);
    if (curve === 'gamma28') return Math.pow(n, 2.8);
    if (curve === 'cie')     return n <= 0.08 ? (n * 100 / 903.3) : Math.pow((n + 0.16) / 1.16, 3);
    return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);                // 'srgb' = proper sRGB decode
}

const BLEND_MAP = { 'multiply-glow': 0, 'multiply': 1, 'overlay': 2, 'color-dodge': 3 };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initWebGL(container) {
    glCanvas = document.createElement('canvas');
    glCanvas.id = 'webgl-canvas';
    glCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:0;';
    container.style.position = 'relative';
    container.insertBefore(glCanvas, container.firstChild);

    const ctxOpts = { preserveDrawingBuffer: true };
    gl = glCanvas.getContext('webgl2', ctxOpts)
      || glCanvas.getContext('webgl', ctxOpts)
      || glCanvas.getContext('experimental-webgl', ctxOpts);

    if (!gl) {
        console.warn('WebGL not available — falling back to Canvas 2D rendering.');
        glCanvas.remove();
        glCanvas = null;
        return false;
    }

    const vs = mkShader(gl.VERTEX_SHADER,   VS);
    const fs = mkShader(gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) { glCanvas.remove(); glCanvas = null; return false; }

    prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error('WebGL link error:', gl.getProgramInfoLog(prog));
        glCanvas.remove(); glCanvas = null; return false;
    }

    gl.useProgram(prog);

    // Fullscreen quad — two triangles covering NDC [-1,1]²
    posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([-1,-1,  1,-1, -1, 1,  -1, 1,  1,-1,  1, 1]),
        gl.STATIC_DRAW);

    // Cache all uniform / attribute locations once
    aPos     = gl.getAttribLocation(prog,  'a_pos');
    uBg      = gl.getUniformLocation(prog, 'u_bg');
    uHasBg   = gl.getUniformLocation(prog, 'u_has_bg');
    uWall    = gl.getUniformLocation(prog, 'u_wall');
    uAmbient = gl.getUniformLocation(prog, 'u_ambient');
    uExposure= gl.getUniformLocation(prog, 'u_exposure');
    uBlend   = gl.getUniformLocation(prog, 'u_blend');
    uLampN   = gl.getUniformLocation(prog, 'u_lamp_n');
    uRes     = gl.getUniformLocation(prog, 'u_res');

    for (let i = 0; i < MAX_LAMPS; i++) {
        uLampPos.push(gl.getUniformLocation(prog, `u_lamp_pos[${i}]`));
        uLampRgb.push(gl.getUniformLocation(prog, `u_lamp_rgb[${i}]`));
        uLampR.push  (gl.getUniformLocation(prog, `u_lamp_r[${i}]`));
        uLampA.push  (gl.getUniformLocation(prog, `u_lamp_a[${i}]`));
    }

    // 1×1 placeholder background texture
    bgTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, bgTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([0,0,0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    return true;
}

export function resizeWebGL(w, h) {
    if (!glCanvas) return;
    glCanvas.width  = w;
    glCanvas.height = h;
    if (gl) gl.viewport(0, 0, w, h);
}

export function setBackgroundTexture(img) {
    if (!gl) return;
    _hasBg = img !== null;
    gl.bindTexture(gl.TEXTURE_2D, bgTex);
    if (img) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([0,0,0]));
    }
}

export function renderScene({ lamps, ambient, wallColor, exposure, blendMode, lightInfluence, colorCurve }) {
    if (!gl || !glCanvas) return;

    gl.useProgram(prog);
    gl.viewport(0, 0, glCanvas.width, glCanvas.height);

    const h = glCanvas.height;
    gl.uniform2f(uRes,     glCanvas.width, h);
    gl.uniform1f(uAmbient, ambient);
    gl.uniform1f(uExposure, exposure);
    gl.uniform1i(uHasBg,  _hasBg ? 1 : 0);
    gl.uniform1i(uBlend,  BLEND_MAP[blendMode] ?? 0);
    gl.uniform3f(uWall,   sToL(wallColor.r), sToL(wallColor.g), sToL(wallColor.b));

    const active = lamps.filter(l => !l.isOff);
    const n = Math.min(active.length, MAX_LAMPS);
    gl.uniform1i(uLampN, n);

    for (let i = 0; i < n; i++) {
        const l = active[i];
        const baseRadius = 35 + (l.currentBrightness / 4);
        const radiusScale = (_hasBg && blendMode === 'multiply-glow') ? 0.7 : 1.0;
        const radius = baseRadius * 15 * Math.sqrt(lightInfluence) * radiusScale;

        gl.uniform2f(uLampPos[i], l.x, h - l.y);  // flip Y: canvas-top → WebGL-bottom
        gl.uniform3f(uLampRgb[i],
            applyLampCurve(l.currentRgb[0], colorCurve),
            applyLampCurve(l.currentRgb[1], colorCurve),
            applyLampCurve(l.currentRgb[2], colorCurve));
        gl.uniform1f(uLampR[i], radius);
        gl.uniform1f(uLampA[i], Math.min(1.0, 0.6 * lightInfluence));
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bgTex);
    gl.uniform1i(uBg, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
}

export function isWebGLAvailable() { return gl !== null; }

export function destroyWebGL() {
    if (gl) {
        if (prog)  gl.deleteProgram(prog);
        if (bgTex) gl.deleteTexture(bgTex);
        if (posBuf) gl.deleteBuffer(posBuf);
    }
    if (glCanvas) glCanvas.remove();
    gl = null; glCanvas = null; prog = null; bgTex = null; posBuf = null;
    uLampPos.length = uLampRgb.length = uLampR.length = uLampA.length = 0;
}
