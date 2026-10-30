// Features for sharing HiTech Control Map with other people:
// first-run choice, single profile/layout sharing, edit PIN, firewall helper.
package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// ------------------------------------------------------------------ first run

func needsSetup() bool {
	_, err := os.Stat(filepath.Join(dataDir, "hardware.json"))
	return err != nil
}

// POST /api/setup {"start": "example" | "blank"}
func handleSetup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method", 405)
		return
	}
	v, _, err := readJSON(r, 4096)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	mu.Lock()
	defer mu.Unlock()
	if !needsSetup() {
		http.Error(w, "already set up", 409)
		return
	}
	switch v["start"] {
	case "example":
		err = fs.WalkDir(seedFS, "seed/example", func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			rel := strings.TrimPrefix(strings.TrimPrefix(p, "seed/example"), "/")
			dst := filepath.Join(dataDir, filepath.FromSlash(rel))
			if d.IsDir() {
				return os.MkdirAll(dst, 0o755)
			}
			b, err := seedFS.ReadFile(p)
			if err != nil {
				return err
			}
			return os.WriteFile(dst, b, 0o644)
		})
	case "blank":
		hw := map[string]any{"rev": seedRev(), "setups": []any{map[string]any{
			"id": "my-controls", "name": "My controls",
			"layers":  []any{map[string]any{"id": "n", "name": "Normal"}, map[string]any{"id": "s", "name": "Shift"}},
			"devices": []any{},
		}}}
		b, _ := json.MarshalIndent(hw, "", " ")
		err = writeAtomic(filepath.Join(dataDir, "hardware.json"), b)
	default:
		http.Error(w, "start must be example or blank", 400)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	events.send("changed")
	jsonOut(w, map[string]bool{"ok": true})
}

func seedRev() float64 {
	b, _ := seedFS.ReadFile("seed/example/hardware.json")
	var s struct {
		Rev float64 `json:"rev"`
	}
	json.Unmarshal(b, &s)
	return s.Rev
}

// ------------------------------------------------------------------ sharing

// POST /api/import-item: one profile (with its layout) or one layout,
// photos embedded as data URLs. Adds to what's there; never overwrites.
func handleImportItem(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method", 405)
		return
	}
	v, _, err := readJSON(r, 64<<20)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	kind, _ := v["kind"].(string)
	setup, _ := v["setup"].(map[string]any)
	if (kind != "profile" && kind != "layout") || setup == nil {
		http.Error(w, "This isn't a HiTech Control Map profile or layout file.", 400)
		return
	}
	mu.Lock()
	defer mu.Unlock()

	hwPath := filepath.Join(dataDir, "hardware.json")
	hb, err := os.ReadFile(hwPath)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	var hw map[string]any
	if err := json.Unmarshal(hb, &hw); err != nil {
		http.Error(w, "hardware.json: "+err.Error(), 500)
		return
	}
	setups, _ := hw["setups"].([]any)

	// Reuse an existing layout only when it is the same hardware
	// (same id and it has every control the imported one has).
	setupID, _ := setup["id"].(string)
	if !idRe.MatchString(setupID) {
		setupID = "imported"
	}
	reuse := false
	for _, s := range setups {
		sm, _ := s.(map[string]any)
		if sm["id"] == setupID && kind == "profile" && controlsCovered(sm, setup) {
			reuse = true
		}
	}
	added := false
	if !reuse {
		setupID = uniqueID(setupID, func(id string) bool {
			for _, s := range setups {
				if sm, _ := s.(map[string]any); sm["id"] == id {
					return true
				}
			}
			return false
		})
		setup["id"] = setupID
		photos, _ := v["photos"].(map[string]any)
		devs, _ := setup["devices"].([]any)
		for _, d := range devs {
			dm, _ := d.(map[string]any)
			name, _ := dm["photo"].(string)
			data, _ := photos[name].(string)
			if name == "" || data == "" {
				continue
			}
			saved, err := savePhotoDataURL(name, data)
			if err != nil {
				http.Error(w, "photo "+name+": "+err.Error(), 400)
				return
			}
			dm["photo"] = saved
		}
		hw["setups"] = append(setups, setup)
		out, _ := json.MarshalIndent(hw, "", " ")
		if err := writeAtomic(hwPath, out); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		added = true
	}

	result := map[string]any{"setup": setupID, "addedLayout": added}
	if kind == "profile" {
		p, _ := v["profile"].(map[string]any)
		if p == nil {
			http.Error(w, "profile missing", 400)
			return
		}
		pid, _ := p["id"].(string)
		if !idRe.MatchString(pid) {
			pid = "imported"
		}
		pid = uniqueID(pid, func(id string) bool {
			_, err := os.Stat(filepath.Join(dataDir, "profiles", id+".json"))
			return err == nil
		})
		if pid != p["id"] { // same aircraft already here: keep both, tell them apart
			if name, _ := p["name"].(string); name != "" {
				p["name"] = name + " (imported)"
			}
		}
		p["id"] = pid
		p["setup"] = setupID
		out, _ := json.MarshalIndent(p, "", " ")
		os.MkdirAll(filepath.Join(dataDir, "profiles"), 0o755)
		if err := writeAtomic(filepath.Join(dataDir, "profiles", pid+".json"), out); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		result["profile"] = pid
	}
	events.send("changed")
	jsonOut(w, result)
}

