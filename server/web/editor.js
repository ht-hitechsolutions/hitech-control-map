import { renderDevice, fitStage, setupOf, profileSort, SLOT_NAMES } from "./render.js";
import { startTour } from "./tour.js";

const $ = s => document.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e[k] = v; else if (v === true) e.setAttribute(k, ""); else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
};
const slug = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item";
const clone = o => JSON.parse(JSON.stringify(o));

let state = null;
const params = new URLSearchParams(location.search);
let pid = params.get("profile") || localStorage.getItem("ed.profile");
const startDevice = params.get("device");
const fromViewer = params.get("from") === "viewer";
let hwMode = false;
let setupId = null;      // setup being edited in hardware mode
let deviceId = {};       // setupId -> device id
let selCtl = null;       // selected control (hardware mode)
let lastSave = 0;

// ---------------------------------------------------------------- data
// Every change goes through api(): when the PC owner has set an edit PIN,
// other devices (a phone, a VR headset) are asked for it once and it is remembered.
const pinStore = {
  get() { try { return localStorage.getItem("cm.pin") || ""; } catch { return ""; } },
  set(v) { try { v ? localStorage.setItem("cm.pin", v) : localStorage.removeItem("cm.pin"); } catch {} },
};
async function api(url, opts = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const headers = { ...(opts.headers || {}) };
    const pin = pinStore.get();
    if (pin) headers["X-Edit-Pin"] = pin;
    const r = await fetch(url, { ...opts, headers });
    if (r.status !== 401) return r;
    const why = (await r.text()).trim();
    const entered = prompt(why === "Wrong PIN" ? "Wrong PIN. Enter the edit PIN set on the PC:" : "Enter the edit PIN set on the PC to save changes:");
    if (entered === null) return new Response("No PIN entered, so the change wasn’t saved.", { status: 401 });
    pinStore.set(entered.trim());
  }
  return new Response("Wrong PIN, so the change wasn’t saved.", { status: 401 });
}

async function load() {
  const r = await fetch("/api/state", { cache: "no-store" });
  state = await r.json();
  if (state.needsSetup) { welcome(); return; }
  state.profiles.sort(profileSort);
  if (!state.profiles.find(p => p.id === pid)) pid = state.profiles[0]?.id;
  if (!state.profiles.length && !state.hardware.setups.some(s => s.devices.length)) hwMode = true; // blank start: hardware first
  if (!state.hardware.setups.find(s => s.id === setupId)) setupId = state.hardware.setups[0]?.id;
  if (startDevice && !deviceId.__started) {
    const p = profile();
    if (p) deviceId[p.setup] = startDevice;
    deviceId.__started = true;
  }
  draw();
  setTimeout(offerTutorial, 400);
}

function status(msg, err) { const s = $("#status"); if (s) { s.textContent = msg; s.classList.toggle("err", !!err); } }

const timers = {};
function saveProfile(p, now) {
  lastSave = Date.now();
  status("Saving…");
  clearTimeout(timers[p.id]);
  timers[p.id] = setTimeout(async () => {
    lastSave = Date.now();
    const r = await api("/api/profiles/" + p.id, { method: "PUT", body: JSON.stringify(p) });
    status(r.ok ? "Saved — every open viewer updates by itself" : "Couldn’t save: " + await r.text(), !r.ok);
  }, now ? 0 : 350);
}
async function saveHardware() {
  lastSave = Date.now();
  status("Saving…");
  const r = await api("/api/hardware", { method: "PUT", body: JSON.stringify(state.hardware) });
  lastSave = Date.now();
  status(r.ok ? "Saved" : "Couldn’t save: " + await r.text(), !r.ok);
}

const profile = () => state.profiles.find(p => p.id === pid);
const curSetup = () => hwMode ? state.hardware.setups.find(s => s.id === setupId) : setupOf(state, profile());

