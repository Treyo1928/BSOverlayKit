// Caster / producer panel.
const $ = (s) => document.querySelector(s);
let S = null, ws, reqId = 0;
const send = (action, args = {}) => ws?.readyState === 1 && ws.send(JSON.stringify({ ...args, action, reqId: ++reqId }));
const editing = () => /INPUT|TEXTAREA/.test(document.activeElement?.tagName) && document.activeElement.type !== "checkbox";

function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/panel`);
  ws.onopen = () => { $("#conn").textContent = "connected"; $("#conn").className = "pill ok"; };
  ws.onclose = () => {
    $("#conn").textContent = "offline"; $("#conn").className = "pill bad";
    fetch("/").then((r) => r.text()).then((t) => t.includes("Sign in") && location.reload());
    setTimeout(connect, 1000);
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "state" && m.scenes) { S = m; render(); }
    if (m.type === "log") $("#log").insertAdjacentHTML("afterbegin", `<div>${new Date().toLocaleTimeString()}  ${m.text}</div>`);
    if (m.type === "ack" && !m.ok) alert(m.error);
    if (m.type === "design") $("#log").insertAdjacentHTML("afterbegin", `<div>${new Date().toLocaleTimeString()}  design reloaded</div>`);
  };
}
connect();

let previewSet = false;
function render() {
  const sh = S.show;
  $("#scenes").innerHTML = Object.entries(S.scenes).map(([id, label]) => `<button data-scene="${id}" class="${sh.scene === id ? "on" : ""}">${label[0].toUpperCase() + label.slice(1)}</button>`).join("");
  $("#auto").checked = sh.auto;
  $("#src").textContent = S.source.status;
  $("#simCard").style.display = S.source.name === "sim" ? "" : "none";
  $("#bscsCard").style.display = S.source.name === "bscompstats" ? "" : "none";
  const bp = S.source.panel;
  if (bp && document.activeElement?.id !== "bscsMatch") {
    $("#bscsMatch").innerHTML = `<option value="">Newest unfinished match (automatic)</option>` + bp.matches.map((m) => `<option value="${esc(m.id)}" ${m.id === bp.following && !bp.auto ? "selected" : ""}>${esc(m.label)} (${esc(m.state.toLowerCase())})</option>`).join("");
  }
  $("#simAuto").classList.toggle("on", /auto/.test(S.source.status));
  $("#simStatus").textContent = S.live ? `${S.live.match.phase} · ${S.live.a.name} ${S.live.a.points}–${S.live.b.points} ${S.live.b.name}${S.live.map ? ` · ${S.live.map.name} ${S.live.map.time}` : ""}` : "";
  if (!previewSet) {
    previewSet = true;
    $("#pv").src = `${S.overlayUrl}&debug&bg&mute`;   // checkered = transparent on stream; OBS plays the sound
    $("#open").href = `${S.overlayUrl}&bg&debug`;
    $("#obsUrl").value = location.origin + S.overlayUrl;
    const fit = () => {
      const scale = $(".preview").clientWidth / 1920;
      $("#pv").style.transform = `scale(${scale})`;
      // the preview draws its replays at the size they're shown, not full 1080p (the viewer adds the screen's density)
      $("#pv").contentWindow?.postMessage({ type: "msu:previewScale", scale }, location.origin);
    };
    $("#pv").addEventListener("load", fit);
    new ResizeObserver(fit).observe($(".preview"));
    fit();
  }
  renderPlaylist();
  $("#errors").innerHTML = S.errors.length ? `<div class="errors">${S.errors.map(esc).join("\n")}</div>` : "";
  if (editing()) return;
  $("#speed").value = /(\d+)× speed/.exec(S.source.status)?.[1] ?? 4;
  const fromDiscord = sh.castersFrom === "discord";
  $("#castersFrom").checked = fromDiscord;
  $("#castersHint").textContent = fromDiscord ? "Following the Discord voice channel (the caster bot). Editing a caster below switches this off." : "Typed in here. Tick the box to follow the casting voice channel instead.";
  $("#casters").innerHTML = sh.casters.map((c, i) => `<div class="row">
      <div><label>Caster ${i + 1}</label><input data-c="${i}" data-k="name" value="${esc(c.name)}"></div>
      <div><label>Handle</label><input data-c="${i}" data-k="handle" value="${esc(c.handle)}"></div></div>
    <label>Discord avatar (in Discord: right-click their picture → Copy Image Link)</label><input data-c="${i}" data-k="avatar" value="${esc(c.avatar)}" placeholder="https://cdn.discordapp.com/avatars/…">`).join("<hr style='border-color:#2a2a40'>");
  $("#header").value = sh.header ?? "";
  $("#brbTitle").value = sh.brb.title;
  $("#brbMsg").value = sh.brb.message;
  $("#ticker").value = sh.ticker.join("\n");
  $("#feedA").value = sh.feeds.a ?? "";
  $("#feedB").value = sh.feeds.b ?? "";
  $("#delay").value = sh.streamDelayMs;
  $("#lockPitch").checked = !!sh.viewer?.lockPitch;
  $("#pitchLimit").value = sh.viewer?.pitchLimit ?? 12;
  $("#renderScale").value = String(sh.viewer?.renderScale ?? 1);
  $("#maxFps").value = String(sh.viewer?.maxFps ?? 60);
  $("#previewMode").value = sh.viewer?.preview ?? "program";
  $("#output").value = String(sh.viewer?.output ?? 1080);
  $("#quality").value = sh.viewer?.quality ?? "medium";
  $("#distortion").checked = sh.viewer?.distortion ?? true;
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

$("#brbBtns").innerHTML = [1, 3, 5, 10, 15].map((n) => `<button data-brb="${n}">Back in ${n} min</button>`).join("");
document.addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.scene) send("scene", { scene: t.dataset.scene });
  if (t.dataset.sim) send("source", { control: t.dataset.sim });
  if (t.dataset.brb) send("brb", { minutes: Number(t.dataset.brb) });
  if (t.id === "copy") navigator.clipboard.writeText($("#obsUrl").value);
  if (t.id === "plAddBtn") { send("playlist", { op: "add", refs: $("#plAdd").value.split("\n") }); $("#plAdd").value = ""; }
  if (t.id === "plClear" && confirm("Remove every replay from the playlist?")) send("playlist", { op: "clear" });
  const op = t.dataset.pl;
  if (op) {
    const items = S.playlist.items, i = items.findIndex((x) => x.id === t.dataset.id);
    if (op === "up" || op === "down") send("playlist", { op: "move", id: t.dataset.id, to: i + (op === "up" ? -1 : 1) });
    else send("playlist", { op, id: t.dataset.id });
  }
});
document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.id === "auto") send("auto", { on: el.checked });
  if (el.id === "speed") send("source", { control: "speed", value: Number(el.value) });
  if (el.dataset.c !== undefined) {
    const casters = structuredClone(S.show.casters);
    casters[Number(el.dataset.c)][el.dataset.k] = el.value;
    send("casters", { casters });
  }
  if (el.id === "brbTitle" || el.id === "brbMsg") send("brb", { brb: { title: $("#brbTitle").value, message: $("#brbMsg").value } });
  if (el.id === "bscsMatch") send("source", { control: "follow", matchId: el.value });
  if (el.id === "castersFrom") send("castersFrom", { from: el.checked ? "discord" : "panel" });
  if (el.id === "header") send("header", { header: el.value.trim() });
  if (el.id === "plMode") send("playlist", { op: "mode", mode: el.value });
  if (el.id === "plSort" && el.value) { send("playlist", { op: "sort", by: el.value }); el.value = ""; }
  if (el.id === "ticker") send("ticker", { ticker: el.value.split("\n") });
  if (el.id === "feedA" || el.id === "feedB") send("feeds", { feeds: { ...S.show.feeds, a: $("#feedA").value.trim(), b: $("#feedB").value.trim() } });
  if (el.id === "delay") send("streamDelay", { ms: Number(el.value) });
  if (el.id === "lockPitch" || el.id === "pitchLimit") send("viewer", { lockPitch: $("#lockPitch").checked, pitchLimit: Number($("#pitchLimit").value) });
  if (el.id === "previewMode") send("viewer", { preview: el.value });
  if (el.id === "quality") send("viewer", { quality: el.value });
  if (el.id === "distortion") send("viewer", { distortion: el.checked });
  if (el.id === "output") send("viewer", { output: Number(el.value) });
  if (el.id === "renderScale" || el.id === "maxFps") send("viewer", { renderScale: Number($("#renderScale").value), maxFps: Number($("#maxFps").value) });
});
document.addEventListener("focusout", () => setTimeout(() => S && !editing() && render(), 0));

// ---------------------------------------------------------------- replay playlist
let clockOffset = 0;
function renderPlaylist() {
  const pl = S.playlist;
  if (!pl) return;
  clockOffset = S.now - Date.now();
  if (document.activeElement?.id !== "plMode") $("#plMode").value = pl.mode;
  const cur = pl.items.find((x) => x.id === pl.current?.id);
  const name = (it) => (it.info?.song ? esc(it.info.song) : esc(it.ref));
  const sub = (it) => it.error ? `<span class="err">${esc(it.error)}</span>` : !it.info ? "looking it up…" :
    [it.info.player && `played by ${esc(it.info.player)}`, it.info.difficulty, it.info.stars ? `★ ${it.info.stars.toFixed(2)}` : "",
      it.info.acc ? `${(it.info.acc * 100).toFixed(2)}%` : "", it.info.duration ? fmt(it.info.duration) : ""].filter(Boolean).join(" · ");
  $("#plNow").innerHTML = cur
    ? `<img src="${esc(cur.info?.cover ?? "")}" alt=""><div class="t"><div class="muted" id="plWhat"></div><b>${name(cur)}</b><div class="muted">${sub(cur)}</div>
        <div class="pl-bar"><i id="plBar"></i></div></div>`
    : `<div class="muted">${pl.items.length ? "Starts when a scene with the big box (Starting Soon, Intermission, Be Right Back) is on." : "The playlist is empty. Add replay links below."}</div>`;
  $("#plList").innerHTML = pl.items.length ? pl.items.map((it, i) => `<div class="pl-item ${it.id === pl.current?.id ? "on" : ""}">
      <span class="n">${i + 1}</span><img src="${esc(it.info?.cover ?? "")}" alt="">
      <div class="t">${name(it)}<br><small>${sub(it)}</small></div>
      <button data-pl="play" data-id="${it.id}" title="Play this one now">▶</button><button data-pl="up" data-id="${it.id}" title="Move up" ${i ? "" : "disabled"}>↑</button>
      <button data-pl="down" data-id="${it.id}" title="Move down" ${i < pl.items.length - 1 ? "" : "disabled"}>↓</button><button data-pl="remove" data-id="${it.id}" title="Remove">✕</button></div>`).join("")
    : `<div class="pl-empty">No replays yet</div>`;
  tickPlaylist();
}
// the song clock, between server updates
function tickPlaylist() {
  const c = S?.playlist?.current;
  if (!c) { $("#plState").textContent = ""; return; }
  const now = Date.now() + clockOffset;
  const pos = c.pausedAt ?? (c.startAt == null ? null : (now - c.startAt) / 1000);
  const what = pos === null || pos < 0 ? "Up next (the card is on, the replay is loading)" : c.pausedAt !== null ? "Paused: no replay scene on stream" : "Now playing";
  $("#plState").textContent = what;
  if ($("#plWhat")) $("#plWhat").textContent = pos !== null && pos >= 0 ? `${fmt(pos)} / ${c.duration ? fmt(c.duration) : "?"}` : "";
  if ($("#plBar")) $("#plBar").style.width = `${c.duration && pos > 0 ? Math.min(100, (pos / c.duration) * 100) : 0}%`;
}
setInterval(tickPlaylist, 500);
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
