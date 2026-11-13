// Checks the Match scene's "who is winning" bar (duo layout) at every kind of lead, by measuring it in a browser.
// Needs an overlay running on the SIMULATOR with a map being played and the Match scene on:
//   PORT=8097 KIT_DATA=data/check HOST_CODE=chk ./run.sh        (overlay.yaml: source: sim, players: 2)
//   node tools/bar-check.mjs http://127.0.0.1:8097 chk <overlay key> [out.png]
// It pins the two teams' accuracies (the simulator's "hold" control), waits for the scene to settle, and for each
// case measures the fill, the bright edge, the lead text, the middle mark, the end boxes and the centre column.
// Prints one line per case and every rule broken; exits 1 if any was. out.png: every case's bar, one under another.
// Run it under a memory cap: one headless Chromium (systemd-run --user --scope -p MemoryMax=3G …).
import { launch, sleep } from "../../ta-server/tools/cdp.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const [base, code, key, out] = process.argv.slice(2);
if (!base || !code || !key) { console.error("usage: bar-check.mjs <overlay url> <host code> <overlay key> [out.png]"); process.exit(2); }
const act = (body) => fetch(`${base}/api/action`, { method: "POST", headers: { authorization: `Bearer ${code}` }, body: JSON.stringify(body) });
const hold = (h) => act({ action: "source", control: "hold", ...h });

// [name, team A accuracy (or one per player), team B, misses]
const lead = (d) => [0.9 + Math.max(0, d), 0.9 + Math.max(0, -d)];
const CASES = [
  ...[0, 0.0001, 0.001, 0.004, 0.0099, 0.02, 0.031, 0.0319, 0.032, 0.0321, 0.033, 0.04, 0.05, 0.075, 0.0999, 0.1].flatMap((d) =>
    d === 0 ? [["level", 0.95, 0.95]] : [[`A +${(d * 100).toFixed(2)}`, ...lead(d)], [`B +${(d * 100).toFixed(2)}`, ...lead(-d)]]),
  ["A +25 (past the end)", 0.99, 0.74], ["B +25 (past the end)", 0.74, 0.99],
  ["A 100.00 v 0.00", 1, 0], ["B 100.00 v 0.00", 0, 1], ["both 100.00", 1, 1], ["both 0.00", 0, 0],
  ["lopsided players", [0.924, 0.233], [0.956, 0.451]],
  ["misses 7 / 86", 0.97, 0.96, { a: 7, b: 86 }], ["misses 999 / 999", 0.96, 0.97, { a: 999, b: 999 }], ["misses 1234 / 0", 0.96, 0.97, { a: 1234, b: 0 }],
];

// in the page: boxes of everything the rules are about, in page pixels (the page is 1920 wide, drawn 1:1)
const MEASURE = `(() => {
  const svg = [...document.querySelectorAll('svg[data-scene=match]')].pop();
  const label = (e) => e.getAttribute('inkscape:label') ?? '';
  const all = [...svg.querySelectorAll('*')];
  const named = (n) => all.find((e) => { const t = label(e).split(/\\s+/); return t.includes('#' + n) || t.includes(n); });
  const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
  const seen = (e) => { for (let n = e; n && n !== svg; n = n.parentNode) { const cs = getComputedStyle(n); if (cs.display === 'none' || Number(cs.opacity) < 0.5) return false; } return true; };
  const bar = named('winbar'), edge = named('win-edge'), totals = named('totals');
  const rects = [...bar.querySelectorAll('rect')];
  const fill = named('win-fill'), stub = rects.find((r) => r.getAttribute('x') === '244' && r.getAttribute('width') === '72');
  const track = rects.find((r) => r.getAttribute('x') === '244' && r.getAttribute('width') === '1432');
  const texts = [...edge.querySelectorAll('text')].filter(seen);
  const paths = [...bar.querySelectorAll(':scope > path')];
  const tBox = (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, s: e.textContent.trim() }; };
  return JSON.stringify({
    scale: svg.getBoundingClientRect().width / 1920,
    track: box(track), fillEnd: Math.max(box(fill).r, box(stub).r), marker: box(edge.querySelector('rect')),
    leads: texts.map(tBox),
    scaleA: named('win-scale-a').textContent.trim(), scaleB: named('win-scale-b').textContent.trim(),
    scaleBoxes: [tBox(named('win-scale-a')), tBox(named('win-scale-b'))],
    ticks: all.filter((e) => label(e) === '#win-tick' && Number(getComputedStyle(e).opacity) > 0.05).map(box),
    capA: box(paths[0]), capB: box(paths[1]), accA: tBox(named('acc-a-team')), accB: tBox(named('acc-b-team')),
    middle: box(paths[2]),
    column: { l: 860, r: 1060, t: 607, b: 1052 },   // the centre column's lower box, as drawn
    columnTexts: [...totals.querySelectorAll('text')].filter(seen).map(tBox),
    missA: tBox(named('misses-a-team')), missB: tBox(named('misses-b-team')),
    missBoxes: [...totals.querySelectorAll('rect')].filter((r) => r.getAttribute('width') === '82').map(box),
  });
})()`;