// ---------------------------------------------------------------- sidebar
function drawList() {
  const box = $("#plist"); box.innerHTML = "";
  for (const sim of [...new Set(state.profiles.map(p => p.sim))]) {
    box.append(h("h3", {}, sim));
    for (const p of state.profiles.filter(p => p.sim === sim)) {
      box.append(h("button", { class: "pitem", "aria-current": String(!hwMode && p.id === pid), onclick: () => { pid = p.id; localStorage.setItem("ed.profile", pid); hwMode = false; draw(); } },
        h("span", { class: "dot", style: `background:${p.color || "#8fb3d9"}` }), p.name));
    }
  }
  $("#hwBtn").setAttribute("aria-pressed", String(hwMode));
}

// ---------------------------------------------------------------- top bar
function drawBar() {
  const bar = $("#bar"); bar.innerHTML = "";
  if (hwMode) {
    const s = curSetup();
    bar.append(
      h("label", { class: "field" }, "Hardware layout", h("select", { onchange: e => { setupId = e.target.value; selCtl = null; draw(); } },
        state.hardware.setups.map(x => h("option", { value: x.id, selected: x.id === setupId }, x.name)))),
      h("label", { class: "field" }, "Layout name", h("input", { value: s.name, onchange: e => { s.name = e.target.value.trim() || s.name; saveHardware(); drawBar(); } })),
      h("button", { class: "btn", onclick: addSetup }, "New layout"),
      h("span", { class: "grow" }), h("span", { class: "status", id: "status" }),
    );
    return;
  }
  const p = profile();
  if (!p) { bar.append(h("span", { class: "hint" }, "No profiles yet. Use New profile to add one."), h("span", { class: "status", id: "status" })); return; }
  const set = (k, v) => { p[k] = v; saveProfile(p); };
  bar.append(
    h("label", { class: "field" }, "Name", h("input", { value: p.name, size: 22, onchange: e => { set("name", e.target.value.trim() || p.name); drawList(); } })),
    h("label", { class: "field" }, "Simulator", h("input", { value: p.sim, size: 10, list: "sims", onchange: e => { set("sim", e.target.value.trim() || p.sim); state.profiles.sort(profileSort); drawList(); } })),
    h("label", { class: "field" }, "Colour", h("input", { type: "color", value: p.color || "#8fb3d9", oninput: e => { document.documentElement.style.setProperty("--accent", e.target.value); }, onchange: e => { set("color", e.target.value); drawList(); } })),
    h("label", { class: "field" }, "Hardware", h("select", { onchange: e => { set("setup", e.target.value); draw(); } },
      state.hardware.setups.map(x => h("option", { value: x.id, selected: x.id === p.setup }, x.name)))),
    h("button", { class: "btn", onclick: () => newProfile(p) }, "Duplicate"),
    h("button", { class: "btn danger", onclick: deleteProfile }, "Delete"),
    h("span", { class: "grow" }), h("span", { class: "status", id: "status" }),
  );
}

// ---------------------------------------------------------------- stage
let handle = null;
function drawStage() {
  const s = curSetup();
  const work = $("#work");
  work.classList.toggle("hw", hwMode);
  work.querySelector(".inspector")?.remove();
  const devs = $("#devices"); devs.innerHTML = "";
  if (!s) return;
  const key = s.id;
  if (!s.devices.find(d => d.id === deviceId[key])) deviceId[key] = s.devices[0]?.id;
  for (const d of s.devices) devs.append(h("button", { "aria-pressed": String(d.id === deviceId[key]), onclick: () => { deviceId[key] = d.id; selCtl = null; drawStage(); } }, d.name));
  if (hwMode) devs.append(h("button", { onclick: addDevice, title: "Add a device with its own photo" }, "+ Device"));
  $("#hint").textContent = hwMode
    ? "Drag the blue circles onto each control. The pink diamonds set how high each label sits; double-click one to move the label to the other side."
    : "Click any label to edit it. Press Enter to save.";

  const device = s.devices.find(d => d.id === deviceId[key]);
  const focused = document.activeElement?.dataset?.key;
  if (!device) { $("#stage").innerHTML = '<div class="empty-msg" style="padding:60px 40px;text-align:left;max-width:640px"><b style="font-family:var(--cond);font-size:26px;color:var(--ink)">Add your first device</b><br>Click <b>+ Device</b> above, name it (for example “Throttle”), then click <b>Add photo</b>. After that, add a control for each button and drag its circle onto the photo.</div>'; }
  else {
    handle = renderDevice($("#stage"), {
      setup: s, device, profile: hwMode ? null : profile(), mode: "all", editable: !hwMode, hwEdit: hwMode, selected: selCtl,
      onEdit: (cid, sid, lid, val) => {
        const p = profile();
        p.bindings ||= {};
        const slot = ((p.bindings[cid] ||= {})[sid] ||= {});
        if (val) slot[lid] = val; else delete slot[lid];
        saveProfile(p);
        requestAnimationFrame(() => drawStage());
      },
      onPick: cid => { if (hwMode) { selCtl = cid; drawStage(); } },
      onMove: (cid, patch) => {
        const c = device.controls.find(c => c.id === cid);
        Object.assign(c, patch); selCtl = cid; saveHardware(); drawStage();
      },
    });
    fitStage($("#stage"));
    if (focused) document.querySelector(`[data-key="${focused}"]`)?.focus();
  }
  if (hwMode) work.append(inspector(s, device));
}

