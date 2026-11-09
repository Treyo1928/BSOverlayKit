// Live particle effects (WebGL). A rectangle named `fx:dust` or `fx:glitter` in a design becomes a canvas
// of exactly that size and place, in the same spot in the layer order. Every particle is computed on the
// GPU from its number and the time, so nothing runs per particle on the CPU and it costs almost nothing
// while the scene is off stream (the loop stops).
//
// Settings come from the preset, then the scene's rules file:
//   fx:
//     dust: { amount: 1.2, color: "#ffedbf" }        # tweak a preset
//     floor: { preset: glitter, band: 140 }          # or a new named effect: layer fx:floor
// Every key is listed in PRESETS below; docs/DESIGNING.md explains them for designers.

const SVGNS = "http://www.w3.org/2000/svg";
const XHTML = "http://www.w3.org/1999/xhtml";

/** Sizes and distances are pixels at 1920 × 1080. Ranges are [min, max]. */
export const PRESETS = {
  // Gold dust and bokeh drifting up, thick at the bottom edge and gone by 60 % up the screen.
  dust: {
    color: "#ffedbf",
    count: 420,            // particles across a full 1920-wide layer (scaled by the layer's width)
    amount: 1,             // multiplies count, so 0.5 = half as busy
    opacity: 1,
    // height above the bottom edge: a mix of two exponential falloffs (px where density halves ≈ 0.7 × value)
    near: 95, far: 260, nearShare: 0.7, top: 650,
    size: [5, 15],         // the usual soft discs
    sharp: 0.08,           // share of small hard specks
    sharpSize: [2, 5],
    big: 0.05,             // share of large faint bokeh
    bigSize: [16, 40],
    rings: 2,              // hollow bokeh rings (count, not share)
    rise: [30, 130],       // how far each particle drifts up during its life
    sway: 18,              // sideways wander
    life: [6, 14],         // seconds each particle lives (fades in and out)
    twinkle: 0.15,         // 0 = steady, 1 = sparkles strongly
    clouds: 0.6,           // patchy, sparkly gold dust along the bottom edge (0 = none)
    cloudHeight: 70,
  },
  // A dense, twinkling bed of glitter along the bottom edge.
  glitter: {
    color: "#ffeeca",
    count: 900,
    amount: 1,
    opacity: 1,
    near: 55, far: 130, nearShare: 0.75, top: 200,
    size: [2.5, 6],
    sharp: 0.5,
    sharpSize: [1.5, 3.5],
    big: 0.03,
    bigSize: [8, 18],
    rings: 0,
    rise: [0, 18],
    sway: 6,
    life: [1.5, 4.5],
    twinkle: 0.8,
    clouds: 1,
    cloudHeight: 40,
  },
};

