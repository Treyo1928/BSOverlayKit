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
  if (!/[{}:#]/.test(label)) { out.names.push(label); return out; }
  let rest = label.replace(/\{([^}]*)\}/g, (_, expr) => { out.text = expr.trim(); return " "; });
  for (const tok of rest.split(/\s+/).filter(Boolean)) {
    const m = /^([a-z]+):(.*)$/i.exec(tok);
    if (tok.startsWith("#")) out.names.push(tok.slice(1));
    else if (m && KNOWN.has(m[1].toLowerCase())) out[m[1].toLowerCase()] = m[2];
    else out.names.push(tok);                      // a plain name is also an animation target
  }
  return out;
}
const KNOWN = new Set(["img", "bar", "vbar", "show", "hide", "color", "stroke", "feed", "repeat", "state", "when", "fit", "pulse", "enter", "widget", "fx"]);

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
    if (t.show !== undefined || t.hide !== undefined) result.bindings.push(visBinding(el, t.show, t.hide));
    if (t.color !== undefined) result.bindings.push(colorBinding(el, t.color, "fill", env));
    if (t.stroke !== undefined) result.bindings.push(colorBinding(el, t.stroke, "stroke", env));
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
  if (scale >= 0.7) { text.style.fontSize = `${baseSize * scale}px`; return; }
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
  img.setAttribute("preserveAspectRatio", "xMidYMid slice");
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

/** repeat:pool — the group's children are a template, cloned once per item and offset by dx/dy. */
function repeatBinding(group, path, env) {
  const template = document.createElementNS(SVGNS, "g");
  for (const c of [...group.childNodes]) template.append(c);
  const clones = [];
  const layout = env.repeat?.[path] ?? env.repeat?.[path.split(".").pop()] ?? {};
  let bbox = null;
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
      const dx = layout.dx ?? (layout.dy !== undefined ? 0 : bbox.width + (layout.gap ?? 20));
      const dy = layout.dy ?? 0;
      const wrap = layout.wrap ?? 0, rowH = layout.rowHeight ?? bbox.height + (layout.gap ?? 20);
      while (clones.length < items.length) {
        const i = clones.length;
        const g = template.cloneNode(true);
        const col = wrap ? i % wrap : i, row = wrap ? Math.floor(i / wrap) : 0;
        g.setAttribute("transform", `translate(${col * dx} ${row * rowH + col * dy})`);
        group.append(g);
        clones.push({ g, sub: collect(g, env) });
      }
      while (clones.length > items.length) clones.pop().g.remove();
      clones.forEach((c, i) => {
        const sub = { ...ctx, item: items[i], index: i + 1 };
        for (const b of c.sub.bindings) b.update(sub);
      });
    },
  };
}