// ---------------------------------------------------------------- hardware inspector
const SLOT_IDS = ["up", "down", "left", "right", "press", "cw", "ccw", "1", "2"];
function inspector(s, device) {
  const box = h("div", { class: "inspector" });
  if (device) {
    const c = device.controls.find(c => c.id === selCtl);
    if (c) {
      const chk = SLOT_IDS.map(id => h("label", {}, h("input", { type: "checkbox", checked: c.slots.some(x => x.id === id), onchange: e => {
        if (e.target.checked) c.slots.push({ id }); else c.slots = c.slots.filter(x => x.id !== id);
        c.slots.sort((a, b) => SLOT_IDS.indexOf(a.id) - SLOT_IDS.indexOf(b.id));
        saveHardware(); drawStage();
      } }), SLOT_NAMES[id]));
      box.append(h("div", { class: "box" },
        h("h4", {}, "Control"),
        h("label", { class: "field" }, "Name", h("input", { value: c.name, onchange: e => { c.name = e.target.value.trim() || c.name; saveHardware(); drawStage(); } })),
        h("div", { class: "field" }, "Positions this control has", h("div", { class: "checks" }, chk)),
        h("div", { class: "field" }, "Layers this control uses", h("div", { class: "checks" }, s.layers.map(l => {
          const on = !c.layers || c.layers.includes(l.id);
          return h("label", {}, h("input", { type: "checkbox", checked: on, onchange: e => {
            const cur = new Set(c.layers || s.layers.map(x => x.id));
            if (e.target.checked) cur.add(l.id); else cur.delete(l.id);
            if (!cur.size) { e.target.checked = true; return; }
            c.layers = s.layers.map(x => x.id).filter(id => cur.has(id));
            saveHardware(); drawStage();
          } }), l.name);
        }))),
        h("label", { class: "field" }, "Label column", h("select", { onchange: e => { c.label = { side: e.target.value, y: c.label?.y ?? 50 }; saveHardware(); drawStage(); } },
          [["left", "Left of the photo"], ["right", "Right of the photo"], ["top", "Above the photo"], ["bottom", "Below the photo"]]
            .map(([v, t]) => h("option", { value: v, selected: (c.label?.side || "left") === v }, t)))),
        h("label", { class: "checks", style: "grid-template-columns:1fr" }, h("label", {}, h("input", { type: "checkbox", checked: !!c.line, onchange: e => { c.line = e.target.checked; saveHardware(); drawStage(); } }), "Draw the line all the way to the control (for photos without red lines)")),
        h("button", { class: "btn danger", onclick: () => { if (confirm(`Remove “${c.name}”? Its labels stay saved in the profiles but won’t show.`)) { device.controls = device.controls.filter(x => x !== c); selCtl = null; saveHardware(); drawStage(); } } }, "Remove control"),
      ));
    } else {
      box.append(h("p", { class: "hint" }, "Click a blue circle to edit that control."));
    }
    box.append(h("button", { class: "btn primary", onclick: () => {
      const id = slug(device.id + "-ctl") + "-" + Math.random().toString(36).slice(2, 6);
      device.controls.push({ id, name: "New control", x: 50, y: 50, label: { side: "right", y: 50 }, line: true, slots: [{ id: "press" }], layers: [s.layers[0].id] });
      selCtl = id; saveHardware(); drawStage();
    } }, "Add control"));

    const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true, onchange: async e => {
      const f = e.target.files[0]; if (!f) return;
      const ext = (f.name.split(".").pop() || "png").toLowerCase();
      const name = slug(device.name) + "-" + Date.now().toString(36) + "." + ext;
      status("Uploading photo…");
      const r = await api("/api/photos?name=" + encodeURIComponent(name), { method: "POST", body: f });
      if (!r.ok) { status("Couldn’t upload: " + await r.text(), true); return; }
      device.photo = (await r.json()).name; saveHardware(); drawStage();
    } });
    box.append(h("div", { class: "box" },
      h("h4", {}, "Device"),
      h("label", { class: "field" }, "Name", h("input", { value: device.name, onchange: e => { device.name = e.target.value.trim() || device.name; saveHardware(); drawStage(); } })),
      file,
      h("button", { class: device.photo ? "btn" : "btn primary", onclick: () => file.click() }, device.photo ? "Replace photo" : "Add photo"),
      h("button", { class: "btn danger", onclick: () => { if (confirm(`Remove the device “${device.name}” from this layout?`)) { s.devices = s.devices.filter(d => d !== device); saveHardware(); drawStage(); } } }, "Remove device"),
    ));
  }
  const layerBox = h("div", { class: "box" }, h("h4", {}, "Layers"),
    h("p", { class: "hint", style: "margin:0" }, "The first layer is what buttons do normally. Add one per shift or modifier button."));
  s.layers.forEach((l, i) => layerBox.append(h("div", { class: "layer-row" },
    h("input", { value: l.name, onchange: e => { l.name = e.target.value.trim() || l.name; saveHardware(); drawStage(); } }),
    i > 0 ? h("button", { class: "btn danger", title: "Remove layer", onclick: () => { if (confirm(`Remove the layer “${l.name}”?`)) { s.layers.splice(i, 1); saveHardware(); drawStage(); } } }, "Remove") : null)));
  layerBox.append(h("button", { class: "btn", onclick: () => { s.layers.push({ id: "l" + Date.now().toString(36), name: "Shift " + (s.layers.length + 1) }); saveHardware(); drawStage(); } }, "Add layer"));
  box.append(layerBox);
  return box;
}

