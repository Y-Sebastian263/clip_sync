package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

//go:embed public/*
var publicAssets embed.FS

const cookieName = "__Host-clipsync_session"
const maxTextBytes = 16 * 1024
const maxBodyBytes = 20 * 1024
const sessionTTL = 180 * 24 * time.Hour
const pendingTTL = 5 * time.Minute
const maxDevices = 32
const maxStreams = 40

type clip struct {
	ID        string `json:"id"`
	Text      string `json:"text"`
	CreatedAt int64  `json:"createdAt"`
}
type boardState struct {
	Text             string `json:"text"`
	Version          int64  `json:"version"`
	TextVersion      int64  `json:"textVersion"`
	Clips            []clip `json:"clips"`
	ConnectedDevices int    `json:"connectedDevices"`
}
type device struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	TokenHash  string `json:"tokenHash"`
	CreatedAt  int64  `json:"createdAt"`
	LastSeenAt int64  `json:"-"`
}
type deviceFile struct {
	Schema  int       `json:"schema"`
	Devices []*device `json:"devices"`
}
type pendingJoin struct {
	ID, Secret, PairCode, Name, IP, DeviceID, Token string
	CreatedAt                                       time.Time
	Approved, Rejected                              bool
}
type stream struct {
	Updates chan []byte
	Stop    chan struct{}
	ID      string
}
type hostApp struct {
	mu           sync.Mutex
	choice       networkChoice
	hostname     string
	dataDir      string
	lanPort      int
	localPort    int
	started      time.Time
	mdnsActive   bool
	state        boardState
	devices      []*device
	pending      map[string]*pendingJoin
	streams      map[*stream]struct{}
	requestTimes map[string][]time.Time
	writeTimes   map[string][]time.Time
}

func newHost(choice networkChoice, hostname, dataDir string, lanPort, localPort int) (*hostApp, error) {
	h := &hostApp{choice: choice, hostname: hostname, dataDir: dataDir, lanPort: lanPort, localPort: localPort, started: time.Now(), pending: map[string]*pendingJoin{}, streams: map[*stream]struct{}{}, requestTimes: map[string][]time.Time{}, writeTimes: map[string][]time.Time{}, state: boardState{Clips: []clip{}}}
	data, err := os.ReadFile(filepath.Join(dataDir, "devices.json"))
	if err == nil {
		var f deviceFile
		if err := json.Unmarshal(data, &f); err != nil || f.Schema != 1 || len(f.Devices) > maxDevices {
			return nil, errors.New("端末登録ファイルの形式が不正です")
		}
		for _, d := range f.Devices {
			if d == nil || !validID(d.ID) || len(d.Name) > 128 || len(d.TokenHash) != 64 {
				return nil, errors.New("端末登録ファイルの内容が不正です")
			}
		}
		h.devices = f.Devices
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	return h, nil
}
func validID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
		} else if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
