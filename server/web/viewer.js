import { renderDevice, fitStage, setupOf, profileSort, flatten, layerShort, glyph } from "./render.js";

const $ = s => document.querySelector(s);
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem("hv." + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("hv." + k, JSON.stringify(v)); } catch {} },
};

let state = null;
let pid = store.get("profile", null);
let devByProfile = store.get("devices", {});
let mode = store.get("mode", "all");
let handle = null;

async function load() {
  try {
    const r = await fetch("/api/state", { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    state = await r.json();
    store.set("cache", state);
  } catch {
    state = state || store.get("cache", null);
    setLive(false);
  }
  if (state?.needsSetup) { $("#pname").textContent = "HiTech Control Map"; $("#stage").innerHTML = '<div class="empty-msg">Finish the first-time setup in the editor on your PC, then this page fills in by itself.</div>'; return; }
  if (!state) { $("#stage").innerHTML = '<div class="empty-msg">Can’t reach HiTech Control Map on your PC. Check that it is running and that this device is on the same network.</div>'; return; }
  state.profiles.sort(profileSort);
  if (!state.profiles.find(p => p.id === pid)) pid = state.profiles[0]?.id;
  draw();
}

const profile = () => state.profiles.find(p => p.id === pid);

function draw() {
  const p = profile();
  if (!p) { $("#pname").textContent = "No profiles yet"; $("#stage").innerHTML = '<div class="empty-msg">Add a profile in the editor on your PC.</div>'; return; }
  const setup = setupOf(state, p);
  document.documentElement.style.setProperty("--accent", p.color || "#8fb3d9");
  $("#pname").textContent = p.name;
  $("#psim").textContent = p.sim;
  $("#notesBtn").hidden = !(p.notes && p.notes.length);

  let did = devByProfile[p.id];
  if (!setup.devices.find(d => d.id === did)) did = setup.devices[0]?.id;
  devByProfile[p.id] = did; store.set("devices", devByProfile);

  const devs = $("#devices"); devs.innerHTML = "";
  for (const d of setup.devices) {
    const b = document.createElement("button");
    b.textContent = d.name;
    b.setAttribute("aria-pressed", d.id === did);
    b.onclick = () => { devByProfile[p.id] = d.id; store.set("devices", devByProfile); draw(); };
    devs.appendChild(b);
  }

  if (mode !== "all" && !setup.layers.find(l => l.id === mode)) mode = "all";
  const lay = $("#layers"); lay.innerHTML = "";
  const opts = [["all", "All", 0], ...setup.layers.map((l, i) => [l.id, l.name, i])];
  for (const [id, name, i] of opts) {
    const b = document.createElement("button");
    b.className = "lay";
    b.textContent = name;
    if (id !== "all" && i > 0) b.style.color = `var(--L${Math.min(i, 4)})`;
    b.setAttribute("aria-pressed", id === mode);
    b.onclick = () => { mode = id; store.set("mode", mode); draw(); };
    lay.appendChild(b);
  }

  $("#editBtn").href = `editor.html?profile=${encodeURIComponent(p.id)}&device=${encodeURIComponent(did)}&from=viewer`;
  const device = setup.devices.find(d => d.id === did);
  if (!device) { $("#stage").innerHTML = '<div class="empty-msg">This layout has no devices yet.</div>'; return; }
  handle = renderDevice($("#stage"), { setup, device, profile: p, mode, offline });
  fitStage($("#stage"));
}

addEventListener("resize", () => fitStage($("#stage")));

// ---- overlays
function open(id) { document.querySelectorAll(".overlay").forEach(o => o.classList.toggle("open", o.id === id)); }
function closeAll() { document.querySelectorAll(".overlay").forEach(o => o.classList.remove("open")); }
document.querySelectorAll("[data-close]").forEach(b => b.onclick = closeAll);
addEventListener("keydown", e => { if (e.key === "Escape") closeAll(); });

$("#who").onclick = () => {
  const list = $("#pickList"); list.innerHTML = "";
  const sims = [...new Set(state.profiles.map(p => p.sim))];
  for (const sim of sims) {
    const h = document.createElement("h2"); h.textContent = sim; list.appendChild(h);
    const g = document.createElement("div"); g.className = "tiles";
    for (const p of state.profiles.filter(p => p.sim === sim)) {
      const t = document.createElement("button");
      t.className = "tile";
      t.setAttribute("aria-current", p.id === pid);
      t.innerHTML = `<span class="dot" style="background:${p.color || "#8fb3d9"}"></span>`;
      t.append(p.name);
      t.onclick = () => { pid = p.id; store.set("profile", pid); closeAll(); draw(); };
      g.appendChild(t);
    }
    list.appendChild(g);
  }
  open("pickO");
};

$("#searchBtn").onclick = () => { open("searchO"); $("#q").value = ""; search(); setTimeout(() => $("#q").focus(), 50); };
$("#q").oninput = search;
function search() {
  const p = profile(); if (!p) return;
  const setup = setupOf(state, p);
  const q = $("#q").value.trim().toLowerCase();
  const out = $("#results"); out.innerHTML = "";
  const rows = flatten(setup, p).filter(r => !q || r.text.toLowerCase().includes(q) || r.control.name.toLowerCase().includes(q));
  if (!rows.length) { out.innerHTML = '<div class="empty-msg">Nothing matches. Try a shorter word.</div>'; return; }
  for (const r of rows.slice(0, 80)) {
    const b = document.createElement("button");
    b.className = "res";
    const t = document.createElement("span"); t.className = "t ln L" + Math.min(r.li, 4);
    const badge = layerShort(r.layer, r.li);
    if (badge) { const bb = document.createElement("b"); bb.className = "badge"; bb.textContent = badge; t.appendChild(bb); }
    t.append(r.text);
    const w = document.createElement("span"); w.className = "w";
    w.textContent = `${r.device.name} › ${r.control.name} ${glyph(r.slot.id)}`;
    b.append(t, w);
    b.onclick = () => {
      devByProfile[p.id] = r.device.id; store.set("devices", devByProfile);
      if (mode !== "all" && mode !== r.layer.id) { mode = "all"; store.set("mode", mode); }
      closeAll(); draw(); setTimeout(() => handle?.flash(r.control.id), 80);
    };
    out.appendChild(b);
  }
}

$("#notesBtn").onclick = () => {
  const p = profile();
  $("#notesTitle").textContent = p.name + " notes";
  const l = $("#notesList"); l.innerHTML = "";
  for (const n of p.notes || []) {
    const d = document.createElement("div"); d.className = "note";
    const b = document.createElement("b"); b.textContent = n.label;
    const v = document.createElement("span"); v.textContent = n.value;
    d.append(b, v); l.appendChild(d);
  }
  open("notesO");
};

// ---- live updates from the PC
let offline = false;
function setLive(on) {
  $("#live").classList.toggle("off", !on);
  $("#live span").textContent = on ? "Live" : "Offline";
  $("#offlineBar").classList.toggle("on", !on);
  const was = offline; offline = !on;
  if (was && on) load();          // back online: reload labels and photos
}
function connect() {
  const es = new EventSource("/api/events");
  let first = true;
  es.addEventListener("hello", () => { setLive(true); if (!first) load(); first = false; });
  es.addEventListener("changed", () => load());
  es.onerror = () => setLive(false);
  es.onopen = () => { setLive(true); };
}

if ("serviceWorker" in navigator && isSecureContext) navigator.serviceWorker.register("sw.js").catch(() => {});
load();
connect();
