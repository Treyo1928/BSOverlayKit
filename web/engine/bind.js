// Reads layer names (Inkscape label or SVG id) and turns them into live bindings.
// The vocabulary is documented in docs/DESIGNING.md — keep the two in sync.
import { makeFx } from "/engine/fx.js";

const SVGNS = "http://www.w3.org/2000/svg";
const INK = "http://www.inkscape.org/namespaces/inkscape";

/** The name a designer gave a layer: Inkscape's label, else the id (Figma exports names as ids). */
export function layerName(el) {
  const label = el.getAttributeNS(INK, "label") ?? el.getAttribute("inkscape:label");
  if (label) return label.trim();
  const id = el.getAttribute("id") ?? "";
  // Figma / Illustrator escape special characters in ids: _x7B_ = {, _x7D_ = }, _x7C_ = |
  return id.replace(/_x([0-9A-F]{2})_/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** "{a.acc | acc} #acc-a fit:300" -> { text: "a.acc | acc", name: "acc-a", fit: "300" } */
export function parseTokens(label) {
  const out = { names: [] };
  if (!label) return out;
  // a plain name ("Score box") is just a name for animations
  if (!/[{}:#]/.test(label) && !/(^|\s)glass(\s|$)/.test(label)) { out.names.push(label); return out; }
  let rest = label.replace(/\{([^}]*)\}/g, (_, expr) => { out.text = expr.trim(); return " "; });
  for (const tok of rest.split(/\s+/).filter(Boolean)) {
    const m = /^([a-z]+):(.*)$/i.exec(tok);
    if (tok.startsWith("#")) out.names.push(tok.slice(1));
    else if (tok === "glass") out.glass = "";
    else if (m && KNOWN.has(m[1].toLowerCase())) out[m[1].toLowerCase()] = m[2];
    else out.names.push(tok);                      // a plain name is also an animation target
  }
  return out;
}
const KNOWN = new Set(["img", "bar", "vbar", "show", "hide", "color", "stroke", "feed", "repeat", "state", "when", "fit", "pulse", "enter", "widget", "fx", "glass", "slide", "tugbar"]);

// ---------------------------------------------------------------- expressions
/** Resolve "a.name", "pool.3.cover" (1-based), "item.name", with scene vars ("big" -> "a"). */
export function resolve(ctx, path) {
  if (path === undefined || path === "") return undefined;
  if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
  if (/^["'].*["']$/.test(path)) return path.slice(1, -1);
  const parts = path.split(".");
  if (ctx.$vars?.[parts[0]]) parts.splice(0, 1, ...ctx.$vars[parts[0]].split("."));
  let v = ctx;
  for (const p of parts) {
    if (v == null) return undefined;
    if (Array.isArray(v) && /^\d+$/.test(p)) v = v[Number(p) - 1];
    else v = v[p];
  }
  return v;
}

export const FILTERS = {
  acc: (v) => (typeof v === "number" ? (v * 100).toFixed(2) + "%" : "—"),
  pct: (v) => (typeof v === "number" ? Math.round(v * 100) + "%" : "—"),
  int: (v) => (typeof v === "number" ? Math.round(v).toLocaleString("en-US") : v ?? ""),
  num: (v, d = "0") => (typeof v === "number" ? v.toFixed(Number(d)) : v ?? ""),
  upper: (v) => String(v ?? "").toUpperCase(),
  lower: (v) => String(v ?? "").toLowerCase(),
  time: (v) => (typeof v === "number" ? `${Math.floor(v / 60)}:${String(Math.floor(v % 60)).padStart(2, "0")}` : v ?? ""),
  countdown: (v) => {
    const left = Math.max(0, ((Number(v) || 0) - Date.now()) / 1000);
    return left > 0 ? `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, "0")}` : "0:00";
  },
  flag: (v) => (v && v.length === 2 ? String.fromCodePoint(...[...v.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0))) : ""),
  or: (v, d = "") => (v === undefined || v === null || v === "" ? d.replace(/^["']|["']$/g, "") : v),
  // a difference of two accuracies as percentage points, without its sign: 0.0042 -> "0.42%"
  gap: (v) => (typeof v === "number" ? (Math.abs(v) * 100).toFixed(2) + "%" : ""),
  first: (v) => String(v ?? "").trim().charAt(0).toUpperCase(),
  plus: (v, n = "1") => (typeof v === "number" ? v + Number(n) : v),
  ordinal: (v) => (typeof v === "number" ? v + (["th", "st", "nd", "rd"][(v % 100 - 20) % 10] || ["th", "st", "nd", "rd"][v % 100] || "th") : v),
};
const NUMERIC = new Set(["acc", "pct", "int", "num"]);

/** "a.acc | acc" -> { value (raw), text (formatted), numeric filter name } */
export function evalText(ctx, expr) {
  const [path, ...filters] = expr.split("|").map((s) => s.trim());
  let v = resolve(ctx, path);
  const raw = v;
  let numericFilter = null;
  for (const f of filters) {
    const [name, arg] = f.split(":").map((s) => s.trim());
    const fn = FILTERS[name];
    if (!fn) continue;
    if (NUMERIC.has(name)) numericFilter = { name, arg };
    v = fn(v, arg);
  }
  if (v === undefined || v === null) v = "";
  return { raw, text: String(v), numericFilter };
}

/** "phase=playing|finished", "!match.winner", "a.points>1", "a.leading" */
export function evalCond(ctx, cond) {
  cond = cond.trim();
  if (cond.startsWith("!")) return !evalCond(ctx, cond.slice(1));
  const m = /^([^=!<>]+)(!=|=|>=|<=|>|<)(.*)$/.exec(cond);
  if (!m) { const v = resolve(ctx, cond); return Array.isArray(v) ? v.length > 0 : !!v; }
  const v = resolve(ctx, m[1]);
  const rhs = m[3].split("|");
  switch (m[2]) {
    case "=": return rhs.some((r) => String(v) === r);
    case "!=": return rhs.every((r) => String(v) !== r);
    case ">": return Number(v) > Number(m[3]);
    case "<": return Number(v) < Number(m[3]);
    case ">=": return Number(v) >= Number(m[3]);
    case "<=": return Number(v) <= Number(m[3]);
  }
  return false;
}

// ---------------------------------------------------------------- binding collection
/**
 * Walk an SVG subtree and collect bindings. `scope` lets repeat clones resolve `item.…`.
 * Returns { bindings: [...], names: Map(name -> [elements]), feeds: [...] }.
 */
export function collect(root, env) {
  const result = { bindings: [], names: new Map(), feeds: [], repeats: [], fx: [] };
  const walk = (el, inRepeat) => {
    if (!(el instanceof SVGElement)) return;
    const t = parseTokens(layerName(el));
    // a glass shape gets a group around it (the frosted background, then the shape): names, show:/hide: and
    // entrances apply to that group, so both move and hide together
    const shape = el;
    if (t.glass !== undefined) el = glass(el, t.glass, env);
    for (const n of t.names) {
      if (!result.names.has(n)) result.names.set(n, []);
      result.names.get(n).push(el);
    }
    if (t.enter !== undefined) (result.enter ??= []).push({ el, order: Number(t.enter) || 0 });
    if (t.pulse) result.bindings.push(pulseBinding(el, t.pulse, env));
    if (t.text !== undefined) result.bindings.push(textBinding(el, t.text, t.fit, env));
    else if (el.tagName === "text" && /\{[^}]+\}/.test(el.textContent)) result.bindings.push(templateBinding(el, t.fit));
    if (t.img) result.bindings.push(imgBinding(el, t.img));
    if (t.bar !== undefined) result.bindings.push(barBinding(el, t.bar, false));
    if (t.vbar !== undefined) result.bindings.push(barBinding(el, t.vbar, true));
    if (t.slide !== undefined) result.bindings.push(slideBinding(el, t.slide));
    if (t.tugbar !== undefined) result.bindings.push(tugbarBinding(el, t.tugbar));
    if (t.show !== undefined || t.hide !== undefined) result.bindings.push(visBinding(el, t.show, t.hide));
    if (t.color !== undefined) result.bindings.push(colorBinding(shape, t.color, "fill", env));
    if (t.stroke !== undefined) result.bindings.push(colorBinding(shape, t.stroke, "stroke", env));
    if (t.glass !== undefined) return;
    if (t.state !== undefined) result.bindings.push(stateBinding(el, t.state));
    if (t.feed !== undefined || t.widget !== undefined) {
      const id = t.feed !== undefined ? `feed:${t.feed}` : `widget:${t.widget}`;
      el.style.fill = "transparent";
      el.style.stroke = el.style.stroke || "none";
      result.feeds.push({ id, el });
    }
    if (t.fx !== undefined && !inRepeat) {
      result.fx.push(makeFx(el, t.fx, env));
      return; // the element is replaced by the effect's canvas
    }
    if (t.repeat !== undefined && !inRepeat) {
      result.repeats.push(repeatBinding(el, t.repeat, env));
      return; // its children are a template, bound per clone
    }
    for (const c of [...el.children]) walk(c, inRepeat);
  };
  walk(root, false);
  result.bindings.push(...result.repeats);
  return result;
}

// ---------------------------------------------------------------- frosted glass
// A shape named `glass` shows the scene's background blurred behind its own fill (the fill is the glass's tint, so
// give it some transparency). The blur is made ONCE per background picture, small, on a canvas; each glass shape then
// just draws that picture clipped to its outline, lined up with the real background. So it costs nothing per frame:
// CSS backdrop-filter would blur again every frame the particles move, which OBS's CPU-drawn browser can't afford.
// It is the background picture that shows through, not whatever else is behind the shape (video, particles).
const frosts = new Map();            // "src|blur|…" -> Promise<blob URL>
let glassCount = 0;
function frost(src, o = {}) {
  const blur = Number(o.blur ?? 14), brightness = Number(o.brightness ?? 1.5), saturate = Number(o.saturate ?? 1.35);
  const key = [src, blur, brightness, saturate].join("|");
  if (!frosts.has(key)) {
    frosts.set(key, (async () => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const k = 4, w = 1920 / k, h = 1080 / k, r = blur / k, pad = Math.ceil(r * 3) + 2;
      const canvas = (cw, ch) => Object.assign(document.createElement("canvas"), { width: cw, height: ch });
      // the picture with its edges stretched outward, so the blur has something to read beyond them
      const a = canvas(w + 2 * pad, h + 2 * pad), ax = a.getContext("2d");
      ax.drawImage(img, 0, 0, a.width, a.height);
      ax.drawImage(img, 0, 0, img.naturalWidth, 1, pad, 0, w, pad);
      ax.drawImage(img, 0, img.naturalHeight - 1, img.naturalWidth, 1, pad, pad + h, w, pad);
      ax.drawImage(img, 0, 0, 1, img.naturalHeight, 0, pad, pad, h);
      ax.drawImage(img, img.naturalWidth - 1, 0, 1, img.naturalHeight, pad + w, pad, pad, h);
      ax.drawImage(img, pad, pad, w, h);
      const b = canvas(a.width, a.height), bx = b.getContext("2d");
      bx.filter = `blur(${r}px) brightness(${brightness}) saturate(${saturate})`;
      bx.drawImage(a, 0, 0);
      const c = canvas(w, h);
      c.getContext("2d").drawImage(b, -pad, -pad);
      const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.92));
      return URL.createObjectURL(blob);
    })().catch((e) => { console.warn(`glass: ${src}: ${e.message}`); return ""; }));
  }
  return frosts.get(key);
}

/** Wrap a glass shape in a group holding the blurred background (clipped to the shape) under it. Returns the group. */
function glass(el, value, env) {
  const host = document.createElementNS(SVGNS, "g");
  el.parentNode.insertBefore(host, el);
  const tf = el.getAttribute("transform");            // the shape's own position applies to both
  if (tf) { host.setAttribute("transform", tf); el.removeAttribute("transform"); }
  if (el.style.display === "none") { host.style.display = "none"; el.style.display = ""; }
  host.append(el);
  const bg = env.glass;
  if (!bg?.src || !/^(path|rect|circle|ellipse|polygon)$/.test(el.tagName)) return host;
  const clip = document.createElementNS(SVGNS, "clipPath");
  clip.id = `bso-glass-${++glassCount}`;
  const outline = el.cloneNode(false);
  for (const a of [...outline.attributes]) if (!/^(d|x|y|width|height|rx|ry|cx|cy|r|points)$/.test(a.name)) outline.removeAttribute(a.name);
  clip.append(outline);
  // where the page's top-left corner is, seen from the shape: undo every transform above it (Inkscape layers and
  // groups, repeat: copies), so the blurred picture sits exactly on the real background
  const img = document.createElementNS(SVGNS, "image");
  for (const [k, v] of Object.entries({ x: 0, y: 0, width: 1920, height: 1080, preserveAspectRatio: "none" })) img.setAttribute(k, v);
  img.classList.add("bso-glass-bg");
  img.__bsoAlign = () => {
    let m = new DOMMatrix();
    for (let n = host; n && n.tagName !== "svg"; n = n.parentNode) {
      const t = n.transform?.baseVal?.consolidate?.()?.matrix;
      if (t) m = new DOMMatrix([t.a, t.b, t.c, t.d, t.e, t.f]).multiply(m);
    }
    const i = m.inverse();
    img.setAttribute("transform", `matrix(${i.a} ${i.b} ${i.c} ${i.d} ${i.e} ${i.f})`);
  };
  img.__bsoAlign();
  const behind = document.createElementNS(SVGNS, "g");
  behind.setAttribute("clip-path", `url(#${clip.id})`);
  behind.append(img);
  host.insertBefore(behind, el);
  host.insertBefore(clip, behind);
  const blur = Number(value) > 0 ? { ...bg.options, blur: Number(value) } : bg.options;
  frost(bg.src, blur).then((url) => { if (url) img.setAttribute("href", url); });
  return host;
}

// ---------------------------------------------------------------- binding kinds
function textEl(el) {
  if (el.tagName === "text") return el;
  return el.querySelector("text");
}

function textBinding(el, expr, fit, env) {
  const text = textEl(el);
  if (!text) return { update() {} };
  // keep the first line's formatting, drop the other lines
  const spans = [...text.querySelectorAll("tspan")];
  const target = spans[0] ?? text;
  spans.slice(1).forEach((s) => s.remove());
  const baseSize = parseFloat(getComputedStyle(text).fontSize) || null;
  let shown = null, tween = null, last = null;
  const set = (s) => {
    if (last === s) return;
    last = s;
    target.textContent = s;
    if (fit) fitText(text, Number(fit), baseSize);
  };
  return {
    update(ctx) {
      const r = evalText(ctx, expr);
      const ms = env.tween ?? 250;
      if (r.numericFilter && typeof r.raw === "number" && ms > 0 && typeof shown === "number" && Math.abs(r.raw - shown) > 1e-9) {
        // count toward the new value
        const from = tween?.current ?? shown, to = r.raw, start = performance.now(), f = r.numericFilter;
        tween = { current: from };
        const me = tween;
        const step = (now) => {
          if (tween !== me) return;
          const k = Math.min(1, (now - start) / ms), e = 1 - Math.pow(1 - k, 3);
          me.current = from + (to - from) * e;
          set(FILTERS[f.name](me.current, f.arg));
          if (k < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      } else if (!tween || typeof r.raw !== "number") {
        tween = null;
        set(r.text);
      }
      shown = r.raw;
    },
  };
}

/** Text typed with placeholders right in Inkscape: "MAP {match.mapNumber}", "BAN {item.byName | upper}". */
function templateBinding(text, fit) {
  const spans = [...text.querySelectorAll("tspan")];
  const target = spans[0] ?? text;
  const template = text.textContent.replace(/\s+/g, " ").trim();
  spans.slice(1).forEach((s) => s.remove());
  const baseSize = parseFloat(getComputedStyle(text).fontSize) || null;
  let last = null;
  return {
    update(ctx) {
      const s = template.replace(/\{([^}]+)\}/g, (_, expr) => evalText(ctx, expr).text);
      if (last === s) return;
      last = s;
      target.textContent = s;
      if (fit) fitText(text, Number(fit), baseSize);
    },
  };
}

/** Shrink text to fit maxWidth, but never below 70 % size — past that, cut it off with "…". */
function fitText(text, maxWidth, baseSize) {
  if (!baseSize) return;
  text.style.fontSize = `${baseSize}px`;
  const w = text.getComputedTextLength?.() ?? 0;
  if (w <= maxWidth) return;
  const scale = maxWidth / w;
  // a figure is never cut short ("12…" for 1234 misses reads as twelve): it shrinks as far as it must
  const figure = /^[\d\s.,:%+\-–—x×]*$/.test(text.textContent);
  if (scale >= 0.7 || figure) { text.style.fontSize = `${baseSize * scale}px`; return; }
  text.style.fontSize = `${baseSize * 0.7}px`;
  const span = text.querySelector("tspan") ?? text;
  let s = span.textContent;
  while (s.length > 1 && text.getComputedTextLength() > maxWidth) {
    s = s.slice(0, -1);
    span.textContent = s.trimEnd() + "…";
  }
}

function imgBinding(el, path) {
  const img = el.tagName === "image" ? el : el.querySelector("image");
  if (!img) return { update() {} };
  // fills its box, cropped (avatars, covers); a picture that must be seen whole (a logo) says so itself in the SVG
  if (!img.hasAttribute("preserveAspectRatio")) img.setAttribute("preserveAspectRatio", "xMidYMid slice");
  let cur = null;
  return {
    update(ctx) {
      const v = resolve(ctx, path) || "";
      if (v === cur) return;
      cur = v;
      img.setAttribute("href", v);
      img.setAttributeNS("http://www.w3.org/1999/xlink", "href", v);
      img.style.visibility = v ? "" : "hidden";
    },
  };
}

function barBinding(el, path, vertical) {
  const r = el.tagName === "rect" ? el : el.querySelector("rect");
  if (!r) return { update() {} };
  const W = parseFloat(r.getAttribute("width")), H = parseFloat(r.getAttribute("height")), Y = parseFloat(r.getAttribute("y"));
  r.style.transition = "width .25s linear, height .25s linear, y .25s linear";
  return {
    update(ctx) {
      const v = Math.max(0, Math.min(1, Number(resolve(ctx, path)) || 0));
      if (vertical) { r.setAttribute("height", String(H * v)); r.setAttribute("y", String(Y + H * (1 - v))); }
      else r.setAttribute("width", String(W * v));
    },
  };
}

/**
 * slide:tug*1432: the layer moves sideways with a 0..1 value, 1432 px from 0 to 1 (slide:tug*1432*18: but never
 * closer than 18 px to either end). Draw it where it sits at 0.5
 * (the middle of the bar it rides on). Moves at the same pace a bar: on the same value grows.
 */
function slideBinding(el, spec) {
  const [path, span, inset] = spec.split("*");
  const distance = Number(span) || 0;
  // a third number keeps it that many pixels inside each end (slide:tug*1432*18): a marker that stays on its bar
  const most = Math.max(0, distance / 2 - (Number(inset) || 0));
  el.style.transition = "transform .25s linear";
  return {
    update(ctx) {
      const raw = Number(resolve(ctx, path));
      const v = Math.max(0, Math.min(1, Number.isFinite(raw) ? raw : 0.5));
      el.style.transform = `translateX(${Math.max(-most, Math.min(most, (v - 0.5) * distance))}px)`;
    },
  };
}

/**
 * tugbar:diff on a group: a "who is winning" bar that picks its own scale. The value is a lead (a - b, as a
 * fraction: 0.012 = 1.2 points to a). The bar shows it on the smallest scale it fits comfortably (1 %, 2 %, 4 % …
 * up to 100 % for half the bar) and changes scale as the lead grows or settles: the tick marks squeeze together and
 * new ones come in from the ends (zooming out), or spread and leave (zooming in). So a close map uses the whole bar
 * and a blow-out still fits on it. Layers inside the group, by name:
 *   #win-fill    a rect, drawn at its full width: side a's colour, growing from the left. Its x and width are the
 *                span the edge travels (the middle of it is level)
 *   #win-edge    what rides the end of the fill (drawn at the middle)
 *   #win-tick    one tick mark, drawn at the middle: copied for every tick (three a side)
 *   #win-scale-a / #win-scale-b   optional texts: the scale ("4%"), for the two ends
 *   #win-lead-a-out / -a-in / -b-out / -b-in   optional: the lead written beside the edge. "out" = on the far side
 *                of the edge from the middle (a small lead, so it never sits on the middle mark), "in" = between
 *                the edge and the middle (a big one). One of the four shows, none when level.
 */
const TUG_STEPS = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1];
const TUG_ZOOM_MS = 1100, TUG_MOVE_MS = 250, TUG_CALM_MS = 4000;
function tugbarBinding(group, path) {
  const find = (n) => [...group.querySelectorAll("*")].find((e) => parseTokens(layerName(e)).names.includes(n));
  const fill = find("win-fill"), edge = find("win-edge"), tick = find("win-tick");
  if (!fill || !edge) return { update() {} };
  const scales = [find("win-scale-a"), find("win-scale-b")].filter(Boolean);
  const leads = { aOut: find("win-lead-a-out"), aIn: find("win-lead-a-in"), bOut: find("win-lead-b-out"), bIn: find("win-lead-b-in") };
  const W = parseFloat(fill.getAttribute("width")), half = W / 2;
  const tickHost = tick?.parentNode;
  const tickAlpha = Number(tick?.getAttribute("opacity") ?? 1);
  tick?.remove();
  fill.style.transition = "none";
  const marksOf = (s) => [-3, -2, -1, 1, 2, 3].map((k) => Math.round(((k * s) / 4) * 1e5));
  const ticks = new Map();                           // lead (in 1/100000) -> its mark
  // Everything on the bar is drawn from two numbers, each frame, by one clock: the lead shown and the scale shown.
  // A zoom is the scale shown gliding from the old scale to the new one: on the way, the edge and every tick sit
  // where they belong on the scale of that instant. So the old ticks really do slide toward the middle, the new
  // scale's ticks slide in from beyond the ends (the bar's outline clips them until they arrive), and the edge moves
  // with them. That is what makes it read as zooming rather than as a jump.
  let scale = 0.02, calmSince = 0, first = true;     // the scale in force (what the lead is judged against)
  let lead = 0, leadFrom = 0, leadTo = 0, leadT0 = 0, leadMs = 0;
  let shownScale = scale, zoomFrom = scale, zoomTo = scale, zoomT0 = 0, zoomMs = 0;
  let frame = 0, drawnSide = null;
  const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
  function draw(now) {
    const kl = leadMs > 0 ? Math.min(1, (now - leadT0) / leadMs) : 1;
    lead = leadFrom + (leadTo - leadFrom) * kl;
    const kz = zoomMs > 0 ? Math.min(1, (now - zoomT0) / zoomMs) : 1;
    // in proportion (log), so each moment of the zoom looks like the same rate of zooming
    shownScale = kz >= 1 ? zoomTo : Math.exp(Math.log(zoomFrom) + (Math.log(zoomTo) - Math.log(zoomFrom)) * ease(kz));
    const p = Math.max(-1, Math.min(1, lead / shownScale));       // -1 (all b) .. 1 (all a)
    fill.setAttribute("width", String(W * (0.5 + p / 2)));
    edge.setAttribute("transform", `translate(${p * half} 0)`);
    if (tickHost) {
      const want = new Set(marksOf(zoomTo));
      for (const key of [...want, ...(kz < 1 ? marksOf(zoomFrom) : [])]) {
        if (ticks.has(key)) continue;
        const el = tick.cloneNode(true);
        tickHost.append(el);
        ticks.set(key, el);
      }
      for (const [key, el] of ticks) {
        const x = (key / 1e5 / shownScale) * half;
        // a mark of the scale being left fades as it goes; one of the scale arriving is there from the start
        const alpha = want.has(key) ? 1 : 1 - kz;
        if (alpha <= 0) { el.remove(); ticks.delete(key); continue; }
        el.setAttribute("transform", `translate(${x} 0)`);
        el.style.opacity = String(tickAlpha * alpha);
      }
    }
    // which side of the edge the lead is written on: decided from where the edge is
    const side = lead > 0 ? (p >= 0.34 ? "aIn" : "aOut") : lead < 0 ? (p <= -0.34 ? "bIn" : "bOut") : "";
    if (side !== drawnSide) {
      drawnSide = side;
      for (const [k, el] of Object.entries(leads)) if (el) el.style.display = k === side ? "" : "none";
    }
    frame = kl < 1 || kz < 1 ? requestAnimationFrame(draw) : 0;
  }
  return {
    update(ctx) {
      const raw = Number(resolve(ctx, path));
      const d = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0, size = Math.abs(d), now = performance.now();
      let next = scale;
      if (size > 0.85 * scale) {                     // near the end: out to the first scale it sits well inside
        next = TUG_STEPS.find((s) => size <= 0.7 * s) ?? 1;
        calmSince = 0;
      } else {                                       // well inside a smaller scale, and has been for a while: in
        const snug = TUG_STEPS.find((s) => size <= 0.5 * s) ?? 1;
        if (snug < scale) { calmSince ||= now; if (now - calmSince >= TUG_CALM_MS) { next = snug; calmSince = 0; } }
        else calmSince = 0;
      }
      if (next !== scale || first) {
        zoomFrom = first ? next : shownScale; zoomTo = next; zoomT0 = now; zoomMs = first ? 0 : TUG_ZOOM_MS;
        for (const el of scales) {
          (el.querySelector("tspan") ?? el).textContent = `${Math.round(next * 100)}%`;
          const fit = Number(parseTokens(layerName(el)).fit);
          if (fit) fitText(el, fit, (el.__bsoSize ??= parseFloat(getComputedStyle(el).fontSize)));
        }
        scale = next;
      }
      if (d !== leadTo || first) { leadFrom = first ? d : lead; leadTo = d; leadT0 = now; leadMs = first ? 0 : TUG_MOVE_MS; }
      first = false;
      if (!frame) frame = requestAnimationFrame(draw);
    },
  };
}

/** show: and hide: on the same layer must both agree (show if X AND NOT Y). */
function visBinding(el, showCond, hideCond) {
  el.style.display = "";            // hidden with Inkscape's eye icon? the engine decides now
  el.style.transition = "opacity .25s";
  let cur = null;
  return {
    update(ctx) {
      const on = (showCond === undefined || evalCond(ctx, showCond)) && (hideCond === undefined || !evalCond(ctx, hideCond));
      if (on === cur) return;
      cur = on;
      el.style.opacity = on ? "" : "0";
      el.style.visibility = on ? "" : "hidden";
    },
  };
}

function colorBinding(el, spec, prop, env) {
  return {
    update(ctx) {
      const key = ctx.$vars?.[spec] ?? spec;
      let v = env.colors?.[key] ? key : resolve(ctx, spec);
      const color = env.colors?.[v] ?? (typeof v === "string" && /^#|^rgb/.test(v) ? v : null);
      el.style[prop] = color ?? "";
    },
  };
}

function stateBinding(el, path) {
  const kids = [...el.children].filter((c) => c instanceof SVGElement).map((c) => ({ el: c, when: parseTokens(layerName(c)).when }));
  for (const k of kids) { k.el.style.transition = "opacity .3s"; if (k.when !== undefined) k.el.style.display = ""; }
  let cur;
  return {
    update(ctx) {
      const v = String(resolve(ctx, path) ?? "");
      if (v === cur) return;
      cur = v;
      const match = kids.find((k) => k.when !== undefined && k.when.split("|").includes(v)) ?? kids.find((k) => k.when === "else");
      for (const k of kids) {
        if (k.when === undefined) continue;   // children without when: are always shown
        const on = k === match;
        k.el.style.opacity = on ? "" : "0";
        k.el.style.visibility = on ? "" : "hidden";
      }
    },
  };
}

function pulseBinding(el, path, env) {
  let prev;
  return {
    update(ctx) {
      const v = Number(resolve(ctx, path));
      if (prev !== undefined && v > prev) env.play?.(el, { play: "pulse" });
      prev = v;
    },
  };
}

/** Line the blurred background of every glass shape under `root` up again, after `root` (or a parent) has moved. */
export function realignGlass(root) {
  for (const img of root.querySelectorAll?.("image.bso-glass-bg") ?? []) img.__bsoAlign?.();
}

/** repeat:pool — the group's children are a template, cloned once per item and offset by dx/dy. */
function repeatBinding(group, path, env) {
  const template = document.createElementNS(SVGNS, "g");
  for (const c of [...group.childNodes]) template.append(c);
  const clones = [];
  const base = env.repeat?.[path] ?? env.repeat?.[path.split(".").pop()] ?? {};
  let bbox = null;
  // where copy i of n goes. A list longer than a layout's `over:` key gets that layout instead (the biggest key
  // that applies): a pool of 7 in one row, a pool of 11 smaller and in two.
  const place = (i, n) => {
    let layout = base, most = -1;
    for (const [k, v] of Object.entries(base.over ?? {})) if (n > Number(k) && Number(k) > most) { most = Number(k); layout = { ...base, ...v }; }
    const s = layout.scale ?? 1;
    const dx = layout.dx ?? (layout.dy !== undefined ? 0 : bbox.width * s + (layout.gap ?? 20));
    const dy = layout.dy ?? 0;
    const wrap = layout.wrap ?? 0, rowH = layout.rowHeight ?? bbox.height * s + (layout.gap ?? 20);
    // scaled around the template's top-left corner, so `scale` alone leaves the first copy's corner where it was drawn
    const at = (x, y) => `translate(${x + bbox.x * (1 - s)} ${y + bbox.y * (1 - s) + (layout.y ?? 0)})${s === 1 ? "" : ` scale(${s})`}`;
    if (wrap && typeof layout.center === "number") {
      // rows as even as they can be, the longer ones last (11 in rows of at most 6: 5 over 6), each centred on x = center
      const rows = Math.ceil(n / wrap), short = Math.floor(n / rows), longRows = n % rows;
      let row = 0, first = 0, len = rows - longRows > 0 ? short : short + 1;
      while (i >= first + len) { first += len; row++; len = row >= rows - longRows ? short + 1 : short; }
      // width: one copy's width as drawn, where the template's own outline is not it (placeholder text that runs wider)
      const left = layout.center - ((len - 1) * dx + (layout.width ?? bbox.width) * s) / 2;
      return at(left - bbox.x + (i - first) * dx, row * rowH);
    }
    // center: true = the row stays centred on where the template was drawn (3 or 5 map tabs, 1 or 2 players)
    if (layout.center && !wrap) return at((i - (n - 1) / 2) * dx + (bbox.width * (1 - s)) / 2, (i - (n - 1) / 2) * dy);
    const col = wrap ? i % wrap : i, row = wrap ? Math.floor(i / wrap) : 0;
    return at(col * dx, row * rowH + col * dy);
  };
  return {
    repeat: path,
    clones,
    update(ctx) {
      const items = resolve(ctx, path) ?? [];
      if (!bbox) {
        group.append(template);
        bbox = template.getBBox();
        template.remove();
      }
      while (clones.length < items.length) {
        const g = template.cloneNode(true);
        // in its place before its layers are read: a glass shape lines its background up with where it is
        g.setAttribute("transform", place(clones.length, items.length));
        group.append(g);
        clones.push({ g, sub: collect(g, env) });
      }
      while (clones.length > items.length) clones.pop().g.remove();
      // a list that grew or shrank can move every copy (a centred row, a pool that now needs two rows)
      clones.forEach((c, i) => {
        const t = place(i, items.length);
        if (c.g.getAttribute("transform") !== t) { c.g.setAttribute("transform", t); realignGlass(c.g); }
      });
      clones.forEach((c, i) => {
        const sub = { ...ctx, item: items[i], index: i + 1 };
        for (const b of c.sub.bindings) b.update(sub);
      });
    },
  };
}
