package main

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixture(t *testing.T) (*hostApp, networkChoice, string) {
	t.Helper()
	dir := t.TempDir()
	c := networkChoice{IP: net.ParseIP("192.168.3.21"), Mask: net.CIDRMask(24, 32), Name: "test"}
	h, e := newHost(c, "clipsync-ab12ef34.local", dir, 4477, 4478)
	if e != nil {
		t.Fatal(e)
	}
	return h, c, dir
}
func ask(t *testing.T, h *hostApp, admin bool, ip, route, method string, body any, cookie string, origin bool) *httptest.ResponseRecorder {
	t.Helper()
	url := "https://192.168.3.21:4477"
	if admin {
		url = "http://localhost:4478"
	}
	raw := ""
	if body != nil {
		b, _ := json.Marshal(body)
		raw = string(b)
	}
	req := httptest.NewRequest(method, url+route, strings.NewReader(raw))
	req.RemoteAddr = net.JoinHostPort(ip, "50133")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if origin {
		req.Header.Set("Origin", url)
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	rr := httptest.NewRecorder()
	h.handle(admin)(rr, req)
	return rr
}
func jsonBody(t *testing.T, r *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var v map[string]any
	if e := json.Unmarshal(r.Body.Bytes(), &v); e != nil {
		t.Fatalf("invalid JSON: %s", e)
	}
	return v
}
func TestAccessApprovalRevocation(t *testing.T) {
	h, _, dir := fixture(t)
	if r := ask(t, h, false, "192.168.4.31", "/api/info", "GET", nil, "", false); r.Code != 403 {
		t.Fatalf("other subnet=%d", r.Code)
	}
	if r := ask(t, h, false, "192.168.3.31", "/api/state", "GET", nil, "", false); r.Code != 401 {
		t.Fatalf("unapproved=%d", r.Code)
	}
	if r := ask(t, h, false, "192.168.3.31", "/api/join", "POST", map[string]string{"name": "iPad"}, "", false); r.Code != 403 {
		t.Fatalf("CSRF=%d", r.Code)
	}
	join := ask(t, h, false, "192.168.3.31", "/api/join", "POST", map[string]string{"name": "iPad"}, "", true)
	if join.Code != 202 {
		t.Fatalf("join=%d: %s", join.Code, join.Body)
	}
	b := jsonBody(t, join)
	id := b["id"].(string)
	secret := b["secret"].(string)
	if len(b["pairCode"].(string)) != 6 {
		t.Fatal("bad pair code")
	}
	if r := ask(t, h, false, "192.168.3.31", "/api/admin", "GET", nil, "", false); r.Code != 403 {
		t.Fatalf("admin exposed=%d", r.Code)
	}
	approve := ask(t, h, true, "127.0.0.1", "/api/admin/approve", "POST", map[string]string{"id": id}, "", true)
	if approve.Code != 200 {
		t.Fatalf("approve=%d %s", approve.Code, approve.Body)
	}
	approved := ask(t, h, false, "192.168.3.31", "/api/join/status", "POST", map[string]string{"id": id, "secret": secret}, "", true)
	if approved.Code != 200 {
		t.Fatalf("status=%d", approved.Code)
	}
	cookies := approved.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].Secure || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatal("unsafe cookie")
	}
	cookie := cookies[0].Name + "=" + cookies[0].Value
	if r := ask(t, h, false, "192.168.3.31", "/api/state", "GET", nil, cookie, false); r.Code != 200 {
		t.Fatalf("authed=%d", r.Code)
	}
	if r := ask(t, h, false, "192.168.3.31", "/api/state", "POST", map[string]any{"text": "共有テキスト", "baseVersion": 0}, cookie, true); r.Code != 200 {
		t.Fatalf("write=%d", r.Code)
	}
	if r := ask(t, h, false, "192.168.3.31", "/api/state", "POST", map[string]any{"text": "bad", "baseVersion": 0}, cookie, true); r.Code != 409 {
		t.Fatalf("conflict=%d", r.Code)
	}
	if r := ask(t, h, false, "192.168.3.31", "/api/clips", "POST", map[string]string{"text": "<script>alert(1)</script>"}, cookie, true); r.Code != 201 {
		t.Fatalf("board=%d", r.Code)
	}
	if r := ask(t, h, false, "192.168.3.31", "/api/ping", "POST", map[string]any{}, cookie, true); r.Code != 200 {
		t.Fatalf("ping=%d", r.Code)
	}
	admin := jsonBody(t, ask(t, h, true, "127.0.0.1", "/api/admin", "GET", nil, "", false))
	devices := admin["devices"].([]any)
	if len(devices) != 1 || !devices[0].(map[string]any)["online"].(bool) {
		t.Fatal("presence not tracked")
	}
	stored, _ := os.ReadFile(filepath.Join(dir, "devices.json"))
	if strings.Contains(string(stored), "共有テキスト") || strings.Contains(string(stored), "<script>") || strings.Contains(string(stored), cookies[0].Value) {
		t.Fatal("plaintext leaked to disk")
	}
	revoke := ask(t, h, true, "127.0.0.1", "/api/admin/revoke", "POST", map[string]string{"id": devices[0].(map[string]any)["id"].(string)}, "", true)
	if revoke.Code != 200 {
		t.Fatalf("revoke=%d", revoke.Code)
	}
	if r := ask(t, h, false, "192.168.3.31", "/api/state", "GET", nil, cookie, false); r.Code != 401 {
		t.Fatalf("revoked=%d", r.Code)
	}
	if r := ask(t, h, false, "192.168.3.31", "/ClipSync-RootCA.cer", "GET", nil, "", false); r.Code != 404 {
		t.Fatalf("CA must not be publicly served=%d", r.Code)
	}
}
func TestCertificateSANTrustAndRotation(t *testing.T) {
	_, c, dir := fixture(t)
	hostname := "clipsync-ab12ef34.local"
	cert, changed, err := ensureCertificates(dir, c, hostname)
	if err != nil || !changed {
		t.Fatalf("certificate: %v %v", changed, err)
	}
	if _, err := tls.X509KeyPair([]byte("bad"), []byte("bad")); err == nil {
		t.Fatal("fixture assumption")
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	if leaf.VerifyHostname(hostname) != nil || leaf.VerifyHostname(c.IP.String()) != nil {
		t.Fatal("certificate SAN mismatch")
	}
	rootBytes, err := os.ReadFile(filepath.Join(dir, "ClipSync-RootCA.cer"))
	if err != nil {
		t.Fatal(err)
	}
	root, err := x509.ParseCertificate(rootBytes)
	if err != nil || !root.IsCA {
		t.Fatal("root certificate invalid")
	}
	roots := x509.NewCertPool()
	roots.AddCert(root)
	_, err = leaf.Verify(x509.VerifyOptions{Roots: roots, DNSName: hostname})
	if err != nil {
		t.Fatal("untrusted leaf:", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "rootCA-key.pem")); !os.IsNotExist(err) {
		t.Fatal("CA private key must not be persisted")
	}
	_, changed, err = ensureCertificates(dir, c, hostname)
	if err != nil || changed {
		t.Fatalf("unnecessary cert rotation changed=%v err=%v", changed, err)
	}
	changedIP := networkChoice{IP: net.ParseIP("192.168.3.30"), Mask: c.Mask}
	_, changed, err = ensureCertificates(dir, changedIP, hostname)
	if err != nil || !changed {
		t.Fatalf("IP rotation must force certificate re-enrollment: %v", err)
	}
}
func TestMDNSPacket(t *testing.T) {
	c := net.ParseIP("192.168.3.21")
	packet := discoveryPacket(c, "clipsync-ab12ef34.local", 4477, 120)
	if len(packet) < 80 || packet[2] != 0x84 || packet[3] != 0 {
		t.Fatal("invalid DNS-SD packet")
	}
	query := make([]byte, 12)
	query[5] = 1
	query = append(query, dnsName(serviceName)...)
	query = append(query, 0, 12, 0, 1)
	if !wantsDiscovery(query, "clipsync-ab12ef34.local") {
		t.Fatal("mDNS service query should match")
	}
	fmt.Println("mDNS packet length:", len(packet))
}