const VERT = `
attribute float a_id;
uniform float u_time, u_count, u_rings;
uniform vec2 u_res;
uniform vec4 u_size, u_sharpSize, u_bigSize;   // xy = range
uniform float u_sharp, u_big;
uniform vec4 u_height;                         // near, far, nearShare, top
uniform vec2 u_rise, u_life;
uniform float u_sway, u_twinkle;
varying float v_kind, v_alpha;

float h(float n) { return fract(sin(n * 12.9898 + 78.233) * 43758.5453); }
float h2(float a, float b) { return h(a * 0.6180339 + b * 1.3247179 + 0.5); }

void main() {
  float id = a_id;
  // fixed per particle: its kind and timing
  float kindRoll = h2(id, 7.0);
  float kind = id < u_rings ? 3.0 : kindRoll < u_big ? 2.0 : kindRoll < u_big + u_sharp ? 1.0 : 0.0;
  float life = mix(u_life.x, u_life.y, h2(id, 3.0));
  float local = u_time / life + h2(id, 5.0);
  float cycle = floor(local), k = fract(local);
  // new place and look every life cycle
  float s = id * 17.0 + cycle * 101.0;
  float x = h2(s, 1.0) * u_res.x;
  float u = max(h2(s, 2.0), 1e-4);
  float z = (h2(s, 4.0) < u_height.z ? u_height.x : u_height.y) * -log(u);
  if (z > u_height.w) z = h2(s, 6.0) * u_height.w * 0.6;
  z += mix(u_rise.x, u_rise.y, h2(s, 8.0)) * k;
  x += sin(u_time * (0.15 + 0.25 * h2(s, 9.0)) + h2(s, 10.0) * 6.283) * u_sway;
  vec2 range = kind == 1.0 ? u_sharpSize.xy : kind >= 2.0 ? u_bigSize.xy : u_size.xy;
  float size = mix(range.x, range.y, pow(h2(s, 11.0), 1.6));
  if (kind == 3.0) size = mix(26.0, 34.0, h2(s, 11.0));
  // fade in and out over the life, dimmer higher up, optional twinkle
  float a = smoothstep(0.0, 0.15, k) * (1.0 - smoothstep(0.75, 1.0, k));
  a *= mix(0.55, 1.0, h2(s, 12.0));
  a *= 1.0 - smoothstep(u_height.w * 0.5, u_height.w, z);
  float tw = 0.5 + 0.5 * sin(u_time * mix(2.0, 7.0, h2(s, 13.0)) + h2(s, 14.0) * 6.283);
  a *= mix(1.0, tw * tw * 1.6, u_twinkle);
  if (kind == 2.0) a *= 0.7;
  if (kind == 3.0) a *= 0.55;
  v_kind = kind;
  v_alpha = a;
  vec2 p = vec2(x, u_res.y - z);
  gl_Position = vec4(p / u_res * 2.0 - 1.0, 0.0, 1.0);
  gl_Position.y = -gl_Position.y;
  gl_PointSize = size;
}`;

const FRAG = `
precision mediump float;
uniform vec3 u_color;
uniform float u_opacity;
varying float v_kind, v_alpha;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  if (r > 1.0) discard;
  float a;
  if (v_kind == 1.0) a = 1.0 - smoothstep(0.55, 1.0, r);                         // hard speck
  else if (v_kind == 3.0) a = smoothstep(0.2, 0.0, abs(r - 0.8)) + 0.12 * (1.0 - r); // ring
  else a = pow(1.0 - smoothstep(0.25, 1.0, r), 1.3);                               // soft disc / bokeh
  a *= v_alpha * u_opacity;
  // premultiplied alpha: the colour may never be brighter than its alpha. (It used to be, for a little extra glow,
  // which is an invalid pixel: compositors are free to draw anything for it, and headless Chromium drew solid cream.)
  gl_FragColor = vec4(u_color * a, a);
}`;

// The dust haze: soft drifting noise along the bottom edge, speckled so it reads as dust, not fog.
const CLOUD_VERT = `attribute vec2 a_pos; void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;
const CLOUD_FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_res;
uniform float u_time, u_amount, u_height, u_opacity;
uniform vec3 u_color;
// A hash without sin() of big numbers: that one overflows at medium precision (about 65,000 max) past a diagonal
// line across the screen, and every grain beyond it lit up (solid cream on GPUs that honour mediump).
float hash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
void main() {
  vec2 px = vec2(gl_FragCoord.x, gl_FragCoord.y);   // y = 0 at the bottom edge
  float mask = exp(-px.y / u_height);
  if (mask < 0.01) discard;
  vec2 p = px / 230.0;
  float n = fbm(p + vec2(u_time * 0.018, -u_time * 0.01));
  float m = fbm(p * 0.55 - vec2(u_time * 0.011, 0.0) + 7.3);
  float cloud = smoothstep(0.45, 0.9, n * 0.65 + m * 0.55);
  // sparkly sand: bright 2-3 px grains that stay put and twinkle smoothly (never re-randomised per step,
  // which reads as a low frame rate), denser where the cloud is thick
  vec2 c1 = floor(px / 2.0), c2 = floor(px / 3.0) + 71.3;
  float t1 = 0.5 + 0.5 * sin(u_time * (1.2 + 2.5 * hash(c1 + 3.7)) + hash(c1 + 9.1) * 6.283);
  float t2 = 0.5 + 0.5 * sin(u_time * (0.8 + 1.8 * hash(c2 + 5.3)) + hash(c2 + 2.9) * 6.283);
  float sparkle = step(1.0 - 0.18 * cloud, hash(c1)) * t1 * t1 + 0.8 * step(0.97, hash(c2)) * cloud * t2;
  float dust = cloud * 0.28 + sparkle * (0.35 + 0.65 * cloud);
  float a = min(dust * mask * u_amount * u_opacity, 1.0);
  gl_FragColor = vec4(u_color * a, a);              // premultiplied (see the dust shader)
}`;

