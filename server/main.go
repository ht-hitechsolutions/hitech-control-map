// HiTech Control Map — local server.
// Stores hardware layouts and aircraft profiles as JSON next to the .exe,
// serves the editor and the viewer (PC, phone, tablet, VR headset), and pushes live updates (SSE).
package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	appName    = "HiTech Control Map"
	appVersion = "2.7.0"
	dataFolder = "Control Map Data"
)

//go:embed web
var webFS embed.FS

//go:embed seed
var seedFS embed.FS

var (
	dataDir string
	mu      sync.Mutex
	idRe    = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	photoRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(png|jpg|jpeg|webp)$`)
)

// ------------------------------------------------------------------ live events

type hub struct {
	mu   sync.Mutex
	subs map[chan string]bool
}

var events = &hub{subs: map[chan string]bool{}}

func (h *hub) add() chan string {
	c := make(chan string, 8)
	h.mu.Lock()
	h.subs[c] = true
	h.mu.Unlock()
	return c
}
func (h *hub) remove(c chan string) {
	h.mu.Lock()
	delete(h.subs, c)
	h.mu.Unlock()
}
func (h *hub) send(msg string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.subs {
		select {
		case c <- msg:
		default:
		}
	}
}

// ------------------------------------------------------------------ storage

func writeAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Bring an existing hardware.json up to the built-in revision without
// touching anything the user changed: add missing per-control layer lists
// and apply renames only where the old default name is still in place.
func migrateHardware() {
	path := filepath.Join(dataDir, "hardware.json")
	b, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var hw map[string]any
	if json.Unmarshal(b, &hw) != nil {
		return
	}
	seedB, _ := seedFS.ReadFile("seed/example/hardware.json")
	var seed map[string]any
	if json.Unmarshal(seedB, &seed) != nil {
		return
	}
	rev, _ := hw["rev"].(float64)
	seedRev, _ := seed["rev"].(float64)
	if rev >= seedRev {
		return
	}
	seedCtl := map[string]map[string]any{}
	walk := func(doc map[string]any, fn func(key string, c map[string]any)) {
		setups, _ := doc["setups"].([]any)
		for _, s := range setups {
			sm, _ := s.(map[string]any)
			devs, _ := sm["devices"].([]any)
			for _, d := range devs {
				dm, _ := d.(map[string]any)
				ctls, _ := dm["controls"].([]any)
				for _, c := range ctls {
					if cm, ok := c.(map[string]any); ok {
						fn(fmt.Sprint(sm["id"], "/", dm["id"], "/", cm["id"]), cm)
					}
				}
			}
		}
	}
	walk(seed, func(k string, c map[string]any) { seedCtl[k] = c })
	renames := map[string]string{"Center hat": "Castle switch"}
	changed := 0
	walk(hw, func(k string, c map[string]any) {
		sc, ok := seedCtl[k]
		if !ok {
			return
		}
		if rev < 3 { // v1.2: slot grid read from the sheet's green/dark-green cells
			if strings.HasSuffix(k, "/bb-knob-c") && fmt.Sprint(c["slots"]) == "[map[id:ccw] map[id:cw]]" {
				c["slots"] = sc["slots"]
				changed++
			}
			if strings.HasSuffix(k, "/bb-knob-l") && fmt.Sprint(c["layers"]) == "[n]" {
				c["layers"] = sc["layers"]
				changed++
			}
		}
		if rev < 6 { // v1.5: labels above/below the photo where that avoids crossing lines
			moves := map[string][2]string{
				"sensor-hat": {"right", "left"}, "bb-knob-c": {"left", "top"}, "bb-knob-l": {"left", "top"},
				"bb-knob-r": {"right", "top"}, "bb-t1": {"left", "bottom"}, "bb-t2": {"left", "bottom"},
				"bb-t3": {"right", "bottom"}, "bb-t4": {"right", "bottom"}, "gp-view": {"right", "top"},
				"gp-menu": {"right", "top"}, "gp-x": {"right", "top"}, "gp-y": {"right", "top"}, "gp-rs": {"right", "bottom"},
			}
			id, _ := c["id"].(string)
			if mv, ok := moves[id]; ok {
				if lab, _ := c["label"].(map[string]any); lab != nil && lab["side"] == mv[0] {
					lab["side"] = mv[1]
					changed++
				}
			}
		}
		if rev < 5 { // v1.4: photos without red lines; lines drawn straight to the control
			c["line"] = true
			lab, _ := c["label"].(map[string]any)
			if lab == nil {
				lab = map[string]any{"side": "left"}
				c["label"] = lab
			}
			lab["y"] = c["y"]
			changed++
		}
		if rev < 4 && strings.HasSuffix(k, "/bb-red") { // v1.3: red switch is the gear lever
			if c["name"] == "Red rotary" {
				c["name"] = sc["name"]
			}
			if fmt.Sprint(c["slots"]) == "[map[id:cw] map[id:ccw]]" {
				c["slots"] = sc["slots"]
			}
			c["layers"] = sc["layers"]
			changed++
		}
		if _, has := c["layers"]; !has && sc["layers"] != nil {
			c["layers"] = sc["layers"]
			changed++
		}
		if n, _ := c["name"].(string); renames[n] != "" && renames[n] == sc["name"] {
			c["name"] = sc["name"]
			changed++
		}
	})
	if rev < 5 {
		// Add the cleaned photos and point the built-in devices at them,
		// unless the user already replaced that device's photo.
		photos, _ := fs.ReadDir(seedFS, "seed/example/photos")
		for _, ph := range photos {
			dst := filepath.Join(dataDir, "photos", ph.Name())
			if _, err := os.Stat(dst); err != nil {
				if b, err := seedFS.ReadFile("seed/example/photos/" + ph.Name()); err == nil {
					os.WriteFile(dst, b, 0o644)
				}
			}
		}
		setups, _ := hw["setups"].([]any)
		for _, st := range setups {
			sm, _ := st.(map[string]any)
			devs, _ := sm["devices"].([]any)
			for _, d := range devs {
				dm, _ := d.(map[string]any)
				name, _ := dm["photo"].(string)
				clean := strings.TrimSuffix(name, ".png") + "-clean.png"
				if strings.HasSuffix(name, ".png") && !strings.HasSuffix(name, "-clean.png") {
					if _, err := fs.Stat(seedFS, "seed/example/photos/"+clean); err == nil {
						dm["photo"] = clean
						changed++
					}
				}
			}
		}
	}
	// Profile updates, one pass over the files.
	pdir := filepath.Join(dataDir, "profiles")
	entries, _ := os.ReadDir(pdir)
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		pb, err := os.ReadFile(filepath.Join(pdir, e.Name()))
		if err != nil {
			continue
		}
		var p map[string]any
		if json.Unmarshal(pb, &p) != nil {
			continue
		}
		bind, _ := p["bindings"].(map[string]any)
		if bind == nil {
			bind = map[string]any{}
			p["bindings"] = bind
		}
		touched := false
		if knob, _ := bind["bb-knob-c"].(map[string]any); rev < 3 && knob != nil {
			// Centre knob rows were read as (ccw, cw); they are (cw, press, ccw) top to bottom.
			moved := map[string]any{}
			for slot, v := range knob {
				switch slot {
				case "ccw":
					moved["cw"] = v
				case "cw":
					moved["press"] = v
				default:
					if _, taken := moved[slot]; !taken {
						moved[slot] = v
					}
				}
			}
			bind["bb-knob-c"] = moved
			touched = true
		}
		if rev < 4 && p["setup"] == "hotas" {
			// The red switch is the gear lever on every aircraft.
			gear, _ := bind["bb-red"].(map[string]any)
			if gear == nil {
				gear = map[string]any{}
			}
			if v, ok := gear["cw"]; ok {
				gear["up"] = v
				delete(gear, "cw")
			}
			if v, ok := gear["ccw"]; ok {
				gear["down"] = v
				delete(gear, "ccw")
			}
			if gear["up"] == nil {
				gear["up"] = map[string]any{"n": "Gear Up"}
			}
			if gear["down"] == nil {
				gear["down"] = map[string]any{"n": "Gear Down"}
			}
			bind["bb-red"] = gear
			touched = true
		}
		if touched {
			out, _ := json.MarshalIndent(p, "", " ")
			writeAtomic(filepath.Join(pdir, e.Name()), out)
			changed++
		}
	}
	hw["rev"] = seedRev
	out, _ := json.MarshalIndent(hw, "", " ")
	os.WriteFile(path+".before-update", b, 0o644)
	if writeAtomic(path, out) == nil {
		log.Printf("Updated your hardware layout (%d changes; old copy saved as hardware.json.before-update)", changed)
	}
}

func loadState() (map[string]any, error) {
	if needsSetup() {
		return map[string]any{"needsSetup": true, "version": appVersion}, nil
	}
	hw, err := os.ReadFile(filepath.Join(dataDir, "hardware.json"))
	if err != nil {
		return nil, err
	}
	var hardware any
	if err := json.Unmarshal(hw, &hardware); err != nil {
		return nil, fmt.Errorf("hardware.json: %w", err)
	}
	entries, _ := os.ReadDir(filepath.Join(dataDir, "profiles"))
	profiles := []any{}
	names := []string{}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".json") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, n := range names {
		b, err := os.ReadFile(filepath.Join(dataDir, "profiles", n))
		if err != nil {
			continue
		}
		var p any
		if json.Unmarshal(b, &p) == nil {
			profiles = append(profiles, p)
		} else {
			log.Printf("skipping unreadable profile %s", n)
		}
	}
	return map[string]any{"hardware": hardware, "profiles": profiles, "version": appVersion}, nil
}

// ------------------------------------------------------------------ handlers

func jsonOut(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

func readJSON(r *http.Request, max int64) (map[string]any, []byte, error) {
	b, err := io.ReadAll(io.LimitReader(r.Body, max))
	if err != nil {
		return nil, nil, err
	}
	var v map[string]any
	if err := json.Unmarshal(b, &v); err != nil {
		return nil, nil, fmt.Errorf("invalid JSON: %w", err)
	}
	pretty, _ := json.MarshalIndent(v, "", " ")
	return v, pretty, nil
}

func handleState(w http.ResponseWriter, r *http.Request) {
	mu.Lock()
	st, err := loadState()
	mu.Unlock()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	jsonOut(w, st)
}

func handleHardware(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		http.Error(w, "method", 405)
		return
	}
	v, b, err := readJSON(r, 4<<20)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if _, ok := v["setups"].([]any); !ok {
		http.Error(w, "hardware needs a setups list", 400)
		return
	}
	mu.Lock()
	err = writeAtomic(filepath.Join(dataDir, "hardware.json"), b)
	mu.Unlock()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	events.send("changed")
	jsonOut(w, map[string]bool{"ok": true})
}

func handleProfile(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/profiles/")
	if !idRe.MatchString(id) {
		http.Error(w, "bad profile id", 400)
		return
	}
	path := filepath.Join(dataDir, "profiles", id+".json")
	switch r.Method {
	case http.MethodPut:
		v, b, err := readJSON(r, 2<<20)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if v["id"] != id {
			http.Error(w, "id mismatch", 400)
			return
		}
		mu.Lock()
		err = writeAtomic(path, b)
		mu.Unlock()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
	case http.MethodDelete:
		mu.Lock()
		err := os.Remove(path)
		mu.Unlock()
		if err != nil && !os.IsNotExist(err) {
			http.Error(w, err.Error(), 500)
			return
		}
	default:
		http.Error(w, "method", 405)
		return
	}
	events.send("changed")
	jsonOut(w, map[string]bool{"ok": true})
}

func handlePhotoUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method", 405)
		return
	}
	name := r.URL.Query().Get("name")
	name = strings.ToLower(strings.ReplaceAll(name, " ", "-"))
	if !photoRe.MatchString(name) {
		http.Error(w, "photo must be .png, .jpg or .webp with a simple name", 400)
		return
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, 25<<20))
	if err != nil || len(b) == 0 {
		http.Error(w, "empty upload", 400)
		return
	}
	mu.Lock()
	os.MkdirAll(filepath.Join(dataDir, "photos"), 0o755)
	err = os.WriteFile(filepath.Join(dataDir, "photos", name), b, 0o644)
	mu.Unlock()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	events.send("changed")
	jsonOut(w, map[string]string{"name": name})
}

// Replace everything from a backup file made by the editor.
func handleImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method", 405)
		return
	}
	v, _, err := readJSON(r, 16<<20)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	hw, ok1 := v["hardware"].(map[string]any)
	profs, ok2 := v["profiles"].([]any)
	if !ok1 || !ok2 {
		http.Error(w, "This isn't a "+appName+" backup file.", 400)
		return
	}
	mu.Lock()
	defer mu.Unlock()
	b, _ := json.MarshalIndent(hw, "", " ")
	if err := writeAtomic(filepath.Join(dataDir, "hardware.json"), b); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	pdir := filepath.Join(dataDir, "profiles")
	old, _ := os.ReadDir(pdir)
	for _, e := range old {
		if strings.HasSuffix(e.Name(), ".json") {
			os.Rename(filepath.Join(pdir, e.Name()), filepath.Join(pdir, e.Name()+".bak"))
		}
	}
	for _, p := range profs {
		pm, ok := p.(map[string]any)
		id, _ := pm["id"].(string)
		if !ok || !idRe.MatchString(id) {
			continue
		}
		b, _ := json.MarshalIndent(pm, "", " ")
		writeAtomic(filepath.Join(pdir, id+".json"), b)
	}
	events.send("changed")
	jsonOut(w, map[string]bool{"ok": true})
}

// Serve a photo from the data folder. If a built-in photo has gone missing
// from there, put it back from the copy inside the program.
func handlePhoto(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/photos/")
	if !photoRe.MatchString(name) {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(dataDir, "photos", name)
	if _, err := os.Stat(path); err != nil {
		b, err := seedFS.ReadFile("seed/example/photos/" + name)
		if err != nil {
			log.Printf("Photo not found: %s (looked in %s)", name, filepath.Join(dataDir, "photos"))
			http.NotFound(w, r)
			return
		}
		os.MkdirAll(filepath.Dir(path), 0o755)
		if os.WriteFile(path, b, 0o644) == nil {
			log.Printf("Restored missing photo %s", name)
		}
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, path)
}

func handleEvents(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "stream unsupported", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	c := events.add()
	defer events.remove(c)
	fmt.Fprintf(w, "retry: 2000\nevent: hello\ndata: %s\n\n", appVersion)
	fl.Flush()
	tick := time.NewTicker(20 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case m := <-c:
			fmt.Fprintf(w, "event: %s\ndata: %d\n\n", m, time.Now().UnixMilli())
			fl.Flush()
		case <-tick.C:
			fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

func lanURLs(port int) []string {
	out := []string{}
	ifaces, _ := net.Interfaces()
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok || ipn.IP.To4() == nil || ipn.IP.IsLinkLocalUnicast() {
				continue
			}
			out = append(out, fmt.Sprintf("http://%s:%d/", ipn.IP.String(), port))
		}
	}
	return out
}

func noCache(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		h.ServeHTTP(w, r)
	})
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	cmd.Start()
}

// Default data folder next to the program. Folders from the earlier
// "HOTAS Viewer" name are renamed (or used as they are if that fails).
func defaultDataDir() string {
	exe, _ := os.Executable()
	base := filepath.Dir(exe)
	dir := filepath.Join(base, dataFolder)
	if _, err := os.Stat(dir); err == nil {
		return dir
	}
	old := filepath.Join(base, "HOTAS-Data")
	if _, err := os.Stat(old); err == nil {
		if os.Rename(old, dir) == nil {
			log.Printf("Renamed your data folder HOTAS-Data to %q", dataFolder)
			return dir
		}
		return old
	}
	return dir
}

func main() {
	port := flag.Int("port", 8787, "port to listen on")
	dir := flag.String("data", "", "data folder (default: \""+dataFolder+"\" next to the program)")
	noOpen := flag.Bool("no-browser", false, "don't open the editor on start")
	flag.Parse()
	listenPort = *port

	if *dir == "" {
		*dir = defaultDataDir()
	}
	dataDir = *dir
	if err := os.MkdirAll(filepath.Join(dataDir, "photos"), 0o755); err != nil {
		log.Fatalf("could not create the data folder %s: %v", dataDir, err)
	}
	os.MkdirAll(filepath.Join(dataDir, "profiles"), 0o755)
	migrateHardware()

	web, _ := fs.Sub(webFS, "web")
	api := http.NewServeMux()
	api.HandleFunc("/api/state", handleState)
	api.HandleFunc("/api/hardware", handleHardware)
	api.HandleFunc("/api/profiles/", handleProfile)
	api.HandleFunc("/api/photos", handlePhotoUpload)
	api.HandleFunc("/api/import", handleImport)
	api.HandleFunc("/api/import-item", handleImportItem)
	api.HandleFunc("/api/setup", handleSetup)
	api.HandleFunc("/api/settings", handleSettings)
	api.HandleFunc("/api/firewall", handleFirewall)
	api.HandleFunc("/api/events", handleEvents)
	api.HandleFunc("/api/info", func(w http.ResponseWriter, r *http.Request) {
		jsonOut(w, map[string]any{"urls": lanURLs(*port), "version": appVersion, "name": appName, "dataDir": dataDir})
	})
	mux := http.NewServeMux()
	mux.Handle("/api/", requirePin(api))
	mux.HandleFunc("/photos/", handlePhoto)
	mux.Handle("/", noCache(http.FileServer(http.FS(web))))

	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", *port))
	if err != nil {
		log.Fatalf("port %d is busy — is %s already running? Close its window and try again. (%v)", *port, appName, err)
	}
	fmt.Println("============================================================")
	fmt.Println(" "+appName, appVersion, "— developed by HiTech Solutions")
	fmt.Println("============================================================")
	fmt.Printf(" Editor (this PC):  http://localhost:%d/editor.html\n", *port)
	fmt.Printf(" Viewer (this PC):  http://localhost:%d/\n", *port)
	fmt.Println(" On your phone, tablet or VR headset, go to:")
	for _, u := range lanURLs(*port) {
		fmt.Println("    ", u)
	}
	fmt.Println(" Data folder:", dataDir)
	fmt.Println(" Keep this window open while you use it. Close it to stop.")
	fmt.Println("============================================================")
	if !*noOpen {
		go openBrowser(fmt.Sprintf("http://localhost:%d/editor.html", *port))
	}
	log.Fatal(http.Serve(ln, mux))
}
