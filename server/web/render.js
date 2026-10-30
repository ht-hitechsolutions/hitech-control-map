// Shared drawing code: one device photo with its control callouts.
// Used by the viewer (read-only) and the PC editor (editable).

export const STAGE_W = 1600, STAGE_H = 900;
const COL_W = 380, ROW_W = 300, GAP = 8;

export const SLOT_GLYPH = { up: "▲", down: "▼", left: "◀", right: "▶", press: "●", cw: "↻", ccw: "↺" };
export const SLOT_NAMES = { up: "Up", down: "Down", left: "Left", right: "Right", press: "Press", cw: "Turn CW", ccw: "Turn CCW", "1": "Position 1", "2": "Position 2" };
export const glyph = s => SLOT_GLYPH[s] || s;

export function layerShort(layer, i) {
  if (i === 0) return "";
  const m = /shift\s+(\S+)/i.exec(layer.name);
  if (m) return m[1].slice(0, 2).toUpperCase();
  if (/shift/i.test(layer.name)) return "";  // plain shift: the yellow colour says it
  return i === 0 ? "" : layer.name.slice(0, 2);
}

const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
};

export function textFor(profile, cid, sid, lid) {
  return profile?.bindings?.[cid]?.[sid]?.[lid] || "";
}

/**
 * opts: { setup, device, profile, mode: "all" | layerId, editable, hwEdit,
 *         photoBase, onEdit(cid,sid,lid,val), onPick(cid), onMove(cid, patch), selected }
 */