function addDevice() {
  const s = curSetup();
  const name = prompt("Device name (e.g. Rudder pedals)"); if (!name) return;
  const id = slug(name) + "-" + Date.now().toString(36).slice(-4);
  s.devices.push({ id, name: name.trim(), photo: "", controls: [] });
  deviceId[s.id] = id; saveHardware(); drawStage();
}
function addSetup() {
  const name = prompt("Name for the new hardware layout (e.g. Warthog throttle + VKB stick)"); if (!name) return;
  const id = slug(name) + "-" + Date.now().toString(36).slice(-4);
  state.hardware.setups.push({ id, name: name.trim(), layers: [{ id: "n", name: "Normal" }, { id: "s", name: "Shift" }], devices: [] });
  setupId = id; saveHardware(); draw();
}

// ---------------------------------------------------------------- notes
function drawNotes() {
  const box = $("#notesBox");
  box.hidden = hwMode || !profile();
  if (box.hidden) return;
  const p = profile();
  p.notes ||= [];
  $("#notesSum").textContent = `Notes (${p.notes.length}) — keyboard shortcuts and anything that isn’t on your controls`;
  const n = $("#notes"); n.innerHTML = "";
  p.notes.forEach((note, i) => n.append(h("div", { class: "note-row" },
    h("input", { value: note.label, placeholder: "What", onchange: e => { note.label = e.target.value; saveProfile(p); } }),
    h("input", { value: note.value, placeholder: "How, e.g. RCtrl + Enter", onchange: e => { note.value = e.target.value; saveProfile(p); } }),
    h("button", { class: "btn danger", onclick: () => { p.notes.splice(i, 1); saveProfile(p); drawNotes(); } }, "Remove"))));
  n.append(h("button", { class: "btn", style: "margin-top:8px", onclick: () => { p.notes.push({ label: "", value: "" }); drawNotes(); n.querySelector(".note-row:last-of-type input")?.focus(); } }, "Add note"));
}