func tokenHash(s string) string { x := sha256.Sum256([]byte(s)); return hex.EncodeToString(x[:]) }
func hmacEqual(hexA, hexB string) bool {
	a, e1 := hex.DecodeString(hexA)
	b, e2 := hex.DecodeString(hexB)
	return e1 == nil && e2 == nil && len(a) == 32 && len(b) == 32 && subtle.ConstantTimeCompare(a, b) == 1
}
func nowMS() int64 { return time.Now().UnixMilli() }
func (h *hostApp) saveDevicesLocked() error {
	file := filepath.Join(h.dataDir, "devices.json")
	data, err := json.MarshalIndent(deviceFile{Schema: 1, Devices: h.devices}, "", "  ")
	if err != nil {
		return err
	}
	tmp := file + "." + randomToken(6) + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	if err := os.Rename(tmp, file); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
func (h *hostApp) stateLocked() boardState {
	s := h.state
	s.Clips = append([]clip{}, h.state.Clips...)
	s.ConnectedDevices = len(h.devices)
	return s
}
func (h *hostApp) notifyLocked() {
	payload, _ := json.Marshal(h.stateLocked())
	event := append(append([]byte("event: state\ndata: "), payload...), []byte("\n\n")...)
	for s := range h.streams {
		select {
		case s.Updates <- event:
		default: // latest state wins; avoid blocking on slow consumers
			select {
			case <-s.Updates:
			default:
			}
			select {
			case s.Updates <- event:
			default:
			}
		}
	}
}
func (h *hostApp) authLocked(r *http.Request, admin bool) *device {
	if admin {
		return &device{ID: "local-host", Name: "ホスト"}
	}
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		return nil
	}
	fields := strings.Split(cookie.Value, ".")
	if len(fields) != 2 || !validID(fields[0]) || len(fields[1]) != 64 {
		return nil
	}
	hashed := tokenHash(fields[1])
	for _, d := range h.devices {
		if d.ID == fields[0] && nowMS()-d.CreatedAt < int64(sessionTTL/time.Millisecond) && hmacEqual(d.TokenHash, hashed) {
			return d
		}
	}
	return nil
}
func (h *hostApp) seenLocked(d *device) {
	if d != nil && d.ID != "local-host" {
		d.LastSeenAt = nowMS()
	}
}
func (h *hostApp) sweepLocked() {
	now := time.Now()
	for id, p := range h.pending {
		if now.Sub(p.CreatedAt) > pendingTTL {
			delete(h.pending, id)
		}
	}
	for key, times := range h.writeTimes {
		kept := times[:0]
		for _, t := range times {
			if now.Sub(t) < 10*time.Second {
				kept = append(kept, t)
			}
		}
		if len(kept) == 0 {
			delete(h.writeTimes, key)
		} else {
			h.writeTimes[key] = kept
		}
	}
	for key, times := range h.requestTimes {
		kept := times[:0]
		for _, t := range times {
			if now.Sub(t) < time.Minute {
				kept = append(kept, t)
			}
		}
		if len(kept) == 0 {
			delete(h.requestTimes, key)
		} else {
			h.requestTimes[key] = kept
		}
	}
}
func (h *hostApp) rateOKLocked(key string, join bool) bool {
	now := time.Now()
	m := h.writeTimes
	window := 10 * time.Second
	limit := 45
	if join {
		m = h.requestTimes
		window = time.Minute
		limit = 4
	}
	times := m[key]
	valid := make([]time.Time, 0, len(times)+1)
	for _, t := range times {
		if now.Sub(t) < window {
			valid = append(valid, t)
		}
	}
	if len(valid) >= limit {
		m[key] = valid
		return false
	}
	m[key] = append(valid, now)
	return true
}
func securityHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	h.Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
}
func sendJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func sendError(w http.ResponseWriter, status int, message string) {
	sendJSON(w, status, map[string]string{"error": message})
}
func readJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	if strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0])) != "application/json" {
		sendError(w, 415, "JSON形式で送信してください")
		return false
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		sendError(w, 413, "送信サイズが大きすぎます")
		return false
	}
	if err := json.Unmarshal(data, dst); err != nil {
		sendError(w, 400, "不正なJSONです")
		return false
	}
	return true
}
func validText(s string) bool { return utf8.ValidString(s) && len(s) <= maxTextBytes }
func validDeviceName(name string) bool {
	if name == "" || utf8.RuneCountInString(name) > 32 {
		return false
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}
func (h *hostApp) handle(admin bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		securityHeaders(w)
		if !admin {
			w.Header().Set("Strict-Transport-Security", "max-age=3600")
		}
		remote, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			sendError(w, 403, "不正な接続元")
			return
		}
		if admin {
			ip := net.ParseIP(remote)
			if ip == nil || !ip.IsLoopback() {
				sendError(w, 403, "管理画面はホストPCからのみ利用できます")
				return
			}
		} else if !sameSubnet(remote, h.choice) {
			sendError(w, 403, "同一LAN内のみ接続できます")
			return
		}
		origin := "https://" + r.Host
		if admin {
			if r.Host != fmt.Sprintf("localhost:%d", h.localPort) && r.Host != fmt.Sprintf("127.0.0.1:%d", h.localPort) {
				sendError(w, 403, "不正なホスト名です")
				return
			}
			origin = "http://" + r.Host
		} else {
			hostOK := r.Host == fmt.Sprintf("%s:%d", h.choice.IP.String(), h.lanPort) || r.Host == fmt.Sprintf("%s:%d", h.hostname, h.lanPort)
			if !hostOK {
				sendError(w, 403, "不正なホスト名です")
				return
			}
		}
		if r.Method != "GET" && r.Method != "HEAD" && r.Method != "POST" && r.Method != "DELETE" {
			sendError(w, 405, "許可されていないメソッドです")
			return
		}
		if r.Method == "POST" || r.Method == "DELETE" {
			if r.Header.Get("Origin") != origin {
				sendError(w, 403, "クロスサイト操作を拒否しました")
				return
			}
		}
		p := r.URL.Path
		switch {
		case p == "/api/info" && r.Method == "GET":
			h.mu.Lock()
			d := h.authLocked(r, admin)
			active := h.mdnsActive
			h.mu.Unlock()
			sendJSON(w, 200, map[string]any{"authorized": d != nil, "host": admin, "joinEnabled": true, "hostUrl": fmt.Sprintf("https://%s:%d/", h.choice.IP, h.lanPort), "discoveryUrl": fmt.Sprintf("https://%s:%d/", h.hostname, h.lanPort), "mdnsActive": active, "uptimeSec": int(time.Since(h.started).Seconds())})
			return
		case p == "/api/state" && r.Method == "GET":
			h.mu.Lock()
			d := h.authLocked(r, admin)
			if d == nil {
				h.mu.Unlock()
				sendError(w, 401, "端末承認が必要です")
				return
			}
			h.seenLocked(d)
			v := h.stateLocked()
			h.mu.Unlock()
			sendJSON(w, 200, v)
			return
		case p == "/api/events" && r.Method == "GET":
			h.events(w, r, admin)
			return
		case p == "/api/ping" && r.Method == "POST":
			var body struct{}
			if !readJSON(w, r, &body) {
				return
			}
			h.mu.Lock()
			d := h.authLocked(r, admin)
			if d != nil {
				h.seenLocked(d)
			}
			h.mu.Unlock()
			if d == nil {
				sendError(w, 401, "端末承認が必要です")
			} else {
				sendJSON(w, 200, map[string]bool{"ok": true})
			}
			return
		case p == "/api/state" && r.Method == "POST":
			var body struct {
				Text        string `json:"text"`
				BaseVersion int64  `json:"baseVersion"`
			}
			if !readJSON(w, r, &body) {
				return
			}
			if !validText(body.Text) {
				sendError(w, 400, "本文は16 KiB以内にしてください")
				return
			}
			h.mu.Lock()
			d := h.authLocked(r, admin)
			if d == nil {
				h.mu.Unlock()
				sendError(w, 401, "端末承認が必要です")
				return
			}
			if !h.rateOKLocked(d.ID, false) {
				h.mu.Unlock()
				sendError(w, 429, "操作が多すぎます")
				return
			}
			if body.BaseVersion != h.state.TextVersion {
				v := h.stateLocked()
				h.mu.Unlock()
				sendJSON(w, 409, map[string]any{"error": "別の端末が更新しました", "state": v})
				return
			}
			h.seenLocked(d)
			h.state.Text = body.Text
			h.state.TextVersion++
			h.state.Version++
			h.notifyLocked()
			v := h.stateLocked()
			h.mu.Unlock()
			sendJSON(w, 200, v)
			return
		case p == "/api/clips" && r.Method == "POST":
			var body struct {
				Text string `json:"text"`
			}
			if !readJSON(w, r, &body) {
				return
			}
			if !validText(body.Text) || strings.TrimSpace(body.Text) == "" {
				sendError(w, 400, "有効な本文を入力してください（16 KiB以内）")
				return
			}
			h.mu.Lock()
			d := h.authLocked(r, admin)
			if d == nil {
				h.mu.Unlock()
				sendError(w, 401, "端末承認が必要です")
				return
			}
			if !h.rateOKLocked(d.ID, false) {
				h.mu.Unlock()
				sendError(w, 429, "操作が多すぎます")
				return
			}
			if len(h.state.Clips) >= 50 {
				h.mu.Unlock()
				sendError(w, 409, "掲示板は最大50件です。不要な投稿を削除してください")
				return
			}
			h.seenLocked(d)
			h.state.Clips = append([]clip{{ID: newID(), Text: body.Text, CreatedAt: nowMS()}}, h.state.Clips...)
			h.state.Version++
			h.notifyLocked()
			v := h.stateLocked()
			h.mu.Unlock()
			sendJSON(w, 201, v)
			return
		case strings.HasPrefix(p, "/api/clips/") && r.Method == "DELETE":
			id := strings.TrimPrefix(p, "/api/clips/")
			if !validID(id) {
				sendError(w, 400, "投稿IDが不正です")
				return
			}
			h.mu.Lock()
			d := h.authLocked(r, admin)
			if d == nil {
				h.mu.Unlock()
				sendError(w, 401, "端末承認が必要です")
				return
			}
			if !h.rateOKLocked(d.ID, false) {
				h.mu.Unlock()
				sendError(w, 429, "操作が多すぎます")
				return
			}
			i := -1
			for j, c := range h.state.Clips {
				if c.ID == id {
					i = j
					break
				}
			}
			if i < 0 {
				h.mu.Unlock()
				sendError(w, 404, "投稿が見つかりません")
				return
			}
			h.state.Clips = append(h.state.Clips[:i], h.state.Clips[i+1:]...)
			h.state.Version++
			h.seenLocked(d)
			h.notifyLocked()
			v := h.stateLocked()
			h.mu.Unlock()
			sendJSON(w, 200, v)
			return
		case p == "/api/join" && r.Method == "POST":
			var body struct {
				Name string `json:"name"`
			}
			if !readJSON(w, r, &body) {
				return
			}
			name := strings.TrimSpace(body.Name)
			if !validDeviceName(name) {
				sendError(w, 400, "端末名は1〜32文字にしてください")
				return
			}
			h.mu.Lock()
			h.sweepLocked()
			if h.authLocked(r, admin) != nil {
				h.mu.Unlock()
				sendError(w, 409, "すでに参加しています")
				return
			}
			if !h.rateOKLocked(remote, true) {
				h.mu.Unlock()
				sendError(w, 429, "申請が多すぎます")
				return
			}
			if len(h.pending) >= 20 {
				h.mu.Unlock()
				sendError(w, 503, "承認待ちが多すぎます")
				return
			}
			num, _ := randInt(900000)
			pair := fmt.Sprintf("%06d", num+100000)
			item := &pendingJoin{ID: randomToken(18), Secret: randomToken(32), PairCode: pair, Name: name, IP: remote, CreatedAt: time.Now()}
			h.pending[item.ID] = item
			h.mu.Unlock()
			sendJSON(w, 202, map[string]any{"id": item.ID, "secret": item.Secret, "pairCode": item.PairCode, "expiresIn": 300})
			return
		case p == "/api/join/status" && r.Method == "POST":
			var body struct {
				ID     string `json:"id"`
				Secret string `json:"secret"`
			}
			if !readJSON(w, r, &body) {
				return
			}
			h.mu.Lock()
			item := h.pending[body.ID]
			if item == nil || len(body.Secret) != 64 || subtle.ConstantTimeCompare([]byte(item.Secret), []byte(body.Secret)) != 1 || item.IP != remote {
				h.mu.Unlock()
				sendError(w, 404, "申請が見つかりません")
				return
			}
			if time.Since(item.CreatedAt) > pendingTTL {
				delete(h.pending, item.ID)
				h.mu.Unlock()
				sendError(w, 410, "申請期限が切れました")
				return
			}
			if item.Rejected {
				delete(h.pending, item.ID)
				h.mu.Unlock()
				sendError(w, 403, "ホストが接続を拒否しました")
				return
			}
			if !item.Approved {
				h.mu.Unlock()
				sendJSON(w, 200, map[string]string{"status": "pending"})
				return
			}
			delete(h.pending, item.ID)
			value := item.DeviceID + "." + item.Token
			h.mu.Unlock()
			http.SetCookie(w, &http.Cookie{Name: cookieName, Value: value, Path: "/", MaxAge: int(sessionTTL.Seconds()), Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode})
			sendJSON(w, 200, map[string]string{"status": "approved"})
			return
		case strings.HasPrefix(p, "/api/admin"):
			if !admin {
				sendError(w, 403, "管理画面はホストPCでのみ操作できます")
				return
			}
			h.admin(w, r)
			return
		case r.Method == "GET" || r.Method == "HEAD":
			assets := map[string]string{"/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/styles.css": "styles.css"}
			if p == "/ClipSync-RootCA.cer" && admin {
				b, err := os.ReadFile(filepath.Join(h.dataDir, "ClipSync-RootCA.cer"))
				if err != nil {
					sendError(w, 404, "証明書がありません")
					return
				}
				w.Header().Set("Content-Type", "application/pkix-cert")
				w.Header().Set("Content-Disposition", "attachment; filename=ClipSync-RootCA.cer")
				w.Header().Set("Content-Length", fmt.Sprint(len(b)))
				if r.Method == "GET" {
					_, _ = w.Write(b)
				}
				return
			}
			file, ok := assets[p]
			if !ok {
				sendError(w, 404, "ページが見つかりません")
				return
			}
			b, err := publicAssets.ReadFile(path.Join("public", file))
			if err != nil {
				sendError(w, 500, "静的ファイルを読み込めません")
				return
			}
			typ := map[string]string{"index.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8", "styles.css": "text/css; charset=utf-8"}
			w.Header().Set("Content-Type", typ[file])
			w.Header().Set("Content-Length", fmt.Sprint(len(b)))
			if r.Method == "GET" {
				_, _ = w.Write(b)
			}
			return
		default:
			sendError(w, 404, "ページが見つかりません")
			return
		}
	}
}
func randInt(n int64) (int64, error) {
	v, e := rand.Int(rand.Reader, big.NewInt(n))
	if e != nil {
		return 0, e
	}
	return v.Int64(), nil
}
func (h *hostApp) admin(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	switch {
	case p == "/api/admin" && r.Method == "GET":
		h.mu.Lock()
		h.sweepLocked()
		pending := []map[string]any{}
		for _, x := range h.pending {
			if !x.Approved && !x.Rejected {
				pending = append(pending, map[string]any{"id": x.ID, "name": x.Name, "pairCode": x.PairCode, "createdAt": x.CreatedAt.UnixMilli()})
			}
		}
		devices := []map[string]any{}
		for _, x := range h.devices {
			devices = append(devices, map[string]any{"id": x.ID, "name": x.Name, "createdAt": x.CreatedAt, "online": x.LastSeenAt > 0 && nowMS()-x.LastSeenAt < 45000, "lastSeenAt": x.LastSeenAt})
		}
		h.mu.Unlock()
		sendJSON(w, 200, map[string]any{"pending": pending, "devices": devices})
		return
	case p == "/api/admin/approve" && r.Method == "POST":
		var body struct {
			ID string `json:"id"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		h.mu.Lock()
		x := h.pending[body.ID]
		if x == nil || x.Rejected || x.Approved || time.Since(x.CreatedAt) > pendingTTL {
			h.mu.Unlock()
			sendError(w, 404, "承認申請が見つかりません")
			return
		}
		if len(h.devices) >= maxDevices {
			h.mu.Unlock()
			sendError(w, 409, "登録端末が上限に達しました")
			return
		}
		token := randomToken(32)
		id := newID()
		device := &device{ID: id, Name: x.Name, TokenHash: tokenHash(token), CreatedAt: nowMS()}
		h.devices = append(h.devices, device)
		if err := h.saveDevicesLocked(); err != nil {
			h.devices = h.devices[:len(h.devices)-1]
			h.mu.Unlock()
			log.Println("Unable to store device token hash:", err)
			sendError(w, 500, "端末登録を保存できません")
			return
		}
		x.Approved = true
		x.DeviceID = id
		x.Token = token
		h.mu.Unlock()
		sendJSON(w, 200, map[string]string{"status": "approved"})
		return
	case p == "/api/admin/reject" && r.Method == "POST":
		var body struct {
			ID string `json:"id"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		h.mu.Lock()
		x := h.pending[body.ID]
		if x == nil {
			h.mu.Unlock()
			sendError(w, 404, "承認申請が見つかりません")
			return
		}
		x.Rejected = true
		h.mu.Unlock()
		sendJSON(w, 200, map[string]string{"status": "rejected"})
		return
	case p == "/api/admin/revoke" && r.Method == "POST":
		var body struct {
			ID string `json:"id"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		h.mu.Lock()
		idx := -1
		for i, x := range h.devices {
			if x.ID == body.ID {
				idx = i
				break
			}
		}
		if idx < 0 {
			h.mu.Unlock()
			sendError(w, 404, "端末が見つかりません")
			return
		}
		old := h.devices
		h.devices = append(append([]*device{}, old[:idx]...), old[idx+1:]...)
		if err := h.saveDevicesLocked(); err != nil {
			h.devices = old
			h.mu.Unlock()
			sendError(w, 500, "登録解除を保存できません")
			return
		}
		for s := range h.streams {
			if s.ID == body.ID {
				close(s.Stop)
				delete(h.streams, s)
			}
		}
		h.notifyLocked()
		h.mu.Unlock()
		sendJSON(w, 200, map[string]string{"status": "revoked"})
		return
	default:
		sendError(w, 404, "管理用APIが見つかりません")
		return
	}
}
func (h *hostApp) events(w http.ResponseWriter, r *http.Request, admin bool) {
	f, ok := w.(http.Flusher)
	if !ok {
		sendError(w, 500, "リアルタイム通信を利用できません")
		return
	}
	h.mu.Lock()
	d := h.authLocked(r, admin)
	if d == nil {
		h.mu.Unlock()
		sendError(w, 401, "端末承認が必要です")
		return
	}
	if len(h.streams) >= maxStreams {
		h.mu.Unlock()
		sendError(w, 503, "接続上限です")
		return
	}
	h.seenLocked(d)
	s := &stream{Updates: make(chan []byte, 1), Stop: make(chan struct{}), ID: d.ID}
	h.streams[s] = struct{}{}
	initial, _ := json.Marshal(h.stateLocked())
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		if _, ok := h.streams[s]; ok {
			delete(h.streams, s)
		}
		h.mu.Unlock()
	}()
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(200)
	_, _ = fmt.Fprintf(w, "event: state\ndata: %s\n\n", initial)
	f.Flush()
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.Stop:
			return
		case event := <-s.Updates:
			if _, err := w.Write(event); err != nil {
				return
			}
			f.Flush()
		case <-ticker.C:
			if _, err := io.WriteString(w, ": keep-alive\n\n"); err != nil {
				return
			}
			f.Flush()
		}
	}
}
