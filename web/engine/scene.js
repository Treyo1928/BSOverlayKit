// One scene = one SVG file + its rules. Split into two layers so video can sit between them:
//   back  = top-level Inkscape layers named "back" (backgrounds), drawn UNDER the video feeds
//   front = everything else, drawn OVER the video feeds
import { collect, evalCond, layerName, parseTokens, realignGlass, resolve } from "/engine/bind.js";
import { play } from "/engine/anim.js";

const isBack = (el) => /^back\b/i.test(layerName(el));

/**
 * All scenes live in one page, so two designs both defining id="coverClip" would collide (the second
 * scene would use the first one's clip). Give every id in a scene a scene-specific prefix.
 */
function scopeIds(text, prefix) {
  const ids = new Set([...text.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  if (!ids.size) return text;
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alt = [...ids].map(esc).join("|");
  return text
    .replace(new RegExp(`\\bid="(${alt})"`, "g"), (_, id) => `id="${prefix}${id}"`)
    .replace(new RegExp(`url\\(#(${alt})\\)`, "g"), (_, id) => `url(#${prefix}${id})`)
    .replace(new RegExp(`href="#(${alt})"`, "g"), (_, id) => `href="#${prefix}${id}"`);
}

export class Scene {
  constructor(id, def, env) {
    this.id = id;
    this.def = def;                 // { svg, vars, rules, label }
    this.rules = def.rules ?? {};
    this.env = { ...env, fx: this.rules.fx, tween: this.rules.tween, repeat: this.rules.repeat, play: (el, s) => play(el, s, this.rules.animations) };
    this.prev = null;
    this.active = false;
  }

  async load(backHost, frontHost) {
    const text = await fetch(`${this.def.svg}?v=${Date.now()}`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${this.def.svg}: ${r.status}`))));
    const doc = new DOMParser().parseFromString(scopeIds(text, `s-${this.id}-`), "image/svg+xml");
    const err = doc.querySelector("parsererror");
    if (err) throw new Error(`${this.def.svg} is not valid SVG`);
    // Inkscape links images by file path ("logo.png", "/home/…/design/logo.png", "file:///…").
    // Point those at the server's /design/ folder so they load in OBS.
    for (const img of doc.querySelectorAll("image")) {
      for (const attr of ["href", "xlink:href"]) {
        const v = img.getAttribute(attr);
        if (!v || /^(https?:|data:|\/design\/|\/covers\/)/.test(v)) continue;
        const path = decodeURIComponent(v.replace(/^file:\/\//, ""));
        // an absolute path inside the design folder, else relative to this SVG (design/msu/x.svg -> design/msu/)
        const url = path.includes("/design/") ? `/design/${path.split("/design/").pop()}` : new URL(path, location.origin + this.def.svg).pathname;
        img.setAttribute(attr, url);
      }
    }
    const make = (keepBack) => {
      const svg = document.importNode(doc.documentElement, true);
      for (const layer of [...svg.children]) {
        if (["defs", "style", "metadata"].includes(layer.tagName) || layer.tagName.endsWith("namedview")) continue;
        if (isBack(layer) !== keepBack) layer.remove();
      }
      svg.setAttribute("width", "1920");
      svg.setAttribute("height", "1080");
      svg.classList.add("scene-svg");
      svg.dataset.scene = this.id;
      return svg;
    };
    this.back = make(true);
    this.front = make(false);
    backHost.append(this.back);
    frontHost.append(this.front);
    // glass shapes show this scene's background picture, blurred (the first picture in the back layer)
    const bg = this.back.querySelector("image");
    const bgSrc = bg?.getAttribute("href") ?? bg?.getAttribute("xlink:href");
    this.env.glass = bgSrc ? { src: bgSrc, options: this.rules.glass ?? {} } : null;
    const ctxEnv = this.env;
    this.b = collect(this.back, ctxEnv);
    this.f = collect(this.front, ctxEnv);
    // feed:big in a focus design means feed:a when this scene's vars say big = a
    const vars = this.def.vars ?? {};
    this.feeds = this.f.feeds.map((f) => {
      const [kind, name] = f.id.split(":");
      return { ...f, id: `${kind}:${vars[name] ?? name}` };
    });
    this.setVisible(false, true);
  }

  destroy() { this.fxAll().forEach((f) => f.stop()); this.back?.remove(); this.front?.remove(); }

  fxAll() { return [...(this.b?.fx ?? []), ...(this.f?.fx ?? [])]; }

  setVisible(on, instant = false) {
    const was = this.active;
    this.active = on;
    // particle effects only draw while the scene is on stream (and through its fade-out)
    for (const f of this.fxAll()) on ? f.start() : f.stop(was && !instant ? (this.env.fadeMs ?? 400) + 150 : 0);
    for (const svg of [this.back, this.front]) {
      svg.style.transition = instant ? "none" : "";
      svg.classList.toggle("active", on);
    }
  }

  /** Elements a rule's target refers to. `item` (0-based) picks one repeat clone, e.g. the card just banned. */
  targets(name, item) {
    const all = [...(this.f.names.get(name) ?? []), ...(this.b.names.get(name) ?? [])];
    for (const rep of [...this.f.repeats, ...this.b.repeats]) {
      rep.clones.forEach((c, i) => {
        const els = c.sub.names.get(name);
        if (els && (item === undefined || item === i)) all.push(...els);
      });
    }
    return all;
  }

  run(steps, item) {
    for (const step of [].concat(steps ?? [])) {
      if (!step?.target) continue;
      for (const el of this.targets(step.target, item)) play(el, step, this.rules.animations);
    }
  }

  ctx(base) { return { ...base, $vars: this.def.vars ?? {} }; }

  update(base) {
    const ctx = this.ctx(base);
    for (const b of [...this.b.bindings, ...this.f.bindings]) b.update(ctx);
    this.adjust(ctx);
    if (this.active && this.prev) this.dataTriggers(this.prev, ctx);
    this.prev = ctx;
  }

  /**
   * `adjust:` rules: move or hide a layer while a condition holds, e.g. the prompt moves up when the pool needs two
   * rows.  - { if: "pool.length>7", target: prompt, y: -64 }   (if: may be a list, all must hold; x, y, hide: true)
   * Several rules on one layer add up. The layer gets a group of its own for this, outside the one animations move.
   */
  adjust(ctx) {
    const rules = this.rules.adjust;
    if (!rules?.length) return;
    const want = new Map();
    for (const r of rules) {
      if (!r?.target) continue;
      const on = [].concat(r.if ?? []).every((c) => evalCond(ctx, String(c)));
      for (const el of this.targets(r.target)) {
        const w = want.get(el) ?? { x: 0, y: 0, hide: false };
        if (on) { w.x += Number(r.x ?? 0); w.y += Number(r.y ?? 0); w.hide ||= !!r.hide; }
        want.set(el, w);
      }
    }
    for (const [el, w] of want) {
      let g = el.__bsoAdjust;
      if (!g) {
        if (!w.x && !w.y && !w.hide) continue;
        const inner = el.parentNode?.__bsoWrapper ? el.parentNode : el;   // keep an animation's group inside
        g = el.__bsoAdjust = document.createElementNS("http://www.w3.org/2000/svg", "g");
        inner.parentNode.insertBefore(g, inner);
        g.append(inner);
      }
      const t = `translate(${w.x} ${w.y})`;
      if (g.getAttribute("transform") !== t) { g.setAttribute("transform", t); realignGlass(g); }
      g.style.display = w.hide ? "none" : "";
    }
  }

  /** `on:` keys like increase:a.misses, decrease:x, change:map.name, becomes:a.leading=true */
  dataTriggers(prev, ctx) {
    for (const [key, steps] of Object.entries(this.rules.on ?? {})) {
      const m = /^(increase|decrease|change|becomes):(.+)$/.exec(key);
      if (!m) continue;
      const [kind, spec] = [m[1], m[2]];
      if (kind === "becomes") { if (!evalCond(prev, spec) && evalCond(ctx, spec)) this.run(steps); continue; }
      const a = resolve(prev, spec), b = resolve(ctx, spec);
      if (kind === "change" ? JSON.stringify(a) !== JSON.stringify(b) : kind === "increase" ? b > a : b < a) this.run(steps);
    }
  }

  /** A match event (mapPick, mapStart…) while this scene is on stream. */
  event(e) {
    const steps = this.rules.on?.[e.name];
    if (steps) this.run(steps, e.item);
  }

  /** Entrance: rules `enter:` if given, else layers tagged enter:N slide up one after another. */
  enter() {
    for (const svg of [this.back, this.front]) svg.getAnimations({ subtree: true }).forEach((a) => a.cancel());
    if (this.rules.enter) return this.run(this.rules.enter);
    for (const { el, order } of [...(this.f.enter ?? []), ...(this.b.enter ?? [])]) {
      play(el, { play: "slideUp", delay: order * 90 }, this.rules.animations);
    }
  }

  startLoops() {
    for (const step of this.rules.loop ?? []) this.run({ ...step, repeat: "forever", delay: step.delay ?? 0 });
  }
}