// ---------------------------------------------------------------- profiles
function newProfile(from) {
  const dlg = $("#newDlg"), f = $("#newForm");
  f.reset();
  $("#sims").innerHTML = ""; [...new Set(state.profiles.map(p => p.sim))].forEach(s => $("#sims").append(h("option", { value: s })));
  const sel = f.elements.from; sel.innerHTML = "";
  for (const s of state.hardware.setups) sel.append(h("option", { value: "blank:" + s.id }, `Empty — ${s.name}`));
  for (const p of state.profiles) sel.append(h("option", { value: "copy:" + p.id, selected: from ? p.id === from.id : p.id === "base" }, `Copy of ${p.name} (${p.sim})`));
  if (from) { f.elements.name.value = from.name + " copy"; f.elements.sim.value = from.sim; }
  dlg.showModal();
  dlg.onclose = () => {
    if (dlg.returnValue !== "ok") return;
    const name = f.elements.name.value.trim(), sim = f.elements.sim.value.trim();
    const [kind, ref] = sel.value.split(":");
    let p;
    if (kind === "copy") { p = clone(state.profiles.find(x => x.id === ref)); }
    else p = { setup: ref, bindings: {}, notes: [], color: "#8fb3d9" };
    let id = slug(sim + "-" + name), n = 2;
    while (state.profiles.some(x => x.id === id)) id = slug(sim + "-" + name) + "-" + n++;
    Object.assign(p, { id, name, sim });
    state.profiles.push(p); state.profiles.sort(profileSort);
    pid = id; localStorage.setItem("ed.profile", pid); hwMode = false;
    saveProfile(p, true); draw();
  };
}
async function deleteProfile() {
  const p = profile();
  if (!confirm(`Delete the profile “${p.name}”? This can’t be undone (save a backup first if unsure).`)) return;
  lastSave = Date.now();
  const r = await api("/api/profiles/" + p.id, { method: "DELETE" });
  if (!r.ok) { status("Couldn’t delete: " + await r.text(), true); return; }
  state.profiles = state.profiles.filter(x => x !== p);
  pid = state.profiles[0]?.id; draw();
}

// ---------------------------------------------------------------- backup
$("#backupBtn").onclick = () => {
  const blob = new Blob([JSON.stringify({ app: "hitech-control-map", saved: new Date().toISOString(), hardware: state.hardware, profiles: state.profiles }, null, 1)], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: `control-map-backup-${new Date().toISOString().slice(0, 10)}.json` });
  a.click(); URL.revokeObjectURL(a.href);
};
$("#restoreBtn").onclick = () => $("#restoreFile").click();
$("#restoreFile").onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  if (!confirm("Replace all profiles and the hardware layout with this backup? Current profiles are kept as .bak files in the data folder.")) return;
  const r = await api("/api/import", { method: "POST", body: await f.text() });
  if (!r.ok) alert("Couldn’t restore: " + await r.text()); else load();
  e.target.value = "";
};

// ---------------------------------------------------------------- first run
function welcome() {
  const dlg = $("#welcomeDlg");
  if (dlg.open) return;
  dlg.showModal();
  dlg.querySelectorAll("[data-start]").forEach(b => b.onclick = async () => {
    const r = await api("/api/setup", { method: "POST", body: JSON.stringify({ start: b.dataset.start }) });
    if (!r.ok && r.status !== 409) { alert("Couldn’t set up: " + await r.text()); return; }
    dlg.close();
    hwMode = b.dataset.start === "blank";
    tutOffered = true; // the walkthrough starts by itself this time
    await load();
    setTimeout(runTour, 300); // first-time walkthrough
  });
  dlg.oncancel = e => e.preventDefault(); // a choice is needed before anything else works
}

