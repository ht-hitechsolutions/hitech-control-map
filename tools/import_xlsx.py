"""One-time importer: HiTech Hardware Mapping.xlsx -> app data (hardware.json + profiles/*.json).

The sheet is a "callout board": photos with red lines, and labels in the cells where
each line ends. Every label cell is mapped here to (device, control, slot, layer).
Any non-empty cell that isn't mapped is kept as a profile note, so nothing is lost.

usage: python3 import_xlsx.py <xlsx> server/seed/example
"""
import json, os, re, sys
import openpyxl

# ---------------------------------------------------------------- hardware
def ctl(cid, name, hx, hy, side, ly, slots):
    # photos are cleaned of the red callout lines, so the app draws each line
    # straight to the control; the label sits level with the control
    return {"id": cid, "name": name, "x": hx, "y": hy,
            "label": {"side": side, "y": hy}, "line": True,
            "slots": [{"id": s} for s in slots]}

HAT = ["up", "left", "right", "down"]

HOTAS = {
    "id": "hotas", "name": "Custom HOTAS",
    "layers": [{"id": "n", "name": "Normal"}, {"id": "s", "name": "Shift"}],
    "devices": [
        {"id": "stick", "name": "Stick", "photo": "stick-clean.png", "controls": [
            ctl("trim-hat", "Trim hat", 58, 16, "right", 14, HAT),
            ctl("small-btn", "Small button", 58, 28, "right", 25, ["press"]),
            ctl("sensor-hat", "Castle switch", 44, 30, "left", 36, HAT),
            ctl("trigger", "Trigger", 43, 45, "right", 47, ["press"]),
            ctl("rocker", "Lower rocker", 46, 59, "right", 58, ["press"]),
            ctl("pinky", "Red pinky button", 54, 67, "right", 68, ["press"]),
            ctl("pickle", "Red top button", 24, 43, "left", 47, ["press"]),
            ctl("small-lever", "Small lever", 43, 52, "left", 58, ["press"]),
            ctl("base-lever", "Base flip lever", 32, 65, "left", 68, ["press"]),
        ]},
        {"id": "throttle-side", "name": "Throttle side", "photo": "throttle-side-clean.png", "controls": [
            ctl("ts-wheel", "Grey wheel", 53, 37, "left", 37, ["1", "2"]),
            ctl("ts-stick", "Mini stick", 52, 54, "left", 53, ["1", "2"]),
            ctl("ts-rocker", "Black rocker", 54, 70, "left", 69, ["1", "2"]),
            ctl("ts-lever", "White lever", 61, 81, "left", 85, ["1", "2"]),
        ]},
        {"id": "throttle-top", "name": "Throttle top", "photo": "throttle-top-clean.png", "controls": [
            ctl("tt-lever", "Black lever", 17.5, 35, "left", 37, ["press"]),
            ctl("tt-wheel", "Knurled wheel", 20, 68, "left", 68, ["up", "down"]),
            ctl("tt-red", "Red button", 34, 64, "left", 99, ["press"]),
            ctl("tt-hat", "White hat", 62, 63, "right", 0, HAT),
            ctl("tt-stick", "Black mini stick", 76, 63, "right", 63, HAT),
        ]},
        {"id": "button-box", "name": "Button box", "photo": "button-box-clean.png", "controls": [
            ctl("bb-knob-c", "Center knob", 63, 43, "top", 0, ["cw", "press", "ccw"]),
            ctl("bb-knob-l", "Left knob", 48, 42, "top", 20, ["cw", "press", "ccw"]),
            ctl("bb-side", "Side toggle", 9, 39, "left", 40, ["up", "down"]),
            ctl("bb-t1", "Toggle 1", 39, 64, "bottom", 79, ["up", "down"]),
            ctl("bb-t2", "Toggle 2", 54, 65, "bottom", 99, ["up", "down"]),
            ctl("bb-knob-r", "Right knob", 79, 44, "top", 20, ["cw", "press", "ccw"]),
            ctl("bb-t4", "Toggle 4", 85, 65, "bottom", 79, ["up", "down"]),
            ctl("bb-t3", "Toggle 3", 70, 65, "bottom", 99, ["up", "down"]),
            dict(ctl("bb-red", "Gear lever", 27, 52, "left", 60, ["up", "down"]), line=True),
        ]},
    ],
}

