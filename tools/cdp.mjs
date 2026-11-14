// Minimal Chrome DevTools Protocol driver (Node 24 global WebSocket), for checks that need a real page:
// launch a headless Chromium on its own profile, open pages, evaluate in them, take screenshots.
//   import { launch, sleep } from './cdp.mjs'
//   const b = await launch({ dir: '/tmp/some-profile', size: '1300,900', port: 9377 });
//   const p = await b.page('http://127.0.0.1:3100/'); await sleep(2000);
//   await p.eval('document.title'); await p.shot('/tmp/x.png'); await b.close();
// Run it under a memory cap (systemd-run --user --scope -p MemoryMax=4G …): one headless Chromium at a time.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

export async function launch({ port = 9377, dir, size = '960,540', args = [] }) {
  const proc = spawn('chromium', [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, `--window-size=${size}`,
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--mute-audio', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-extensions', ...args, 'about:blank',
  ], { stdio: 'ignore' });
  let version;
  for (let i = 0; i < 100; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(200); }
  }
  if (!version) throw new Error('chromium did not start');
  const browser = await connect(version.webSocketDebuggerUrl);
  return {
    proc, browser,
    async page(url) {
      const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
      const p = await connect(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
      p.logs = [];
      await p.send('Runtime.enable'); await p.send('Page.enable'); await p.send('Log.enable');
      p.on((m) => {
        if (m.method === 'Runtime.consoleAPICalled') p.logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
        if (m.method === 'Runtime.exceptionThrown') p.logs.push('[exception] ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
        if (m.method === 'Log.entryAdded') p.logs.push(`[log:${m.params.entry.level}] ${m.params.entry.text} ${m.params.entry.url ?? ''}`);
      });
      await p.send('Page.navigate', { url });
      p.eval = async (expression) => {
        const r = await p.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      };
      p.shot = async (file) => {
        const r = await p.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(file, Buffer.from(r.data, 'base64'));
      };
      p.close = () => browser.send('Target.closeTarget', { targetId });
      return p;
    },
    async close() { try { await browser.send('Browser.close'); } catch {} await sleep(500); proc.kill('SIGKILL'); },
  };
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0; const waiting = new Map(); const listeners = [];
    ws.onopen = () => resolve({
      send(method, params = {}) { const n = ++id; ws.send(JSON.stringify({ id: n, method, params })); return new Promise((res, rej) => waiting.set(n, { res, rej })); },
      on(fn) { listeners.push(fn); },
    });
    ws.onerror = (e) => reject(new Error('cdp socket error ' + (e.message ?? '')));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
      else for (const fn of listeners) fn(m);
    };
  });
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