const hex = (c) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c).trim());
  const n = m ? parseInt(m[1], 16) : 0xffffff;
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
};
const pair = (v, d) => (Array.isArray(v) ? [Number(v[0]), Number(v[1] ?? v[0])] : v !== undefined ? [Number(v), Number(v)] : d);

function program(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

/** Whether effects are allowed at all: `?nofx` on the overlay URL turns them off (weak PCs). */
export const fxEnabled = () => !new URLSearchParams(location.search).has("nofx");

/**
 * Replace `el` (a rectangle, or anything with a box) with a WebGL canvas running effect `name`.
 * Returns { name, start(), stop() }. Never throws: with no WebGL the layer is simply empty.
 */
export function makeFx(el, name, env) {
  const custom = env.fx?.[name] ?? {};
  const base = PRESETS[custom.preset ?? name];
  const off = { name, start() {}, stop() {} };
  if (!base) { console.warn(`fx:${name}: no preset "${custom.preset ?? name}" (dust, glitter)`); return off; }
  const o = { ...base, ...custom };

  let box;
  if (el.tagName === "rect") box = ["x", "y", "width", "height"].map((k) => parseFloat(el.getAttribute(k)) || 0);
  else { const b = el.getBBox(); box = [b.x, b.y, b.width, b.height]; }
  const [x, y, w, h] = box;
  const fo = document.createElementNS(SVGNS, "foreignObject");
  for (const [k, v] of Object.entries({ x, y, width: w, height: h })) fo.setAttribute(k, String(v));
  if (el.getAttribute("transform")) fo.setAttribute("transform", el.getAttribute("transform"));
  fo.style.pointerEvents = "none";
  el.replaceWith(fo);
  if (!fxEnabled()) return off;
  const count = Math.max(1, Math.round(o.count * o.amount * (w / 1920)));
  const t0 = performance.now() - Math.random() * 60_000;   // start mid-flow, not with an empty screen

  // A WebGL context exists only while the layer is on stream. Browsers allow a page only a handful of contexts
  // (the replay viewers in the video holes need theirs), so a scene off stream gives its contexts back.
  let r = null;
  const create = () => {
    const canvas = document.createElementNS(XHTML, "canvas");
    canvas.width = Math.round(w);
    canvas.height = Math.round(h);
    canvas.style.cssText = "display:block;width:100%;height:100%";
    fo.replaceChildren(canvas);
    const res = setup(canvas, o, count, w, h, t0, name);
    if (res) canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); if (r === res) r = null; });
    return res;
  };
  const release = () => { r?.release(); r = null; fo.replaceChildren(); };

  let raf = 0, stopTimer = 0;
  // inside a layer that show:/hide: has hidden (e.g. the other layout of a scene)? then no context at all
  const shown = () => {
    for (let n = fo; n && !n.classList?.contains("scene-svg"); n = n.parentNode) {
      if (n.style?.visibility === "hidden" || n.style?.display === "none") return false;
    }
    return true;
  };
  const loop = (now) => {
    if (shown()) { r ??= create(); r?.draw(now); }
    else if (r) release();
    raf = requestAnimationFrame(loop);
  };
  return {
    name,
    start() { clearTimeout(stopTimer); if (!raf) raf = requestAnimationFrame(loop); },
    /** keep drawing through the scene's fade-out, then give the context back */
    stop(after = 0) {
      clearTimeout(stopTimer);
      stopTimer = setTimeout(() => { cancelAnimationFrame(raf); raf = 0; release(); }, after);
    },
  };
}