GAMEPAD = {
    "id": "gamepad", "name": "Gamepad (Machenike G5 Pro)",
    "layers": [{"id": "n", "name": "No Shift"}, {"id": "y", "name": "Shift Y"},
               {"id": "b", "name": "Shift B"}, {"id": "a", "name": "Shift A"},
               {"id": "x", "name": "Shift X"}],
    "devices": [
        {"id": "gp-front", "name": "Gamepad", "photo": "gamepad-front-clean.png", "controls": [
            ctl("gp-ls", "Left stick", 28, 36, "left", 36, HAT + ["press"]),
            ctl("gp-dpad", "D-pad", 39, 58, "left", 76, HAT),
            ctl("gp-view", "View", 40, 29, "top", 0, ["press"]),
            ctl("gp-menu", "Menu", 57, 29, "top", 9, ["press"]),
            ctl("gp-y", "Y", 66, 30, "top", 31, ["press"]),
            ctl("gp-b", "B", 71, 39, "right", 38, ["press"]),
            ctl("gp-a", "A", 66, 47, "right", 47, ["press"]),
            ctl("gp-x", "X", 61, 39, "top", 57, ["press"]),
            ctl("gp-rs", "Right stick", 58, 57, "bottom", 77, HAT + ["press"]),
        ]},
        {"id": "gp-triggers", "name": "Triggers", "photo": "gamepad-triggers-clean.png", "controls": [
            ctl("gp-lt", "LT", 39, 45, "left", 45, ["press"]),
            ctl("gp-lb", "LB", 42, 71, "left", 71, ["press"]),
            ctl("gp-rt", "RT", 77, 45, "right", 45, ["press"]),
            ctl("gp-rb", "RB", 74, 71, "right", 71, ["press"]),
        ]},
    ],
}

# ---------------------------------------------------------------- cell maps
# cell -> (control, slot, layer)
H = {}
def put(cell, c, s, l="n"): H[cell] = (c, s, l)

# stick
for cell, s in [("L4", "up"), ("L3", "up"), ("K5", "left"), ("M5", "right"), ("L6", "down")]:
    put(cell, "trim-hat", s)
put("K8", "small-btn", "press"); put("K9", "small-btn", "press", "s")
for (n, s_, slot) in [("L10", "L11", "up"), ("K11", "K12", "left"), ("M11", "M12", "right"), ("L12", "L13", "down")]:
    put(n, "sensor-hat", slot); put(s_, "sensor-hat", slot, "s")
put("K14", "trigger", "press"); put("K15", "trigger", "press", "s")
put("K18", "rocker", "press"); put("L18", "rocker", "press", "s")
put("K21", "pinky", "press")
put("I14", "pickle", "press"); put("I15", "pickle", "press", "s")
put("I18", "small-lever", "press"); put("I19", "small-lever", "press", "s")
put("I21", "base-lever", "press"); put("I22", "base-lever", "press", "s")
# throttle side: col B = slot 1, col C = slot 2; row r normal, r+1 shift
for r, c in [(8, "ts-wheel"), (11, "ts-stick"), (14, "ts-rocker"), (17, "ts-lever")]:
    put(f"B{r}", c, "1"); put(f"C{r}", c, "2")
    put(f"B{r+1}", c, "1", "s"); put(f"C{r+1}", c, "2", "s")
# throttle top
put("C23", "tt-lever", "press"); put("C24", "tt-lever", "press", "s")
put("C26", "tt-wheel", "up"); put("C27", "tt-wheel", "down")
put("B26", "tt-wheel", "up", "s"); put("B27", "tt-wheel", "down", "s")
put("C29", "tt-red", "press")
for (n, s_, slot) in [("F18", "F19", "up"), ("E20", "E21", "left"), ("G20", "G21", "right"), ("F22", "F23", "down")]:
    put(n, "tt-hat", slot); put(s_, "tt-hat", slot, "s")
for cell, slot in [("F25", "up"), ("E26", "left"), ("G26", "right"), ("F27", "down")]:
    put(cell, "tt-stick", slot)
# button box
for r, slot in [(32, "cw"), (33, "press"), (34, "ccw")]:
    put(f"C{r}", "bb-knob-c", slot); put(f"B{r}", "bb-knob-c", slot, "s")
