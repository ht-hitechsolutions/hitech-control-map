// The tutorial: one guided walk through the app, one highlighted part at a time.
// First setting up your own hardware, then editing bindings, using it in the
// viewer and sharing. Steps are a real sequence, so they are numbered.
// `mode` switches the editor to the screen the step talks about.

const STEPS = [
  { mode: "hw", sel: "#devices", side: "below", title: "Add your hardware",
    text: "Everything starts in Edit hardware layout. Click + Device once for each piece of hardware: stick, throttle, button box, pedals. Give each one a name." },
  { mode: "hw", sel: "#work", side: "center", title: "Add a photo, then the controls",
    text: "With a device selected, click Add photo on the right. Then click Add control for every button, hat or switch, and drag its blue circle onto the photo." },
  { mode: "hw", sel: ".inspector", side: "left", title: "Positions and layers",
    text: "For each control, tick the positions it has (up, down, press, turn…) and the layers it uses. Add a layer for every shift button; shift labels show in yellow." },
  { mode: "edit", sel: "#newBtn", side: "right", title: "One profile per aircraft",
    text: "Back in the editor, click New profile and name the aircraft. Duplicate a profile to start the next aircraft from it." },
  { mode: "edit", sel: "#work", side: "center", title: "Type your bindings",
    text: "Pick a profile on the left, then click any label on the photo and type. Press Enter to save. Switch devices with the tabs at the top." },
  { mode: "edit", sel: "#viewBtn", side: "right", title: "See your bindings",
    text: "Open viewer shows your bindings full-size and read-only. Keep it on a second monitor while you fly." },
  { mode: "edit", sel: "#viewBtn", side: "right", title: "In the viewer",
    text: "Click the aircraft name to switch profile and the tabs to switch device. Choose which layers to show, use Find to search every label, and Edit to come back here." },
  { mode: "edit", sel: ".quest", side: "right", title: "On your phone, tablet or VR headset",
    text: "Open this address in the browser of any device on your home network and bookmark it. Changes you make here show up there by themselves." },
  { mode: "edit", sel: "#exportBtn", side: "right", title: "Share with others",
    text: "Export profile saves one file with the aircraft, its hardware layout and photos. Others add it with Import, and nothing of theirs is overwritten." },
  { mode: "edit", sel: "#settingsBtn", side: "right", title: "Settings",
    text: "Set an edit PIN so only you can change things, and let other devices through Windows Firewall if they can’t connect. The tutorial lives here too." },
];

const KEY = "cm.tourDone";
const markDone = () => { try { localStorage.setItem(KEY, "1"); } catch {} };

/** setMode(true|false) switches to the hardware editor or the bindings editor and redraws
 *  synchronously; setMode(null) means the tutorial ended. */
export function startTour(setMode) {
  document.querySelector(".tour")?.remove();
  const root = document.createElement("div");
  root.className = "tour";
  root.innerHTML = `
    <div class="tour-hole"></div>
    <div class="tour-card" role="dialog" aria-live="polite">
      <div class="tour-count"></div>
      <h3 class="tour-title"></h3>
      <p class="tour-text"></p>
      <div class="tour-actions">
        <button class="btn tour-skip">Skip tutorial</button>
        <span class="grow"></span>
        <button class="btn tour-back">Back</button>
        <button class="btn primary tour-next">Next</button>
      </div>
    </div>`;
  document.body.appendChild(root);
  const hole = root.querySelector(".tour-hole"), card = root.querySelector(".tour-card");
  let i = 0, mode = null;

  function place() {
    const st = steps()[i];
    if (st.mode !== mode) { mode = st.mode; setMode(mode === "hw"); }
    const el = document.querySelector(st.sel);
    const r = el && el.offsetParent !== null ? el.getBoundingClientRect() : null;
    root.querySelector(".tour-count").textContent = `Step ${i + 1} of ${steps().length}`;
    root.querySelector(".tour-title").textContent = st.title;
    root.querySelector(".tour-text").textContent = st.text;
    root.querySelector(".tour-back").hidden = i === 0;
    root.querySelector(".tour-next").textContent = i === steps().length - 1 ? "Finish" : "Next";
    const pad = st.side === "center" ? 0 : 6, W = innerWidth, H = innerHeight;
    if (r) {
      const left = Math.max(2, r.left - pad), top = Math.max(2, r.top - pad);
      Object.assign(hole.style, { display: "block", left: left + "px", top: top + "px",
        width: Math.min(W - 4, r.right + pad) - left + "px", height: Math.min(H - 4, r.bottom + pad) - top + "px" });
    } else hole.style.display = "none";
    const cw = card.offsetWidth, ch = card.offsetHeight;
    let x, y;
    if (!r || st.side === "center") { x = (r ? r.left + r.width / 2 : W / 2) - cw / 2; y = (r ? r.top + r.height / 2 : H / 2) - ch / 2; }
    else if (st.side === "right") { x = r.right + 18; y = r.top + r.height / 2 - ch / 2; }
    else if (st.side === "left") { x = r.left - cw - 18; y = r.top + 20; }
    else { x = r.left; y = r.bottom + 18; }
    card.style.left = Math.max(12, Math.min(W - cw - 12, x)) + "px";
    card.style.top = Math.max(12, Math.min(H - ch - 12, y)) + "px";
    root.querySelector(".tour-next").focus();
  }
  const steps = () => STEPS;
  function end() { markDone(); root.remove(); removeEventListener("resize", place); removeEventListener("keydown", keys); setMode(null); }
  function keys(e) {
    if (e.key === "Escape") end();
    if (e.key === "ArrowRight") root.querySelector(".tour-next").click();
    if (e.key === "ArrowLeft" && i > 0) root.querySelector(".tour-back").click();
  }
  root.querySelector(".tour-next").onclick = () => { if (i === steps().length - 1) end(); else { i++; place(); } };
  root.querySelector(".tour-back").onclick = () => { if (i > 0) { i--; place(); } };
  root.querySelector(".tour-skip").onclick = end;
  addEventListener("resize", place);
  addEventListener("keydown", keys);
  requestAnimationFrame(place);
}
