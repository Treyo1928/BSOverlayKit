// Caster / producer panel.
const $ = (s) => document.querySelector(s);
let S = null, ws, reqId = 0;
// With staging on, the scene buttons and text cards edit the staged copy ("Next"); { air: true } forces on air.
const STAGEABLE = new Set(["scene", "header", "upNext", "brb", "casters", "castersFrom", "ticker"]);
const send = (action, { air, ...args } = {}) => ws?.readyState === 1 && ws.send(JSON.stringify({ ...args, action, reqId: ++reqId,
  ...(S?.staging && !air && STAGEABLE.has(action) ? { staged: true } : {}) }));
/** The side the cards edit: the staged show while staging, else what is on air. */
const cur = () => (S.staging && S.staged ? S.staged : S.show);
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

let previewSet = false, upShown = "", airList = "";
function render() {
  const sh = cur(), air = S.show;
  const cap = (label) => label[0].toUpperCase() + label.slice(1);
  $("#scenes").innerHTML = Object.entries(S.scenes).map(([id, label]) => `<button data-scene="${id}" class="${sh.scene === id ? "on" : ""} ${air.scene === id ? "air" : ""}">${cap(label)}</button>`).join("");
  // staging: which mode, and whether anything is waiting to go live
  document.body.classList.toggle("staging", !!S.staging);
  $("#staging").checked = !!S.staging;
  $("#stageBar").style.display = $("#nextCard").style.display = $("#airNow").style.display = S.staging ? "" : "none";
  $("#stageBar").classList.toggle("dirty", !!S.stagedDiffers);
  $("#stageWhat").textContent = S.stagedDiffers
    ? `● Changes waiting: Next is ${cap(S.scenes[sh.scene] ?? sh.scene)}, on air is ${cap(S.scenes[air.scene] ?? air.scene)}${S.airMoved ? " (the on-air scene has changed since you started staging)" : ""}`
    : "Scene buttons and the text cards below edit Next, not what is on air. Nothing is waiting: Next is the same as on air.";
  for (const id of ["take", "take2", "discard", "discard2"]) $(`#${id}`).disabled = !S.stagedDiffers;
  $("#airName").textContent = cap(S.scenes[air.scene] ?? air.scene);
  $("#nextName").textContent = cap(S.scenes[sh.scene] ?? sh.scene);
  $("#nextState").textContent = S.stagedDiffers ? "changes waiting" : "same as on air";
  // the emergency list keeps what you picked until the on-air scene itself changes (a redraw must not reset it
  // between choosing a scene and pressing the button)
  const airOpts = Object.entries(S.scenes).map(([id, label]) => `<option value="${id}">${esc(cap(label))}</option>`).join("");
  if (airList !== airOpts + air.scene) { airList = airOpts + air.scene; $("#airScene").innerHTML = airOpts; $("#airScene").value = air.scene; }
  $("#auto").checked = air.auto;
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
    $("#pvNext").addEventListener("load", fit);
    new ResizeObserver(fit).observe($(".preview"));
    fit();
  }
  // the Next preview only exists while staging (it is a second overlay page, without replay viewers)
  const wantNext = S.staging ? `${S.overlayUrl}&debug&bg&staged=1` : "about:blank";
  if ($("#pvNext").dataset.src !== wantNext) { $("#pvNext").dataset.src = wantNext; $("#pvNext").src = wantNext; }
  const scaleNext = $("#nextCard .preview").clientWidth / 1920;
  if (scaleNext) $("#pvNext").style.transform = `scale(${scaleNext})`;
  renderPlaylist();
  // "up next": what is on stream now, and team names to pick from (the followed match and its bracket)
  const un = sh.upNext ?? {};
  const upText = (u = {}) => (u.a && u.b ? `${u.a} vs ${u.b}${u.text ? ` · ${u.text}` : ""}` : u.text || u.a || u.b || "hidden");
  $("#upState").textContent = S.staging ? `next: ${upText(un)} · on air: ${upText(air.upNext)}` : un.a || un.b || un.text ? `showing: ${upText(un)}` : "hidden";
  const br = S.live?.bracket;
  const names = new Set([S.live?.a?.name, S.live?.b?.name, ...[...(br?.rounds ?? []), ...(br?.losers ?? [])].flatMap((r) => r.matches.flatMap((m) => [m.a, m.b]))].filter((n) => n && n !== "TBD"));
  const opts = [...names].map((n) => `<option value="${esc(n)}">`).join("");
  if ($("#teamNames").innerHTML !== opts) $("#teamNames").innerHTML = opts;
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
  $("#signOff").checked = !!S.show.signOff;
  const up = sh.upNext ?? {};
  // only when it changed on the server: what you are typing stays until you press a button
  if (JSON.stringify(up) !== upShown) { upShown = JSON.stringify(up); $("#upA").value = up.a ?? ""; $("#upB").value = up.b ?? ""; $("#upText").value = up.text ?? ""; }
  $("#brbTitle").value = sh.brb.title;
  $("#brbMsg").value = sh.brb.message;
  $("#ticker").value = sh.ticker.join("\n");
  $("#feedA").value = sh.feeds.a ?? "";
  $("#feedB").value = sh.feeds.b ?? "";
  $("#delay").value = sh.streamDelayMs;
  $("#lockPitch").checked = !!sh.viewer?.lockPitch;
  for (const id of ["pitchUp", "pitchDown"]) if (document.activeElement?.id !== id) $("#" + id).value = sh.viewer?.[id] ?? 12;
  const hold = sh.viewer?.pitchHold;
  $("#holdState").textContent = hold && hold.until > Date.now() + clockOffset ? `showing the ${hold.dir} limit…` : "";
  $("#holdUp").disabled = $("#holdDown").disabled = !sh.viewer?.lockPitch;
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
  if (t.id === "take" || t.id === "take2") send("take");
  if (t.id === "discard" || t.id === "discard2") send("discardStaged");
  if (t.id === "airCut") send("scene", { scene: $("#airScene").value, air: true });
  if (t.dataset.sim) send("source", { control: t.dataset.sim });
  if (t.dataset.brb) send("brb", { minutes: Number(t.dataset.brb) });
  if (t.id === "upSet") send("upNext", { a: $("#upA").value, b: $("#upB").value, text: $("#upText").value });
  if (t.id === "upClear") send("upNext", {});
  if (t.id === "copy") navigator.clipboard.writeText($("#obsUrl").value);
  if (t.id === "holdUp" || t.id === "holdDown") send("viewer", { pitchHold: t.id === "holdUp" ? "up" : "down", holdMs: 5000 });
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
  if (el.id === "staging") {
    if (!el.checked && S.stagedDiffers && !confirm("Turn staging off? The changes waiting in Next are thrown away.")) { el.checked = true; return; }
    send("staging", { on: el.checked });
  }
  if (el.id === "speed") send("source", { control: "speed", value: Number(el.value) });
  if (el.dataset.c !== undefined) {
    const casters = structuredClone(cur().casters);
    casters[Number(el.dataset.c)][el.dataset.k] = el.value;
    send("casters", { casters });
  }
  if (el.id === "brbTitle" || el.id === "brbMsg") send("brb", { brb: { title: $("#brbTitle").value, message: $("#brbMsg").value } });
  if (el.id === "bscsMatch") send("source", { control: "follow", matchId: el.value });
  if (el.id === "castersFrom") send("castersFrom", { from: el.checked ? "discord" : "panel" });
  if (el.id === "header") send("header", { header: el.value.trim() });
  if (el.id === "plMode") send("playlist", { op: "mode", mode: el.value });
  if (el.id === "signOff") send("signOff", { on: el.checked });
  if (el.id === "plFollow") send("playlist", { op: "followTeams", on: el.checked });
  if (el.id === "plSort" && el.value) { send("playlist", { op: "sort", by: el.value }); el.value = ""; }
  if (el.id === "ticker") send("ticker", { ticker: el.value.split("\n") });
  if (el.id === "feedA" || el.id === "feedB") send("feeds", { feeds: { ...S.show.feeds, a: $("#feedA").value.trim(), b: $("#feedB").value.trim() } });
  if (el.id === "delay") send("streamDelay", { ms: Number(el.value) });
  if (el.id === "lockPitch") send("viewer", { lockPitch: el.checked });
  // a changed limit is shown straight away: the cameras sit at it for a few seconds
  if (el.id === "pitchUp") send("viewer", { pitchUp: Number(el.value), pitchHold: "up", holdMs: 4000 });
  if (el.id === "pitchDown") send("viewer", { pitchDown: Number(el.value), pitchHold: "down", holdMs: 4000 });
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
  $("#plFollow").checked = pl.followTeams !== false;
  const sc = pl.scope ?? { kind: "none", teams: [] };
  const teamCount = pl.items.filter((x) => x.team).length;
  $("#plScope").textContent = sc.kind === "teams" ? `Playing the replays of the teams up next: ${sc.teams.join(" and ")} (random order).`
    : sc.kind === "special" ? `Playing your own list below${teamCount && pl.followTeams !== false ? " (no team is up next, or the teams up next have no replays)" : ""}.`
    : sc.kind === "all" ? "Nobody is up next and your own list is empty: playing every team's replays (random order)."
    : "Nothing to play yet.";
  const cur = pl.items.find((x) => x.id === pl.current?.id);
  const name = (it) => (it.info?.song ? esc(it.info.song) : esc(it.ref));
  const tag = (it) => (it.team ? `<span class="pl-team" title="A replay this team's player chose on BSCompStats (Teams page). It is removed there.">${esc(it.team)}</span> ` : "");
  const sub = (it) => it.error ? `<span class="err">${esc(it.error)}</span>` : !it.info ? "looking it up…" :
    [it.info.player && `played by ${esc(it.info.player)}`, it.info.difficulty, it.info.stars ? `★ ${it.info.stars.toFixed(2)}` : "",
      it.info.acc ? `${(it.info.acc * 100).toFixed(2)}%` : "", it.info.duration ? fmt(it.info.duration) : ""].filter(Boolean).join(" · ");
  $("#plNow").innerHTML = cur
    ? `<img src="${esc(cur.info?.cover ?? "")}" alt=""><div class="t"><div class="muted" id="plWhat"></div><b>${name(cur)}</b><div class="muted">${sub(cur)}</div>
        <div class="pl-bar"><i id="plBar"></i></div></div>`
    : `<div class="muted">${pl.items.length ? "Starts when a scene with the big box (Starting Soon, Intermission, Be Right Back) is on." : "The playlist is empty. Add replay links below."}</div>`;
  $("#plList").innerHTML = pl.items.length ? pl.items.map((it, i) => `<div class="pl-item ${it.id === pl.current?.id ? "on" : ""}">
      <span class="n">${i + 1}</span><img src="${esc(it.info?.cover ?? "")}" alt="">
      <div class="t">${tag(it)}${name(it)}<br><small>${sub(it)}</small></div>
      <button data-pl="play" data-id="${it.id}" title="Play this one now">▶</button><button data-pl="up" data-id="${it.id}" title="Move up" ${i ? "" : "disabled"}>↑</button>
      <button data-pl="down" data-id="${it.id}" title="Move down" ${i < pl.items.length - 1 ? "" : "disabled"}>↓</button><button data-pl="remove" data-id="${it.id}" title="${it.team ? "A team's replay: take it off on the site's Teams page" : "Remove"}" ${it.team ? "disabled" : ""}>✕</button></div>`).join("")
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