export function renderDevice(host, opts) {
  const { setup, device, profile, mode = "all", editable = false, hwEdit = false } = opts;
  host.innerHTML = "";
  const stage = el("div", "stage");
  stage.style.width = STAGE_W + "px";
  stage.style.height = STAGE_H + "px";
  host.appendChild(stage);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "wires");
  svg.setAttribute("viewBox", `0 0 ${STAGE_W} ${STAGE_H}`);

  const plate = el("div", "photo-plate");
  const img = new Image();
  img.className = "photo";
  img.alt = device.name;
  img.draggable = false;
  plate.appendChild(img);
  stage.appendChild(plate);
  stage.appendChild(svg);

  const layers = setup.layers;
  const shownLayers = mode === "all" ? layers.map((l, i) => [l, i]) : layers.map((l, i) => [l, i]).filter(([l]) => l.id === mode);

  const cards = {};
  for (const c of device.controls) {
    const card = el("div", "card");
    card.dataset.cid = c.id;
    card.style.width = (COL_W - 20) + "px";
    const head = el("div", "card-head", c.name);
    card.appendChild(head);
    const dirs = c.slots.map(s => s.id);
    const isCross = ["up", "down", "left", "right"].every(d => dirs.includes(d));
    const body = el("div", isCross ? "cross" : "list");
    let anyText = false;
    for (const s of c.slots) {
      const cell = el("div", "slot slot-" + s.id);
      if (!isCross || s.id === "press" || !["up","down","left","right"].includes(s.id)) cell.appendChild(el("span", "g", glyph(s.id)));
      else cell.dataset.g = glyph(s.id);
      const lines = el("div", "lines");
      for (const [l, i] of shownLayers.filter(([l]) => !c.layers || c.layers.includes(l.id))) {
        const t = textFor(profile, c.id, s.id, l.id);
        if (!t && !editable) continue;
        anyText ||= !!t;
        const line = el("div", "ln L" + Math.min(i, 4));
        const badge = layerShort(l, i);
        if (badge && mode === "all") line.appendChild(el("b", "badge", badge));
        const span = el("span", "tx", t);
        if (editable) {
          span.contentEditable = "plaintext-only";
          span.spellcheck = false;
          span.dataset.ph = l.name;
          span.dataset.key = [c.id, s.id, l.id].join("|");
          span.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); span.blur(); } });
          span.addEventListener("blur", () => {
            const v = span.textContent.trim();
            if (v !== t) opts.onEdit?.(c.id, s.id, l.id, v);
          });
        }
        line.appendChild(span);
        lines.appendChild(line);
      }
      if (!lines.children.length) { cell.classList.add("empty"); lines.appendChild(el("div", "ln none", "—")); }
      cell.appendChild(lines);
      body.appendChild(cell);
    }
    if (isCross) {
      // fixed 3x3 order: up, left, press, right, down
      for (const id of ["up", "left", "press", "right", "down"]) {
        const n = body.querySelector(".slot-" + id);
        if (n) body.appendChild(n);
      }
    }
    if (!anyText && !editable && !hwEdit) card.classList.add("unused");
    card.appendChild(body);
    card.addEventListener("pointerenter", () => highlight(c.id, true));
    card.addEventListener("pointerleave", () => highlight(c.id, false));
    card.addEventListener("click", () => opts.onPick?.(c.id));
    if (opts.selected === c.id) card.classList.add("sel");
    stage.appendChild(card);
    cards[c.id] = card;
  }

  const spots = {};
  function highlight(cid, on) {
    cards[cid]?.classList.toggle("hot", on);
    spots[cid]?.classList.toggle("hot", on);
    stage.querySelectorAll(`[data-wire="${cid}"]`).forEach(w => w.classList.toggle("hot", on));
  }

  function layout() {
    const ar = img.naturalWidth / img.naturalHeight || 1;
    const visible = device.controls.filter(c => !cards[c.id].classList.contains("unused"));
    device.controls.forEach(c => { if (!visible.includes(c)) cards[c.id].style.display = "none"; });
    const sideOf = c => ["left", "right", "top", "bottom"].includes(c.label?.side) ? c.label.side : "left";
    const groups = { left: [], right: [], top: [], bottom: [] };
    for (const c of visible) groups[sideOf(c)].push({ c, card: cards[c.id] });

    // rows above/below the photo: cards are narrower and sit side by side
    // rows above/below: as wide as the photo allows, so each label sits over its control
    const roomW = STAGE_W - (groups.left.length ? COL_W + 40 : 30) - (groups.right.length ? COL_W + 40 : 30);
    for (const side of ["top", "bottom"]) {
      const n = groups[side].length;
      const w = Math.max(210, Math.min(ROW_W, roomW / Math.max(n, 1) - GAP));
      for (const o of groups[side]) o.card.style.width = w + "px";
    }
    for (const side of ["left", "right"]) for (const o of groups[side]) o.card.style.width = (COL_W - 20) + "px";
    for (const g of Object.values(groups)) for (const o of g) { o.card.style.transform = ""; o.h = o.card.offsetHeight; o.w = o.card.offsetWidth; }
    const band = side => groups[side].length ? Math.max(...groups[side].map(o => o.h)) : 0;
    const topH = band("top"), botH = band("bottom");

    // photo gets whatever space the labels leave
    const x0 = groups.left.length ? COL_W + 40 : 30, x1 = STAGE_W - (groups.right.length ? COL_W + 40 : 30);
    const y0 = topH ? topH + 56 : 16, y1 = STAGE_H - (botH ? botH + 56 : 16);
    let pw = x1 - x0, ph = pw / ar;
    if (ph > y1 - y0) { ph = y1 - y0; pw = ph * ar; }
    const px = x0 + (x1 - x0 - pw) / 2, py = y0 + (y1 - y0 - ph) / 2;
    Object.assign(plate.style, { left: px + "px", top: py + "px", width: pw + "px", height: ph + "px" });
    const hot = c => [px + c.x / 100 * pw, py + c.y / 100 * ph];

    svg.innerHTML = "";
    const wire = (c, pts, edge) => {
      const pl = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      if (!c.line) pts[pts.length - 1] = edge;
      pl.setAttribute("points", pts.map(p => p.join(",")).join(" "));
      pl.setAttribute("class", "wire");
      pl.dataset.wire = c.id;
      svg.appendChild(pl);
      if (c.line) {
        const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        const [hx, hy] = pts[pts.length - 1];
        dot.setAttribute("cx", hx); dot.setAttribute("cy", hy); dot.setAttribute("r", 6);
        dot.setAttribute("class", "wire-dot");
        dot.dataset.wire = c.id;
        svg.appendChild(dot);
      }
    };
    // spread items along one axis: keep order, stay near the wanted spot, never overlap
    const spread = (list, size, lo, hi) => {
      let p = lo;
      for (const o of list) { o.pos = Math.max(p, o.want - o[size] / 2); p = o.pos + o[size] + GAP; }
      let lim = hi;
      for (let i = list.length - 1; i >= 0; i--) { const o = list[i]; if (o.pos + o[size] > lim) o.pos = lim - o[size]; lim = o.pos - GAP; }
      const total = list.reduce((t, o) => t + o[size] + GAP, -GAP);
      if (list.length && (list[0].pos < lo || total > hi - lo)) { // doesn't fit: shrink
        const k = Math.max(0.55, (hi - lo) / total);
        let q = lo;
        for (const o of list) { o.k = k; o.pos = q; q += o[size] * k + GAP; }
      }
    };

    // left / right columns, ordered top to bottom by where each control is
    for (const side of ["left", "right"]) {
      const list = groups[side].map(o => Object.assign(o, { want: py + (o.c.label?.y ?? o.c.y) / 100 * ph, key: o.c.line ? o.c.y : (o.c.label?.y ?? 50) }))
        .sort((a, b) => a.key - b.key || (side === "left" ? a.c.x - b.c.x : b.c.x - a.c.x));
      spread(list, "h", 6, STAGE_H - 6);
      for (const o of list) {
        const x = side === "left" ? 10 : STAGE_W - COL_W + 10;
        const k = o.k || 1;
        Object.assign(o.card.style, { left: x + "px", top: o.pos + "px", transform: k < 1 ? `scale(${k})` : "", transformOrigin: side === "left" ? "right top" : "left top" });
        o.card.classList.toggle("side-left", side === "left");
        const cy = o.pos + Math.min(o.h * k / 2, 22);
        const cx = side === "left" ? x + COL_W - 20 : x;
        const out = cx + (side === "left" ? 18 : -18);
        wire(o.c, [[cx, cy], [out, cy], hot(o.c)], [side === "left" ? px : px + pw, o.want]);
      }
    }
    // rows above / below, ordered left to right by where each control is
    for (const side of ["top", "bottom"]) {
      const list = groups[side].map(o => Object.assign(o, { want: hot(o.c)[0] })).sort((a, b) => a.c.x - b.c.x || a.c.y - b.c.y);
      spread(list, "w", 10, STAGE_W - 10);
      if (list.length && !list[0].k) { // centre the row on its controls so lines run nearly straight
        const first = list[0].pos, last = list[list.length - 1].pos + list[list.length - 1].w;
        const avgWant = list.reduce((t, o) => t + o.want, 0) / list.length;
        let shift = avgWant - (first + last) / 2;
        shift = Math.min(Math.max(shift, 10 - first), STAGE_W - 10 - last);
        list.forEach(o => o.pos += shift);
      }
      for (const o of list) {
        const k = o.k || 1;
        const top = side === "top" ? py - 40 - o.h * k : py + ph + 40;
        Object.assign(o.card.style, { left: o.pos + "px", top: top + "px", transform: k < 1 ? `scale(${k})` : "", transformOrigin: side === "top" ? "left bottom" : "left top" });
        if (side === "top") o.card.style.top = (py - 40 - o.h) + "px";
        o.card.classList.remove("side-left");
        const cx = o.pos + o.w * k / 2;
        const cy = side === "top" ? py - 40 : py + ph + 40;
        const out = cy + (side === "top" ? 16 : -16);
        wire(o.c, [[cx, cy], [cx, out], hot(o.c)], [cx, side === "top" ? py : py + ph]);
      }
    }
    // hotspots
    for (const c of device.controls) {
      let s = spots[c.id];
      if (!s) {
        s = el("div", "spot" + (hwEdit ? " edit" : ""));
        s.title = c.name;
        s.addEventListener("pointerenter", () => highlight(c.id, true));
        s.addEventListener("pointerleave", () => highlight(c.id, false));
        s.addEventListener("click", e => { e.stopPropagation(); opts.onPick?.(c.id); });
        plate.appendChild(s);
        spots[c.id] = s;
        if (hwEdit) dragSpot(s, c);
      }
      if (opts.selected === c.id) s.classList.add("sel");
      s.style.left = c.x + "%";
      s.style.top = c.y + "%";
    }
    if (hwEdit) {
      for (const c of device.controls.filter(c => ["left", "right", undefined].includes(c.label?.side))) {
        const a = el("div", "anchor");
        a.title = "Drag to move where the label line meets the photo. Double-click to switch side.";
        a.style.left = (c.label?.side === "right" ? 100 : 0) + "%";
        a.style.top = (c.label?.y ?? 50) + "%";
        plate.appendChild(a);
        dragAnchor(a, c);
      }
    }
  }

  function pct(e) {
    const r = plate.getBoundingClientRect();
    return { x: Math.round(Math.min(100, Math.max(0, (e.clientX - r.left) / r.width * 100)) * 10) / 10,
             y: Math.round(Math.min(100, Math.max(0, (e.clientY - r.top) / r.height * 100)) * 10) / 10 };
  }
  function dragSpot(s, c) {
    s.addEventListener("pointerdown", e => {
      e.preventDefault(); s.setPointerCapture(e.pointerId);
      const mv = ev => { const p = pct(ev); s.style.left = p.x + "%"; s.style.top = p.y + "%"; };
      const up = ev => { s.removeEventListener("pointermove", mv); s.removeEventListener("pointerup", up); const p = pct(ev); opts.onMove?.(c.id, { x: p.x, y: p.y }); };
      s.addEventListener("pointermove", mv); s.addEventListener("pointerup", up);
    });
  }
  function dragAnchor(a, c) {
    a.addEventListener("dblclick", () => opts.onMove?.(c.id, { label: { side: c.label?.side === "right" ? "left" : "right", y: c.label?.y ?? 50 } }));
    a.addEventListener("pointerdown", e => {
      e.preventDefault(); a.setPointerCapture(e.pointerId);
      const mv = ev => { a.style.top = pct(ev).y + "%"; };
      const up = ev => { a.removeEventListener("pointermove", mv); a.removeEventListener("pointerup", up); opts.onMove?.(c.id, { label: { side: c.label?.side || "left", y: pct(ev).y } }); };
      a.addEventListener("pointermove", mv); a.addEventListener("pointerup", up);
    });
  }

  img.onload = layout;
  img.onerror = () => {
    plate.classList.add("missing");
    plate.dataset.msg = navigator.onLine === false || opts.offline
      ? "Can’t load the photo: the PC isn’t reachable"
      : "Photo not found: " + (device.photo || "(none set)") + "\nAdd one in Edit hardware layout";
    layout();
  };
  img.src = (opts.photoBase || "/photos/") + encodeURIComponent(device.photo || "none.png");
  return { highlight, flash(cid) { highlight(cid, true); cards[cid]?.scrollIntoView?.({ block: "nearest" }); setTimeout(() => highlight(cid, false), 2200); } };
}

/** Scale a fixed-size stage to fit its host element. */
export function fitStage(host) {
  const st = host.querySelector(".stage");
  if (!st) return;
  const k = Math.min(host.clientWidth / STAGE_W, host.clientHeight / STAGE_H);
  st.style.transform = `scale(${k})`;
  st.style.left = (host.clientWidth - STAGE_W * k) / 2 + "px";
  st.style.top = (host.clientHeight - STAGE_H * k) / 2 + "px";
}

export function setupOf(state, profile) {
  return state.hardware.setups.find(s => s.id === profile?.setup) || state.hardware.setups[0];
}

export function profileSort(a, b) {
  return (a.sim === "Template") - (b.sim === "Template") || a.sim.localeCompare(b.sim) || a.name.localeCompare(b.name);
}

/** Every binding of a profile as flat rows, for search and lists. */
export function flatten(setup, profile) {
  const rows = [];
  for (const d of setup.devices) for (const c of d.controls) for (const s of c.slots) setup.layers.forEach((l, i) => {
    const t = textFor(profile, c.id, s.id, l.id);
    if (t) rows.push({ device: d, control: c, slot: s, layer: l, li: i, text: t });
  });
  return rows;
}