func controlsCovered(have, want map[string]any) bool {
	ids := map[string]bool{}
	collect := func(s map[string]any, fn func(string)) {
		devs, _ := s["devices"].([]any)
		for _, d := range devs {
			dm, _ := d.(map[string]any)
			ctls, _ := dm["controls"].([]any)
			for _, c := range ctls {
				if cm, ok := c.(map[string]any); ok {
					fn(fmt.Sprint(cm["id"]))
				}
			}
		}
	}
	collect(have, func(id string) { ids[id] = true })
	ok := true
	collect(want, func(id string) { ok = ok && ids[id] })
	return ok
}

func uniqueID(base string, taken func(string) bool) string {
	if !taken(base) {
		return base
	}
	for i := 2; ; i++ {
		id := fmt.Sprintf("%s-%d", base, i)
		if len(id) > 64 {
			id = id[len(id)-64:]
		}
		if !taken(id) {
			return id
		}
	}
}

// Save an embedded photo. Same name and same bytes: reuse it.
// Same name, different picture: save under a new name.
func savePhotoDataURL(name, dataURL string) (string, error) {
	i := strings.Index(dataURL, ";base64,")
	if i < 0 {
		return "", fmt.Errorf("not an embedded image")
	}
	b, err := base64.StdEncoding.DecodeString(dataURL[i+8:])
	if err != nil {
		return "", err
	}
	name = strings.ToLower(filepath.Base(name))
	if !photoRe.MatchString(name) {
		name = "imported.png"
	}
	dir := filepath.Join(dataDir, "photos")
	os.MkdirAll(dir, 0o755)
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	for n := 1; ; n++ {
		try := name
		if n > 1 {
			try = fmt.Sprintf("%s-%d%s", stem, n, ext)
		}
		old, err := os.ReadFile(filepath.Join(dir, try))
		if err != nil {
			return try, os.WriteFile(filepath.Join(dir, try), b, 0o644)
		}
		if bytes.Equal(old, b) {
			return try, nil
		}
	}
}

// ------------------------------------------------------------------ edit PIN

type settings struct {
	PinSalt string `json:"pinSalt,omitempty"`
	PinHash string `json:"pinHash,omitempty"`
}

func loadSettings() settings {
	var s settings
	b, _ := os.ReadFile(filepath.Join(dataDir, "settings.json"))
	json.Unmarshal(b, &s)
	return s
}

func hashPin(salt, pin string) string {
	h := sha256.Sum256([]byte(salt + ":" + pin))
	return hex.EncodeToString(h[:])
}

func isLocal(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// Changes from other devices need the PIN when one is set. The PC itself never does.
func requirePin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead && !isLocal(r) {
			s := loadSettings()
			if s.PinHash != "" {
				got := hashPin(s.PinSalt, r.Header.Get("X-Edit-Pin"))
				if subtle.ConstantTimeCompare([]byte(got), []byte(s.PinHash)) != 1 {
					w.Header().Set("Content-Type", "text/plain; charset=utf-8")
					if r.Header.Get("X-Edit-Pin") == "" {
						http.Error(w, "PIN required", http.StatusUnauthorized)
					} else {
						http.Error(w, "Wrong PIN", http.StatusUnauthorized)
					}
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

// GET: {pinSet, local}. PUT {pin}: set or clear (empty) the PIN — from the PC only.
func handleSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		jsonOut(w, map[string]any{"pinSet": loadSettings().PinHash != "", "local": isLocal(r)})
	case http.MethodPut:
		if !isLocal(r) {
			http.Error(w, "The PIN can only be changed on the PC running HiTech Control Map.", 403)
			return
		}
		v, _, err := readJSON(r, 4096)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		pin, _ := v["pin"].(string)
		pin = strings.TrimSpace(pin)
		s := settings{}
		if pin != "" {
			salt := make([]byte, 16)
			rand.Read(salt)
			s.PinSalt = hex.EncodeToString(salt)
			s.PinHash = hashPin(s.PinSalt, pin)
		}
		b, _ := json.MarshalIndent(s, "", " ")
		mu.Lock()
		err = writeAtomic(filepath.Join(dataDir, "settings.json"), b)
		mu.Unlock()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		jsonOut(w, map[string]any{"pinSet": pin != ""})
	default:
		http.Error(w, "method", 405)
	}
}

// ------------------------------------------------------------------ firewall

var listenPort = 8787

// GET: {supported, allowed}. POST: add the rule (Windows asks for permission) — from the PC only.
func handleFirewall(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		jsonOut(w, map[string]any{"supported": firewallSupported, "allowed": firewallAllowed()})
	case http.MethodPost:
		if !isLocal(r) {
			http.Error(w, "Only from the PC.", 403)
			return
		}
		if err := firewallAllow(listenPort); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		jsonOut(w, map[string]any{"allowed": firewallAllowed()})
	default:
		http.Error(w, "method", 405)
	}
}
