import { launch, sleep } from '/home/treyb/DevStuff/MSU-BeatSaber/ta-server/tools/cdp.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
// Two open panels stay in step: every control is changed in one and read back in the other, both ways.
//   B=http://127.0.0.1:8095 CODE=<panel code> node tools/panel-sync-check.mjs      (it changes the show: not on a live stream)
const S = (process.env.TMPDIR ?? '/tmp') + '/', B = process.env.B ?? 'http://127.0.0.1:8097', CODE = process.env.CODE ?? 'chk';
const dir = mkdtempSync(S + 'prof-');
const b = await launch({ dir, size: '1400,1000', port: 9391 });
const set = (sel, v) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'MISSING ' + ${JSON.stringify(sel)}; if (e.type === 'checkbox') { if (e.checked !== ${JSON.stringify(v)}) e.click(); return 'ok'; } e.focus(); e.value = ${JSON.stringify(String(v))}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); e.blur(); return 'ok'; })()`;
const get = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !e ? 'MISSING' : e.type === 'checkbox' ? e.checked : e.value; })()`;
let bad = 0;
const check = (name, got, want) => { const ok = String(got) === String(want); if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: other panel shows ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`}`); };
try {
  const one = await b.page(`${B}/login/${CODE}`); await sleep(3000);
  const two = await b.page(`${B}/`);
  await sleep(9000);
  console.log('both are the panel:', await one.eval('document.title'), '/', await two.eval('document.title'), '| connected:', await one.eval(`document.querySelector('#conn').textContent`), '/', await two.eval(`document.querySelector('#conn').textContent`));
  // every plain control, one way then the other
  const plain = [['#auto', true], ['#auto', false], ['#header', 'SYNC TEST ONE'], ['#signOff', true], ['#signOff', false], ['#brbTitle', 'Back soon'], ['#brbMsg', 'Short break'], ['#ticker', 'line one\nline two'],
    ['#mixMusic', 37], ['#mixHits', 62], ['#delay', 1500], ['#fov', 48], ['#camZ', -0.3], ['#lockPitch', false], ['#lockPitch', true], ['#pitchUp', 20], ['#pitchDown', 8],
    ['#renderScale', '0.75'], ['#maxFps', '30'], ['#quality', 'low'], ['#distortion', false], ['#plMode', null], ['#plFollow', false]];
  let dir2 = 0;
  for (let [sel, v] of plain) {
    const [from, to] = dir2++ % 2 ? [two, one] : [one, two];
    if (v === null) { v = await from.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return [...e.options].find((o) => o.value && o.value !== e.value)?.value ?? e.value; })()`); }
    const r = await from.eval(set(sel, v)); await sleep(700);
    if (r !== 'ok') { bad++; console.log('FAIL', r); continue; }
    check(`${sel} = ${JSON.stringify(v)} (${from === one ? '1→2' : '2→1'})`, await to.eval(get(sel)), v);
  }
  for (const sel of ['#mixScenes input', '#casters input']) console.log('info', sel, 'count', await one.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`));
  // scene buttons
  for (const [from, to, scene] of [[one, two, 'casters'], [two, one, 'bracket'], [one, two, 'intermission']]) {
    await from.eval(`[...document.querySelectorAll('#scenes button')].find((x) => x.dataset.scene === '${scene}').click()`); await sleep(700);
    check(`scene ${scene} (${from === one ? '1→2' : '2→1'})`, await to.eval(`document.querySelector('#scenes button.air')?.dataset.scene`), scene);
  }
  // per-scene music slider and casters
  await one.eval(`(() => { const e = document.querySelector('#mixScenes input'); e.value = 44; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(700);
  check('first per-scene music slider (1→2)', await two.eval(`document.querySelector('#mixScenes input').value`), 44);
  await two.eval(`(() => { const e = document.querySelector('#casters input'); if (!e) return; e.focus(); e.value = 'Casey'; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); e.blur(); })()`); await sleep(700);
  check('first caster field (2→1)', await one.eval(`document.querySelector('#casters input')?.value`), 'Casey');
  // up next
  await one.eval(set('#upA', 'Alpha')); await one.eval(set('#upB', 'Beta')); await one.eval(`document.querySelector('#upSet').click()`); await sleep(800);
  check('up next A (1→2)', await two.eval(get('#upA')), 'Alpha'); check('up next state (1→2)', (await two.eval(`document.querySelector('#upState').textContent`)).length > 0, true);
  await two.eval(`document.querySelector('#upClear').click()`); await sleep(800);
  check('up next cleared (2→1)', await one.eval(get('#upA')), '');
  // playlist
  const n0 = await two.eval(`document.querySelectorAll('#plList .pl-item').length`);
  await one.eval(`(() => { const e = document.querySelector('#plAdd'); e.value = '34901318'; e.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#plAddBtn').click(); })()`); await sleep(5000);
  check('playlist grows by one (1→2)', await two.eval(`document.querySelectorAll('#plList .pl-item').length`), n0 + 1);
  // typing is not wiped by someone else's change, and the other change still lands after
  await two.eval(`(() => { const i = document.querySelector('#brbTitle'); i.focus(); i.value = 'half typed'; })()`);
  await one.eval(set('#header', 'SET WHILE TWO TYPES')); await one.eval(set('#delay', 2500)); await sleep(800);
  check('two keeps what it is typing', await two.eval(get('#brbTitle')), 'half typed');
  await two.eval(`(() => { const i = document.querySelector('#brbTitle'); i.dispatchEvent(new Event('change', { bubbles: true })); i.blur(); })()`); await sleep(900);
  check('after two leaves the field it shows the header one set', await two.eval(get('#header')), 'SET WHILE TWO TYPES');
  check('…and the delay one set', await two.eval(get('#delay')), 2500);
  check('one shows what two typed', await one.eval(get('#brbTitle')), 'half typed');
  // staging: on in one, staged scene, go live from the other
  await one.eval(set('#staging', true)); await sleep(800);
  check('staging on (1→2)', await two.eval(get('#staging')), true);
  await one.eval(`[...document.querySelectorAll('#scenes button')].find((x) => x.dataset.scene === 'starting').click()`); await sleep(900);
  check('still on air: intermission (seen by 2)', await two.eval(`document.querySelector('#airName').textContent.toLowerCase().includes('intermission')`), true);
  check('next is Starting Soon (seen by 2)', await two.eval(`document.querySelector('#nextName').textContent.toLowerCase().includes('starting')`), true);
  check('Go live enabled on 2', await two.eval(`!document.querySelector('#take').disabled`), true);
  await two.eval(`document.querySelector('#take').click()`); await sleep(900);
  check('on air after 2 went live (seen by 1)', await one.eval(`document.querySelector('#airName').textContent.toLowerCase().includes('starting')`), true);
  await two.eval(`window.confirm = () => true`); await two.eval(set('#staging', false)); await sleep(800);
  check('staging off (2→1)', await one.eval(get('#staging')), false);
  // a panel that was closed and opened again shows the present state
  await two.send('Page.reload'); await sleep(7000);
  check('reopened panel: header', await two.eval(get('#header')), 'SET WHILE TWO TYPES'); check('reopened panel: fov', await two.eval(get('#fov')), 48); check('reopened panel: quality', await two.eval(get('#quality')), 'low');
  console.log(bad ? `\n${bad} FAILED` : '\nall in sync');
} finally { await b.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {} }
process.exit(0);