// ---------------------------------------------------------------- sharing
const toDataURL = blob => new Promise((ok, bad) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = bad; fr.readAsDataURL(blob); });
const safeName = s => s.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
async function exportItem() {
  const kind = hwMode ? "layout" : "profile";
  const p = profile();
  const s = hwMode ? curSetup() : setupOf(state, p);
  if (!s || (kind === "profile" && !p)) return;
  status("Preparing the file…");
  const photos = {};
  for (const d of s.devices) {
    if (!d.photo || photos[d.photo]) continue;
    const r = await fetch("/photos/" + encodeURIComponent(d.photo));
    if (r.ok) photos[d.photo] = await toDataURL(await r.blob());
  }
  const file = { app: "hitech-control-map", kind, format: 1, exported: new Date().toISOString(), setup: s, photos };
  if (kind === "profile") file.profile = p;
  const blob = new Blob([JSON.stringify(file)], { type: "application/json" });
  const name = kind === "profile" ? `${p.sim} ${p.name}` : `${s.name} layout`;
  const a = h("a", { href: URL.createObjectURL(blob), download: safeName(name) + ".controlmap.json" });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  status(kind === "profile" ? `Exported “${p.name}” with its hardware layout and photos` : `Exported the “${s.name}” layout with its photos`);
}
$("#exportBtn").onclick = exportItem;
$("#importBtn").onclick = () => $("#importFile").click();
$("#importFile").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  let data;
  try { data = JSON.parse(await f.text()); } catch { alert("That file isn’t a HiTech Control Map file."); return; }
  if (data.hardware && data.profiles) { alert("This is a full backup. Use Restore backup to load it."); return; }
  status("Importing…");
  const r = await api("/api/import-item", { method: "POST", body: JSON.stringify(data) });
  if (!r.ok) { status("Couldn’t import: " + await r.text(), true); return; }
  const res = await r.json();
  lastSave = Date.now();
  if (res.profile) { pid = res.profile; localStorage.setItem("ed.profile", pid); hwMode = false; }
  else { hwMode = true; setupId = res.setup; }
  await load();
  status(res.profile
    ? `Imported “${profile()?.name}”` + (res.addedLayout ? " and its hardware layout" : " (uses your existing layout)")
    : "Imported the hardware layout");
};

// ---------------------------------------------------------------- settings
async function openSettings() {
  const dlg = $("#settingsDlg");
  const st = await (await fetch("/api/settings")).json();
  const fw = await (await fetch("/api/firewall")).json();
  const body = $("#settingsBody"); body.innerHTML = "";
  const pinMsg = h("p", { class: "hint" }, st.pinSet ? "An edit PIN is set. Phones, headsets and other devices need it to change anything; viewing stays open." : "No PIN. Anyone on your network who opens the address can view and edit.");
  const pinIn = h("input", { type: "password", inputmode: "numeric", placeholder: st.pinSet ? "New PIN" : "Choose a PIN", autocomplete: "new-password" });
  const savePin = async pin => {
    const r = await fetch("/api/settings", { method: "PUT", body: JSON.stringify({ pin }) });
    if (!r.ok) { alert(await r.text()); return; }
    openSettings();
  };
  body.append(h("section", { class: "box" }, h("h4", {}, "Edit PIN"), pinMsg,
    st.local
      ? h("div", { class: "layer-row" }, pinIn,
          h("button", { class: "btn primary", onclick: () => pinIn.value.trim() ? savePin(pinIn.value.trim()) : pinIn.focus() }, st.pinSet ? "Change PIN" : "Set PIN"),
          st.pinSet ? h("button", { class: "btn danger", onclick: () => savePin("") }, "Remove PIN") : null)
      : h("p", { class: "hint" }, "The PIN can only be changed on the PC.")));
  if (fw.supported) {
    body.append(h("section", { class: "box" }, h("h4", {}, "Phones, tablets and headsets"),
      fw.allowed
        ? h("p", { class: "hint" }, "Windows Firewall lets other devices on your network connect.")
        : [h("p", { class: "hint" }, "Windows Firewall may block your phone, tablet or headset. Allow it once; Windows asks for permission."), h("button", { class: "btn primary", onclick: allowFirewall }, "Allow on my network")]));
  }
  body.append(h("section", { class: "box" }, h("h4", {}, "Tutorial"),
    h("p", { class: "hint" }, "Setting up your controls, typing bindings, viewing them on any screen and sharing, one step at a time."),
    h("div", { class: "layer-row" },
      h("button", { class: "btn", onclick: () => { dlg.close(); runTour(); } }, "Start the tutorial")),
    h("label", { class: "tut-check" }, h("input", { type: "checkbox", checked: !tutOff.get(), onchange: e => tutOff.set(!e.target.checked) }), "Offer the tutorial when the editor opens")));
  if (!dlg.open) dlg.showModal();
}
async function allowFirewall() {
  status("Waiting for Windows permission…");
  const r = await fetch("/api/firewall", { method: "POST" });
  status(r.ok ? "Allowed. Other devices can connect now." : "Couldn’t allow it: " + await r.text(), !r.ok);
  checkFirewall();
  if ($("#settingsDlg").open) openSettings();
}
async function checkFirewall() {
  try {
    const fw = await (await fetch("/api/firewall")).json();
    const st = await (await fetch("/api/settings")).json();
    $("#fwRow").hidden = !(fw.supported && !fw.allowed && st.local);
  } catch {}
}
$("#settingsBtn").onclick = openSettings;

