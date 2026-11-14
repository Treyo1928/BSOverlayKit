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
    if (m.type === "log") $("#log").insertAdjacentHTML("afterbegin", `<div>${new Date().toLocaleTimeString()}  ${esc(m.text)}</div>`);
    if (m.type === "ack" && !m.ok) tell(m.error);
    if (m.type === "design") $("#log").insertAdjacentHTML("afterbegin", `<div>${new Date().toLocaleTimeString()}  design reloaded</div>`);
  };
}
connect();
// who this is, when they signed in with a site account (the shared code has no name)
fetch("/api/me").then((r) => r.json()).then((me) => {
  $("#who").innerHTML = `${me.name ? `Signed in as <b>${esc(me.name)}</b>` : "Signed in with the code"} <button id="signOut" title="Sign out of the panel on this browser. The stream carries on">Sign out</button>`;
}).catch(() => {});

// What this browser's preview draws: the replays in the video boxes (on unless switched off), and their sound (off
// unless switched on: a browser will not start sound on a page nobody has clicked in anyway).
let pvPrefs = { replays: true, sound: false };
try { pvPrefs = { ...pvPrefs, ...JSON.parse(localStorage.getItem("kit.preview") ?? "{}") }; } catch { /* keep the defaults */ }
if (!pvPrefs.replays) pvPrefs.sound = false;
// checkered = transparent on stream
const previewUrl = () => `${S.overlayUrl}?debug&bg&mute${pvPrefs.sound ? "&listen" : pvPrefs.replays ? "&replays" : ""}`;
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
  // which tournament: offered when the key works in more than one (the one followed is always in the list)
  if (bp && document.activeElement?.id !== "bscsTournament") {
    const list = bp.tournaments?.some((t) => t.slug === bp.tournament) ? bp.tournaments : [{ slug: bp.tournament, name: bp.tournament || "none set" }, ...(bp.tournaments ?? [])];
    $("#bscsTournament").innerHTML = list.map((t) => `<option value="${esc(t.slug)}" ${t.slug === bp.tournament ? "selected" : ""}>${esc(t.name)}</option>`).join("");
    $("#bscsTournamentRow").style.display = list.length > 1 ? "" : "none";
  }
  if (bp && document.activeElement?.id !== "bscsMatch") {
    $("#bscsMatch").innerHTML = `<option value="">Newest unfinished match (automatic)</option>` + bp.matches.map((m) => `<option value="${esc(m.id)}" ${m.id === bp.following && !bp.auto ? "selected" : ""}>${esc(m.label)} (${esc(m.state.toLowerCase())})</option>`).join("");
  }
  $("#simAuto").classList.toggle("on", /auto/.test(S.source.status));
  $("#simStatus").textContent = S.live ? `${S.live.match.phase} · ${S.live.a.name} ${S.live.a.points}–${S.live.b.points} ${S.live.b.name}${S.live.map ? ` · ${S.live.map.name} ${S.live.map.time}` : ""}` : "";
  if (!previewSet) {
    previewSet = true;
    $("#pvReplays").checked = pvPrefs.replays; $("#pvSound").checked = pvPrefs.sound;
    $("#pv").src = previewUrl();
    $("#open").href = `${S.overlayUrl}?bg&debug`;
    // with its key: the page OBS runs is the one whose word on a replay's end is taken (a page without the key
    // shows the same picture; that address is fine to hand to anyone)
    $("#obsUrl").value = location.origin + S.overlayKeyUrl;
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
  const wantNext = S.staging ? `${S.overlayUrl}?debug&bg&staged=1` : "about:blank";
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
  // the mixer: one slider per scene, built once (rebuilding would drop a slider mid-drag)
  const mix = air.mix ?? { music: 1, scenes: {} };   // never staged: it acts on what is on air
  if (document.activeElement?.id !== "mixMusic") $("#mixMusic").value = Math.round(mix.music * 100);
  $("#mixMusicValue").textContent = $("#mixMusic").value;
  if (document.activeElement?.id !== "mixHits") $("#mixHits").value = Math.round((mix.hits ?? 1) * 100);
  $("#mixHitsValue").textContent = $("#mixHits").value;
  const sceneIds = Object.keys(S.scenes).join();
  if ($("#mixScenes").dataset.for !== sceneIds) {
    $("#mixScenes").dataset.for = sceneIds;
    $("#mixScenes").innerHTML = Object.entries(S.scenes).map(([id, label]) =>
      `<div class="row" style="align-items:center;gap:8px"><label style="flex:0 0 9.5em;margin:0" data-mix-label="${id}">${esc(cap(label))}</label><input data-mix="${id}" type="range" min="0" max="100" step="1" style="flex:1"><b data-mix-value="${id}" style="flex:0 0 3.2em;text-align:right"></b></div>`).join("");
  }
  for (const el of $("#mixScenes").querySelectorAll("[data-mix]")) {
    const id = el.dataset.mix;
    if (document.activeElement !== el) el.value = Math.round((mix.scenes?.[id] ?? 1) * 100);
    $(`[data-mix-value="${id}"]`).textContent = `${el.value}%`;
    $(`[data-mix-label="${id}"]`).style.color = air.scene === id ? "#ff8a8a" : "";
    $(`[data-mix-label="${id}"]`).textContent = `${air.scene === id ? "● " : ""}${cap(S.scenes[id])}`;
  }
  if (document.activeElement?.id !== "fov") $("#fov").value = sh.viewer?.fov ?? 70;
  $("#fovValue").textContent = $("#fov").value;
  if (document.activeElement?.id !== "camZ") $("#camZ").value = sh.viewer?.z ?? -0.55;
  $("#camZValue").textContent = zText($("#camZ").value);
  for (const id of ["pitchUp", "pitchDown"]) if (document.activeElement?.id !== id) $("#" + id).value = sh.viewer?.[id] ?? 12;
  const hold = sh.viewer?.pitchHold;
  $("#holdState").textContent = hold && hold.until > Date.now() + clockOffset ? `showing the ${hold.dir} limit…` : "";
  $("#holdUp").disabled = $("#holdDown").disabled = !sh.viewer?.lockPitch;
  $("#renderScale").value = String(sh.viewer?.renderScale ?? 1);
  $("#maxFps").value = String(sh.viewer?.maxFps ?? 60);
  $("#output").value = String(sh.viewer?.output ?? 1080);
  $("#quality").value = sh.viewer?.quality ?? "medium";
  $("#distortion").checked = sh.viewer?.distortion ?? true;
}
// "Are you sure?" and errors are drawn by this page: a browser stops showing its own confirm/alert boxes once
// someone ticks "don't ask again", and then answers "no" by itself, which leaves the button behind it dead.
function ask(question, yesLabel = "Yes", noLabel = "Cancel") {
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.className = "ask";
    d.innerHTML = `<p>${esc(question)}</p><div class="btns">${noLabel ? `<button value="">${esc(noLabel)}</button>` : ""}<button value="yes" class="${noLabel ? "danger" : ""}">${esc(yesLabel)}</button></div>`;
    for (const b of d.querySelectorAll("button")) b.onclick = () => d.close(b.value);
    d.onclick = (e) => e.target === d && d.close("");
    d.onclose = () => { d.remove(); resolve(d.returnValue === "yes"); };
    document.body.append(d);
    d.showModal();
    d.querySelector("button").focus();     // Enter must not carry out something that cannot be undone
  });
}
const tell = (message) => ask(String(message || "That did not work."), "OK", "");
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
  if (t.id === "fovReset") send("viewer", { fov: 70 });
  if (t.id === "camZReset") send("viewer", { z: -0.55 });
  if (t.id === "holdUp" || t.id === "holdDown") send("viewer", { pitchHold: t.id === "holdUp" ? "up" : "down", holdMs: 5000 });
  if (t.id === "plAddBtn") { send("playlist", { op: "add", refs: $("#plAdd").value.split("\n") }); $("#plAdd").value = ""; }
  if (t.id === "plClear") ask("Remove every replay from the playlist?", "Remove them all").then((yes) => yes && send("playlist", { op: "clear" }));
  if (t.id === "signOut") fetch("/api/signout", { method: "POST" }).then(() => location.reload());
  const op = t.dataset.pl;
  if (op) {
    const items = S.playlist.items, i = items.findIndex((x) => x.id === t.dataset.id);
    if (op === "up" || op === "down") send("playlist", { op: "move", id: t.dataset.id, to: i + (op === "up" ? -1 : 1) });
    else send("playlist", { op, id: t.dataset.id });
  }
});
// the mixer's sliders act while they are dragged too
let mixSent = 0, mixLater;
function mixInput(el) {
  if (el.id === "mixMusic") $("#mixMusicValue").textContent = el.value;
  else if (el.id === "mixHits") $("#mixHitsValue").textContent = el.value;
  else if (el.dataset.mix) $(`[data-mix-value="${el.dataset.mix}"]`).textContent = `${el.value}%`;
  clearTimeout(mixLater);
  const wait = Math.max(0, 100 - (performance.now() - mixSent));
  mixLater = setTimeout(() => {
    mixSent = performance.now();
    send("mix", el.id === "mixMusic" ? { music: Number(el.value) / 100 } : el.id === "mixHits" ? { hits: Number(el.value) / 100 } : { scene: el.dataset.mix, level: Number(el.value) / 100 });
  }, wait);
}
// the camera sliders act while they are dragged (at most ten times a second), not only when they are let go
function zText(v) { return Number(v) === 0 ? "at the head" : `${Math.abs(Number(v)).toFixed(2)} m ${Number(v) < 0 ? "back" : "forward"}`; }
let camSent = 0, camLater;
document.addEventListener("input", (e) => {
  if (e.target.id === "mixMusic" || e.target.id === "mixHits" || e.target.dataset?.mix) return mixInput(e.target);
  if (e.target.id !== "fov" && e.target.id !== "camZ") return;
  $("#fovValue").textContent = $("#fov").value;
  $("#camZValue").textContent = zText($("#camZ").value);
  clearTimeout(camLater);
  const wait = Math.max(0, 100 - (performance.now() - camSent));
  camLater = setTimeout(() => { camSent = performance.now(); send("viewer", { fov: Number($("#fov").value), z: Number($("#camZ").value) }); }, wait);
});
document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.id === "auto") send("auto", { on: el.checked });
  if (el.id === "staging") {
    if (!el.checked && S.stagedDiffers) {
      el.checked = true;                 // stays on until the answer is yes
      ask("Turn staging off? The changes waiting in Next are thrown away.", "Turn staging off").then((yes) => yes && send("staging", { on: false }));
      return;
    }
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
  if (el.id === "bscsTournament") {
    const to = el.selectedOptions[0]?.textContent ?? el.value, slug = el.value;
    el.value = S.source.panel?.tournament ?? "";          // stays where it is until the answer is yes
    el.blur();
    ask(`Switch the overlay to ${to}?\n\nIt stops showing the current tournament and follows the newest unfinished match of ${to}. The stream changes straight away.`, `Switch to ${to}`)
      .then((yes) => yes && send("source", { control: "tournament", slug }));
  }
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
  // the preview's own switches: this browser only, remembered here; the preview is loaded again with them
  if (el.id === "pvReplays" || el.id === "pvSound") {
    if (el.id === "pvSound" && el.checked) $("#pvReplays").checked = true;      // sound comes from the replays
    if (el.id === "pvReplays" && !el.checked) $("#pvSound").checked = false;
    pvPrefs = { replays: $("#pvReplays").checked, sound: $("#pvSound").checked };
    try { localStorage.setItem("kit.preview", JSON.stringify(pvPrefs)); } catch { /* private window: not remembered */ }
    $("#pv").src = previewUrl();
  }
  if (el.id === "fov") send("viewer", { fov: Number(el.value) });
  if (el.id === "camZ") send("viewer", { z: Number(el.value) });
  // a changed limit is shown straight away: the cameras sit at it for a few seconds
  if (el.id === "pitchUp") send("viewer", { pitchUp: Number(el.value), pitchHold: "up", holdMs: 4000 });
  if (el.id === "pitchDown") send("viewer", { pitchDown: Number(el.value), pitchHold: "down", holdMs: 4000 });
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
