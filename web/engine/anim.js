// Animations for SVG layers, driven by the rules files.
// A step looks like:  { target: name, play: popIn }   or   { target: name, from: { y: -80, opacity: 0 } }
//                 or  { target: name, keyframes: [ { scale: 1.3 }, { scale: 1 } ], duration: 300 }
// Properties: x, y (pixels), scale, rotate (degrees), opacity. Easing names below.

const SVGNS = "http://www.w3.org/2000/svg";

export const EASINGS = {
  linear: "linear", ease: "ease", "ease-in": "ease-in", "ease-out": "ease-out", "ease-in-out": "ease-in-out",
  snappy: "cubic-bezier(.2,.8,.2,1)",            // fast start, soft landing (default)
  "back-out": "cubic-bezier(.34,1.56,.64,1)",    // overshoots a little, then settles
  "back-in": "cubic-bezier(.36,0,.66,-.56)",
  bounce: "cubic-bezier(.68,-.6,.32,1.6)",
};

export const PRESETS = {
  fadeIn: { keyframes: [{ opacity: 0 }, { opacity: 1 }], duration: 400 },
  fadeOut: { keyframes: [{ opacity: 1 }, { opacity: 0 }], duration: 400 },
  slideUp: { keyframes: [{ y: 40, opacity: 0 }, { y: 0, opacity: 1 }], duration: 550 },
  slideDown: { keyframes: [{ y: -40, opacity: 0 }, { y: 0, opacity: 1 }], duration: 550 },
  slideLeft: { keyframes: [{ x: 60, opacity: 0 }, { x: 0, opacity: 1 }], duration: 550 },
  slideRight: { keyframes: [{ x: -60, opacity: 0 }, { x: 0, opacity: 1 }], duration: 550 },
  popIn: { keyframes: [{ scale: 0.6, opacity: 0 }, { scale: 1.06, opacity: 1, offset: 0.7 }, { scale: 1, opacity: 1 }], duration: 450, easing: "ease-out" },
  pulse: { keyframes: [{ scale: 1 }, { scale: 1.25 }, { scale: 1 }], duration: 350 },
  flash: { keyframes: [{ opacity: 1 }, { opacity: 0.2 }, { opacity: 1 }, { opacity: 0.2 }, { opacity: 1 }], duration: 600, easing: "linear" },
  shake: { keyframes: [{ x: 0 }, { x: -12 }, { x: 10 }, { x: -8 }, { x: 6 }, { x: 0 }], duration: 450, easing: "linear" },
  stamp: { keyframes: [{ scale: 1.8, opacity: 0, rotate: -14 }, { scale: 0.95, opacity: 1, rotate: -8, offset: 0.7 }, { scale: 1, opacity: 1, rotate: -8 }], duration: 380, easing: "ease-out" },
  breathe: { keyframes: [{ scale: 1, opacity: 1 }, { scale: 1.04, opacity: 0.85 }, { scale: 1, opacity: 1 }], duration: 2400, easing: "ease-in-out" },
  spin: { keyframes: [{ rotate: 0 }, { rotate: 360 }], duration: 1200, easing: "linear" },
};

const css = (f) => {
  const out = {};
  const t = [];
  if (f.x !== undefined || f.y !== undefined) t.push(`translate(${f.x ?? 0}px, ${f.y ?? 0}px)`);
  if (f.scale !== undefined) t.push(`scale(${f.scale})`);
  if (f.rotate !== undefined) t.push(`rotate(${f.rotate}deg)`);
  if (t.length) out.transform = t.join(" ");
  if (f.opacity !== undefined) out.opacity = f.opacity;
  if (f.offset !== undefined) out.offset = f.offset;
  return out;
};

/**
 * Inkscape positions groups with a `transform` attribute; animating CSS transform on the same element
 * would overwrite it. So every animated layer is wrapped once in a plain <g> and the wrapper moves.
 */
export function animatable(el) {
  if (el.parentNode?.__bsoWrapper) return el.parentNode;
  const g = document.createElementNS(SVGNS, "g");
  g.__bsoWrapper = true;
  g.style.transformBox = "fill-box";
  g.style.transformOrigin = "center";
  el.parentNode.insertBefore(g, el);
  g.append(el);
  return g;
}

/** Play one step on one element. Returns the Animation. */
export function play(el, step, custom = {}) {
  const spec = step.play ? custom[step.play] ?? PRESETS[step.play] : null;
  if (step.play && !spec) { console.warn(`unknown animation "${step.play}"`); return null; }
  let frames = step.keyframes ?? spec?.keyframes;
  if (!frames && (step.from || step.to)) frames = [step.from ?? {}, step.to ?? neutral(step.from)];
  if (!frames) return null;
  const node = animatable(el);
  return node.animate(frames.map(css), {
    duration: Number(step.duration ?? spec?.duration ?? 500),
    delay: Number(step.delay ?? 0),
    easing: EASINGS[step.easing ?? spec?.easing ?? "snappy"] ?? step.easing ?? EASINGS.snappy,
    iterations: step.repeat === "forever" || step.loop ? Infinity : Number(step.repeat ?? 1),
    direction: step.alternate ? "alternate" : "normal",
    fill: step.keep === false ? "none" : "both",
  });
}

// the resting state for `from` animations: same properties at their normal values
function neutral(from = {}) {
  const n = {};
  if ("x" in from) n.x = 0;
  if ("y" in from) n.y = 0;
  if ("scale" in from) n.scale = 1;
  if ("rotate" in from) n.rotate = 0;
  if ("opacity" in from) n.opacity = 1;
  return n;
}