for r, slot in [(35, "cw"), (36, "press"), (37, "ccw")]:
    put(f"C{r}", "bb-knob-l", slot); put(f"B{r}", "bb-knob-l", slot, "s")
    put(f"F{r}", "bb-knob-r", slot); put(f"G{r}", "bb-knob-r", slot, "s")
put("C39", "bb-side", "up"); put("C40", "bb-side", "down")
put("C45", "bb-t1", "up"); put("C46", "bb-t1", "down")
put("F45", "bb-t4", "up"); put("F46", "bb-t4", "down")
put("C48", "bb-t2", "up"); put("C49", "bb-t2", "down")
put("F48", "bb-t3", "up"); put("F49", "bb-t3", "down")

G = {}
def gput(cell, c, s, l="n"): G[cell] = (c, s, l)
gput("B14", "gp-ls", "up"); gput("A15", "gp-ls", "left"); gput("C15", "gp-ls", "right"); gput("B16", "gp-ls", "down")
gput("B15", "gp-ls", "press", "x")          # "Foreground Blur", triggered with X+L3 (C14)
for top, lay in [(21, "y"), (24, "b"), (27, "a"), (30, "x")]:
    gput(f"B{top}", "gp-dpad", "up", lay); gput(f"B{top+2}", "gp-dpad", "down", lay)
    gput(f"A{top+1}", "gp-dpad", "left", lay); gput(f"C{top+1}", "gp-dpad", "right", lay)
gput("K14", "gp-y", "press"); gput("K16", "gp-b", "press"); gput("K17", "gp-a", "press"); gput("K19", "gp-x", "press")
gput("L21", "gp-rs", "up"); gput("K22", "gp-rs", "left"); gput("M22", "gp-rs", "right"); gput("L23", "gp-rs", "down")
gput("C36", "gp-lt", "press"); gput("K36", "gp-rt", "press")
gput("C39", "gp-lb", "press"); gput("K39", "gp-rb", "press")
G_IGNORE = {"H1", "F13", "C14", "B19", "B22", "B25", "B28", "B31"}  # title + layer headers

# The gamepad photo is the manufacturer's product image, so it is not shipped
# with the public example. Set to True for a personal build.
INCLUDE_GAMEPAD = False

TABS = {
    "DCS - Hornet":   ("dcs-fa-18c", "DCS", "F/A-18C Hornet", "hotas"),
    "DCS - Huey":     ("dcs-uh-1h", "DCS", "UH-1H Huey", "hotas"),
    "DCS - A10A":     ("dcs-a-10a", "DCS", "A-10A", "hotas"),
    "DCS - F5E":      ("dcs-f-5e", "DCS", "F-5E", "hotas"),
    "DCS - F4E":      ("dcs-f-4e", "DCS", "F-4E", "hotas"),
    "DCS - Spitfire": ("dcs-spitfire", "DCS", "Spitfire", "hotas"),
    "Map Base":       ("base", "Template", "Base layout", "hotas"),
    "IL2":            ("il2", "IL-2", "IL-2 Great Battles", "hotas"),
    "MSFS - Drone":   ("msfs-drone", "MSFS", "Drone camera", "gamepad"),
}

SHIFT_KEYS = {"K21", "C29"}  # the shift buttons themselves are painted in the shift colour

def grid_from_formatting(ws):
    """The sheet's conditional formatting paints every slot, even empty ones:
    light green = normal slot, dark green = shift slot. Read which is which."""
    from openpyxl.utils.cell import range_boundaries, get_column_letter
    normal, shift = set(), set()
    for cf in ws.conditional_formatting:
        for r in cf.rules:
            if r.type != "containsBlanks" or not r.dxf or not r.dxf.fill: continue
            rgb = str(r.dxf.fill.bgColor.rgb or r.dxf.fill.fgColor.rgb)[-6:].upper()
            target = normal if rgb == "B6D7A8" else shift if rgb == "274E13" else None
            if target is None: continue
            for rng in str(cf.sqref).split():
                c1, r1, c2, r2 = range_boundaries(rng)
                for col in range(c1, c2 + 1):
                    for row in range(r1, r2 + 1):
                        target.add(f"{get_column_letter(col)}{row}")
    return normal, shift - SHIFT_KEYS