const dir = mkdtempSync(`${tmpdir()}/bar-check-`);
const b = await launch({ dir, size: "1920,1200", port: 9393 });
let failed = 0;
const strips = [];
try {
  const p = await b.page(`${base}/overlay?key=${key}`);
  await sleep(6000);
  for (const [name, a, bAcc, misses] of CASES) {
    await hold({ a, b: bAcc, misses: misses ?? { a: 3, b: 4 } });
    await sleep(1600);                               // the numbers count up, the bar follows, a zoom takes 1.1 s
    const m = JSON.parse(await p.eval(MEASURE));
    const bad = [];
    const over = (x, y, pad = 0) => x.l < y.r + pad && y.l < x.r + pad;         // overlap sideways
    const inside = (x, y, pad = 0) => x.l >= y.l - pad && x.r <= y.r + pad;
    if (Math.abs(m.scale - 1) > 0.001) bad.push(`the page is not drawn 1:1 (${m.scale})`);
    const mid = (m.marker.l + m.marker.r) / 2;
    // the usable part of the track: clear of both slanted ends
    const usable = { l: m.track.l + 14, r: m.track.r - 14 };
    if (Math.abs(mid - m.fillEnd) > 1.5) bad.push(`edge at ${mid.toFixed(1)} but the fill ends at ${m.fillEnd.toFixed(1)}`);
    if (!inside(m.marker, usable)) bad.push(`edge ${m.marker.l.toFixed(0)}–${m.marker.r.toFixed(0)} leaves the bar ${usable.l.toFixed(0)}–${usable.r.toFixed(0)}`);
    const level = typeof a === "number" && typeof bAcc === "number" && a === bAcc;
    // the bar's own scale: both ends say the same, six ticks sit on the bar, and the edge is not left near an end
    // unless the scale is the largest there is
    const scale = Number(m.scaleA.replace("%", "")) / 100;
    if (m.scaleA !== m.scaleB || !(scale > 0)) bad.push(`scale reads "${m.scaleA}" / "${m.scaleB}"`);
    if (m.ticks.length !== 6) bad.push(`${m.ticks.length} ticks on the bar, should be 6`);
    for (const t of m.ticks) if (!inside(t, usable)) bad.push(`a tick at ${t.l.toFixed(0)} is off the bar`);
    for (const t of m.scaleBoxes) if (!inside(t, { l: m.track.l + 10, r: m.track.r - 10 })) bad.push(`scale "${t.s}" ${t.l.toFixed(0)}–${t.r.toFixed(0)} is off the bar`);
    for (const t of m.scaleBoxes) if (over(t, m.marker, 2) || m.leads.some((x) => over(t, x, 2))) bad.push(`scale "${t.s}" is under the edge or the lead`);
    const span = (m.track.r - m.track.l - 144) / 2, pos = (mid - (m.track.l + m.track.r) / 2) / span;
    if (scale < 1 && Math.abs(pos) > 0.86) bad.push(`edge at ${(pos * 100).toFixed(0)} % of the way to the end on the ${m.scaleA} scale: it should have zoomed out`);
    if (m.leads.length !== (level ? 0 : 1)) bad.push(`${m.leads.length} lead texts showing: ${m.leads.map((t) => t.s).join(" | ")}`);
    for (const t of m.leads) {
      if (!inside(t, usable)) bad.push(`lead "${t.s}" ${t.l.toFixed(0)}–${t.r.toFixed(0)} leaves the bar ${usable.l.toFixed(0)}–${usable.r.toFixed(0)}`);
      if (over(t, m.middle, 4)) bad.push(`lead "${t.s}" ${t.l.toFixed(0)}–${t.r.toFixed(0)} is on the middle mark ${m.middle.l.toFixed(0)}–${m.middle.r.toFixed(0)}`);
      if (over(t, m.marker, 2)) bad.push(`lead "${t.s}" touches the edge`);
      if (over(t, m.accA, 6) || over(t, m.accB, 6)) bad.push(`lead "${t.s}" runs into a team's accuracy`);
    }
    if (!inside(m.accA, { l: m.capA.l + 8, r: m.capA.r - 22 })) bad.push(`"${m.accA.s}" ${m.accA.l.toFixed(0)}–${m.accA.r.toFixed(0)} does not fit its box ${m.capA.l.toFixed(0)}–${m.capA.r.toFixed(0)}`);
    if (!inside(m.accB, { l: m.capB.l + 22, r: m.capB.r - 8 })) bad.push(`"${m.accB.s}" ${m.accB.l.toFixed(0)}–${m.accB.r.toFixed(0)} does not fit its box ${m.capB.l.toFixed(0)}–${m.capB.r.toFixed(0)}`);
    for (const t of m.columnTexts) if (!inside(t, m.column, -4)) bad.push(`"${t.s}" ${t.l.toFixed(0)}–${t.r.toFixed(0)} leaves the centre column ${m.column.l.toFixed(0)}–${m.column.r.toFixed(0)}`);
    for (const t of [...m.columnTexts, ...m.leads, m.accA, m.accB]) if (/\d.*…/.test(t.s)) bad.push(`a figure is cut short: "${t.s}"`);
    if (misses && (m.missA.s !== String(misses.a) || m.missB.s !== String(misses.b))) bad.push(`misses read "${m.missA.s}" / "${m.missB.s}", should be ${misses.a} / ${misses.b}`);
    const [boxA, boxB] = m.missBoxes;
    if (!inside(m.missA, boxA, -3)) bad.push(`misses "${m.missA.s}" does not fit its box`);
    if (!inside(m.missB, boxB, -3)) bad.push(`misses "${m.missB.s}" does not fit its box`);
    failed += bad.length;
    console.log(`${bad.length ? "FAIL" : "ok  "} ${name.padEnd(24)} A ${m.accA.s.padStart(7)}  B ${m.accB.s.padStart(7)}  scale ${m.scaleA.padStart(4)}  edge ${mid.toFixed(0).padStart(4)}  lead ${(m.leads[0] ? `${m.leads[0].s} @ ${m.leads[0].l.toFixed(0)}–${m.leads[0].r.toFixed(0)}` : "none")}`);
    for (const line of bad) console.log(`       ${line}`);
    if (out) {
      const shot = await p.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 545, width: 1920, height: 64, scale: 1 } });
      strips.push([name, shot.data]);
    }
  }
  // the scale itself: zooming out at once when a lead nears an end, back in only after it has been calm a while.
  // While it zooms, the edge and the end of the fill must travel together.
  const read = async () => JSON.parse(await p.eval(MEASURE));
  let apart = 0;
  let worst = "";
  const watch = async (ms, what = "") => { for (let t = 0; t < ms; t += 45) { const m = await read(); const gap = Math.abs((m.marker.l + m.marker.r) / 2 - m.fillEnd); if (gap > apart) { apart = gap; worst = `${what} at ${t} ms: edge ${((m.marker.l + m.marker.r) / 2).toFixed(1)}, fill ends ${m.fillEnd.toFixed(1)}, scale ${m.scaleA}`; } await sleep(45); } };
  const expect = async (what, h, wait, want) => {
    await hold({ ...h, misses: { a: 3, b: 4 } });
    await watch(wait, what);
    const m = await read(), ok = m.scaleA === want && m.ticks.length === 6;
    console.log(`${ok ? "ok  " : "FAIL"} zoom: ${what.padEnd(46)} scale ${m.scaleA} (want ${want}), ${m.ticks.length} ticks`);
    if (!ok) failed++;
  };
  await expect("level, left alone for 5 s: all the way in", { a: 0.9, b: 0.9 }, 5200, "1%");
  await expect("A +0.60: fits, stays", { a: 0.906, b: 0.9 }, 1700, "1%");
  await expect("A +0.90: near the end, out one", { a: 0.909, b: 0.9 }, 1700, "2%");
  await expect("A +3.00: out to 8", { a: 0.93, b: 0.9 }, 1700, "8%");
  await expect("B +30: out to 64", { a: 0.6, b: 0.9 }, 1700, "64%");
  await expect("A 100 v 0: the largest", { a: 1, b: 0 }, 1700, "100%");
  await expect("A +0.20 a second later: not yet", { a: 0.902, b: 0.9 }, 1000, "100%");
  await expect("still A +0.20 after 4 s more: back in", { a: 0.902, b: 0.9 }, 5000, "1%");
  await expect("B +1.50 then at once A +1.50 (a swing): stays", { a: 0.915, b: 0.9 }, 1700, "4%");
  await hold({ a: 0.9, b: 0.915 }); await watch(900);
  // The zoom must LOOK like a zoom: seen in motion, sample by sample. From A +0.30 on the 1 % scale to A +3.00 (the
  // 8 % scale): the edge travels through many places, the ticks already on the bar close in on the middle, and the
  // new scale's ticks start beyond the ends and travel in.
  await hold({ a: 0.903, b: 0.9 }); await sleep(5600);
  const TICKS = `(() => { const svg = [...document.querySelectorAll('svg[data-scene=match]')].pop(); const all = [...svg.querySelectorAll('*')]; const lab = (e) => e.getAttribute('inkscape:label') ?? ''; const edge = all.find((e) => lab(e).includes('#win-edge')).querySelector('rect').getBoundingClientRect(); return JSON.stringify({ edge: edge.left + edge.width / 2, scale: all.find((e) => lab(e).includes('#win-scale-a')).textContent.trim(), ticks: all.filter((e) => lab(e) === '#win-tick').map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Number(getComputedStyle(e).opacity)]; }) }); })()`;
  const before = JSON.parse(await p.eval(TICKS));
  await hold({ a: 0.93, b: 0.9 });
  const samples = [];
  for (let i = 0; i < 26; i++) { samples.push(JSON.parse(await p.eval(TICKS))); await sleep(45); }
  await sleep(600);
  const after = JSON.parse(await p.eval(TICKS));
  const edges = [...new Set(samples.map((x) => Math.round(x.edge)))];
  const right = (x) => x.ticks.map((t) => t[0]).filter((v) => v > 960).sort((a, b) => a - b);
  const inner = samples.map((x) => right(x)[0]).filter((v) => v != null);                  // the tick nearest the middle, on the right
  // it closes in until it has faded out; then the nearest one is a tick of the new scale, further out again
  const handover = inner.findIndex((v, i) => i > 0 && v > inner[i - 1] + 40);
  const glide = handover < 0 ? inner : inner.slice(0, handover);
  const closing = glide.every((v, i) => i === 0 || v <= glide[i - 1] + 1) && new Set(glide).size >= 8 && glide[0] - glide.at(-1) > 100;
  const outside = samples.some((x) => x.ticks.some((t) => t[0] > 1676 || t[0] < 244));    // a tick still beyond an end, on its way in
  const moving = [];
  if (edges.length < 6) moving.push(`the edge was seen in only ${edges.length} places (${edges.join(", ")}): a jump, not a slide`);
  if (!closing) moving.push(`the ticks do not close in on the middle step by step (nearest right tick: ${inner.join(", ")})`);
  if (!outside) moving.push("no tick was seen beyond an end on its way in");
  if (before.scale !== "1%" || after.scale !== "8%" || after.ticks.length !== 6) moving.push(`before ${before.scale}, after ${after.scale} with ${after.ticks.length} ticks`);
  failed += moving.length;
  console.log(`${moving.length ? "FAIL" : "ok  "} zoom seen in motion: edge at ${edges.length} places (${edges[0]} … ${edges.at(-1)}), nearest right tick glides ${glide[0]} → ${glide.at(-1)} in ${new Set(glide).size} steps, ticks before ${right(before).join("/")} after ${right(after).join("/")}`);
  for (const line of moving) console.log(`       ${line}`);
  console.log(`${apart > 4 ? "FAIL" : "ok  "} while moving and zooming: the edge and the fill are at most ${apart.toFixed(1)} px apart${apart > 1 ? ` (${worst})` : ""}`);
  if (apart > 4) failed++;
  await hold({});
  // around a song: its result (the "takes map" plate), then the next map loading with no scores yet
  const state = async () => (await (await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${code}` } })).json()).data.match.phase;
  const still = async (what) => {
    await sleep(1500);
    const m = await read(), bad = [];
    const inside = (x, y, pad = 0) => x.l >= y.l - pad && x.r <= y.r + pad;
    for (const t of m.columnTexts) if (!inside(t, m.column, -4)) bad.push(`"${t.s}" ${t.l.toFixed(0)}–${t.r.toFixed(0)} leaves the centre column`);
    if (!inside(m.accA, { l: m.capA.l + 8, r: m.capA.r - 22 }) || !inside(m.accB, { l: m.capB.l + 22, r: m.capB.r - 8 })) bad.push(`an accuracy ("${m.accA.s}" / "${m.accB.s}") does not fit its box`);
    if (m.ticks.length !== 6) bad.push(`${m.ticks.length} ticks`);
    if (!inside(m.marker, { l: m.track.l + 14, r: m.track.r - 14 })) bad.push("the edge is off the bar");
    for (const t of m.leads) if (!inside(t, { l: m.track.l + 14, r: m.track.r - 14 })) bad.push(`lead "${t.s}" is off the bar`);
    failed += bad.length;
    console.log(`${bad.length ? "FAIL" : "ok  "} ${what.padEnd(24)} A ${m.accA.s.padStart(7)}  B ${m.accB.s.padStart(7)}  scale ${m.scaleA.padStart(4)}  centre column: ${m.columnTexts.map((t) => t.s).join(" | ")}`);
    for (const line of bad) console.log(`       ${line}`);
    if (out) strips.push([what, (await p.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 545, width: 1920, height: 64, scale: 1 } })).data]);
  };
  await act({ action: "source", control: "speed", value: 30 });
  for (let i = 0; i < 60 && (await state()) === "playing"; i++) await sleep(500);
  await still(`song over (${await state()})`);
  await act({ action: "source", control: "next" });
  await still(`next map (${await state()})`);
  if (out) {
    // one page with every strip under the other, pictured once
    const q = await b.page("about:blank");
    await q.eval(`document.body.style.cssText = 'margin:0;background:#111;font:14px sans-serif;color:#ddd'; document.body.innerHTML = ${JSON.stringify(strips.map(([n, d]) => `<div style="height:20px;padding:2px 8px">${n}</div><img src="data:image/png;base64,${d}" style="display:block">`).join(""))}`);
    await sleep(800);
    const shot = await q.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1920, height: strips.length * 88, scale: 0.6 } });
    writeFileSync(out, Buffer.from(shot.data, "base64"));
  }
} finally { await b.close(); rmSync(dir, { recursive: true, force: true }); }
console.log(failed ? `${failed} problems` : "all clear");
process.exit(failed ? 1 : 0);