/** Compile and upload everything for one canvas. Returns { draw(now), release() }, or null without WebGL. */
function setup(canvas, o, count, w, h, t0, name) {
  const gl = canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: false, powerPreference: "low-power" });
  if (!gl) { console.warn(`fx:${name}: no WebGL`); return null; }
  let parts, cloud;
  try {
    parts = program(gl, VERT, FRAG);
    cloud = o.clouds > 0 ? program(gl, CLOUD_VERT, CLOUD_FRAG) : null;
  } catch (e) { console.warn(`fx:${name}: ${e.message}`); return null; }

  const ids = new Float32Array(count).map((_, i) => i);
  const idBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, idBuf);
  gl.bufferData(gl.ARRAY_BUFFER, ids, gl.STATIC_DRAW);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  const U = (p, n) => gl.getUniformLocation(p, n);
  const color = hex(o.color);
  const maxPoint = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)?.[1] ?? 64;
  const clampSize = ([a, b]) => [Math.min(a, maxPoint), Math.min(b, maxPoint)];
  gl.useProgram(parts);
  gl.uniform2f(U(parts, "u_res"), w, h);
  gl.uniform1f(U(parts, "u_count"), count);
  gl.uniform1f(U(parts, "u_rings"), o.rings);
  gl.uniform4f(U(parts, "u_size"), ...clampSize(pair(o.size, [3, 10])), 0, 0);
  gl.uniform4f(U(parts, "u_sharpSize"), ...clampSize(pair(o.sharpSize, [3, 8])), 0, 0);
  gl.uniform4f(U(parts, "u_bigSize"), ...clampSize(pair(o.bigSize, [20, 45])), 0, 0);
  gl.uniform1f(U(parts, "u_sharp"), o.sharp);
  gl.uniform1f(U(parts, "u_big"), o.big);
  gl.uniform4f(U(parts, "u_height"), o.near, o.far, o.nearShare, o.top);
  gl.uniform2f(U(parts, "u_rise"), ...pair(o.rise, [30, 130]));
  gl.uniform2f(U(parts, "u_life"), ...pair(o.life, [6, 14]));
  gl.uniform1f(U(parts, "u_sway"), o.sway);
  gl.uniform1f(U(parts, "u_twinkle"), o.twinkle);
  gl.uniform3f(U(parts, "u_color"), ...color);
  gl.uniform1f(U(parts, "u_opacity"), o.opacity);
  const uTime = U(parts, "u_time");
  let cTime;
  if (cloud) {
    gl.useProgram(cloud);
    gl.uniform2f(U(cloud, "u_res"), w, h);
    gl.uniform1f(U(cloud, "u_amount"), o.clouds);
    gl.uniform1f(U(cloud, "u_height"), o.cloudHeight);
    gl.uniform1f(U(cloud, "u_opacity"), o.opacity);
    gl.uniform3f(U(cloud, "u_color"), ...color);
    cTime = U(cloud, "u_time");
  }
  const aId = gl.getAttribLocation(parts, "a_id");
  const aPos = cloud ? gl.getAttribLocation(cloud, "a_pos") : -1;
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.viewport(0, 0, canvas.width, canvas.height);

  return {
    draw(now) {
      const t = (now - t0) / 1000;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (cloud) {
        gl.useProgram(cloud);
        gl.uniform1f(cTime, t);
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.disableVertexAttribArray(aPos);
      }
      gl.useProgram(parts);
      gl.uniform1f(uTime, t);
      gl.bindBuffer(gl.ARRAY_BUFFER, idBuf);
      gl.enableVertexAttribArray(aId);
      gl.vertexAttribPointer(aId, 1, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, count);
      gl.disableVertexAttribArray(aId);
    },
    release() { gl.getExtension("WEBGL_lose_context")?.loseContext(); },
  };
}