// ---------------------------------------------------------------- tutorial
function runTour() {
  startTour(hw => {
    if (hw === null) hw = !state.hardware.setups.some(s => s.devices.length); // done: nothing set up yet? stay in hardware
    if (hwMode !== hw) { hwMode = hw; selCtl = null; if (hw && profile()) setupId = profile().setup; draw(); }
  });
}

// ---------------------------------------------------------------- tutorial offer
// Shown each time the editor opens, until "Don't show again" is ticked.
// Not when the editor was opened from the viewer (mid-flight) or right after first-time setup.
const tutOff = { get() { try { return localStorage.getItem("cm.tutOffer") === "off"; } catch { return false; } },
                 set(v) { try { v ? localStorage.setItem("cm.tutOffer", "off") : localStorage.removeItem("cm.tutOffer"); } catch {} } };
let tutOffered = false;
function offerTutorial() {
  if (tutOffered || fromViewer || tutOff.get()) return;
  tutOffered = true;
  const dlg = $("#tutDlg");
  $("#tutOff").checked = false;
  const close = () => { tutOff.set($("#tutOff").checked); dlg.close(); };
  $("#tutStart").onclick = () => { close(); runTour(); };
  $("#tutClose").onclick = close;
  dlg.oncancel = () => tutOff.set($("#tutOff").checked);
  dlg.showModal();
}
$("#fwBtn").onclick = allowFirewall;
checkFirewall();

// ---------------------------------------------------------------- wiring
$("#newBtn").onclick = () => newProfile(null);
$("#viewBtn").onclick = () => {
  const p = profile(), dev = p && deviceId[p.setup];
  if (p) {
    try { // open the viewer on the aircraft and device being edited
      localStorage.setItem("hv.profile", JSON.stringify(p.id));
      const devs = JSON.parse(localStorage.getItem("hv.devices") || "{}");
      if (dev) devs[p.id] = dev;
      localStorage.setItem("hv.devices", JSON.stringify(devs));
    } catch {}
  }
  location.href = "./";
};
if (fromViewer) { $("#viewBtn").textContent = "Back to viewer"; $("#viewBtn").classList.add("primary"); $("#newBtn").classList.remove("primary"); }
$("#hwBtn").onclick = () => { hwMode = !hwMode; selCtl = null; if (hwMode && profile()) setupId = profile().setup; draw(); };

function draw() {
  const p = profile();
  $("#exportBtn").textContent = hwMode ? "Export layout" : "Export profile";
  $("#exportBtn").disabled = hwMode ? !curSetup() : !p;
  document.documentElement.style.setProperty("--accent", (!hwMode && p?.color) || "#8fb3d9");
  drawList(); drawBar(); drawStage(); drawNotes();
}
addEventListener("resize", () => fitStage($("#stage")));

fetch("/api/info").then(r => r.json()).then(i => { $("#questUrl").textContent = i.urls[0] || "(no network found)"; $("#questUrl").title = i.urls.join("\n"); });
const es = new EventSource("/api/events");
es.addEventListener("changed", () => { if (Date.now() - lastSave > 2000 && !document.activeElement?.isContentEditable) load(); });
load();