def main(xlsx, out):
    wb = openpyxl.load_workbook(xlsx)
    os.makedirs(os.path.join(out, "profiles"), exist_ok=True)
    used = {}  # (setup, control) -> layers that have a slot in the sheet
    normal, shift = grid_from_formatting(wb["Map Base"])
    for cells, layer in ((normal, "n"), (shift, "s")):
        for cell in sorted(cells):
            if cell not in H:
                print("WARNING: painted slot not mapped:", cell); continue
            ctl_, slot, l = H[cell]
            if l != layer: print(f"WARNING: {cell} painted as {layer} but mapped as {l}")
            used.setdefault(("hotas", ctl_), set()).add(layer)
    for ws in wb.worksheets:
        pid, sim, name, setup = TABS[ws.title]
        if setup == "gamepad" and not INCLUDE_GAMEPAD:
            continue
        cmap = G if setup == "gamepad" else H
        title = None; color = None
        bindings, notes, leftovers = {}, [], {}
        for row in ws.iter_rows():
            for c in row:
                v = c.value
                if v is None or str(v).strip() == "":
                    continue
                v = str(v).strip()
                if c.coordinate in ("F1", "H1"):
                    title = v
                    if c.fill and c.fill.fill_type and isinstance(c.fill.fgColor.rgb, str):
                        color = "#" + c.fill.fgColor.rgb[-6:]
                    continue
                if setup == "gamepad" and c.coordinate in G_IGNORE:
                    continue
                if c.coordinate in cmap:
                    ctl_, slot, layer = cmap[c.coordinate]
                    bindings.setdefault(ctl_, {}).setdefault(slot, {})[layer] = v
                    used.setdefault((setup, ctl_), set()).add(layer)
                else:
                    leftovers[c.coordinate] = v
        # leftovers -> notes. "Label:" in col K/J with value in next col = key/value note
        taken = set()
        for coord, v in sorted(leftovers.items(), key=lambda kv: (int(re.sub(r"\D", "", kv[0])), kv[0])):
            if coord in taken: continue
            col = re.sub(r"\d", "", coord); r = int(re.sub(r"\D", "", coord))
            nxt = chr(ord(col) + 1) + str(r)
            if nxt in leftovers:
                notes.append({"label": v.rstrip(":").strip(), "value": leftovers[nxt]}); taken |= {coord, nxt}
            else:
                notes.append({"label": "", "value": v}); taken.add(coord)
        for n in notes:  # Spitfire: label sits to the right of its text
            if n["value"] == "Botoes da base":
                n["label"], n["value"] = "Botões da base", n["label"]
        if setup == "gamepad":
            notes.append({"label": "Left stick press (Shift X)", "value": "X + L3"})
        if setup == "hotas":  # red up/down switch: gear on every aircraft
            bindings.setdefault("bb-red", {"up": {"n": "Gear Up"}, "down": {"n": "Gear Down"}})
        prof = {"id": pid, "sim": sim, "name": name, "setup": setup,
                "color": color or "#8fb3d9", "bindings": bindings, "notes": notes}
        with open(os.path.join(out, "profiles", pid + ".json"), "w") as f:
            json.dump(prof, f, indent=1, ensure_ascii=False)
        print(f"{ws.title:16} -> {pid:14} {sum(len(s) for c in bindings.values() for s in c.values()):3} labels, notes={notes}")
    return used

def write_hardware(out, used):
    # A control only offers the layers the sheet actually uses on it
    # (e.g. the stick trim hat has no shift function).
    setups = (HOTAS, GAMEPAD) if INCLUDE_GAMEPAD else (HOTAS,)
    for st in setups:
        order = [l["id"] for l in st["layers"]]
        for d in st["devices"]:
            for c in d["controls"]:
                ls = used.get((st["id"], c["id"])) or {order[0]}
                c["layers"] = [l for l in order if l in ls]
    with open(os.path.join(out, "hardware.json"), "w") as f:
        json.dump({"rev": 6, "setups": list(setups)}, f, indent=1)

if __name__ == "__main__":
    write_hardware(sys.argv[2], main(sys.argv[1], sys.argv[2]))
