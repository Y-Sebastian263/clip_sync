package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func privateLAN(ip net.IP) bool {
	v := ip.To4()
	if v == nil {
		return false
	}
	return v[0] == 10 || (v[0] == 172 && v[1] >= 16 && v[1] <= 31) || (v[0] == 192 && v[1] == 168)
}

type networkChoice struct {
	IP   net.IP
	Mask net.IPMask
	Name string
}

func networkChoices() []networkChoice {
	var out []networkChoice
	ifaces, _ := net.Interfaces()
	seen := make(map[string]bool)
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, addr := range addrs {
			n, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			ip := n.IP.To4()
			if ip == nil || !privateLAN(ip) || seen[ip.String()] {
				continue
			}
			seen[ip.String()] = true
			out = append(out, networkChoice{IP: ip, Mask: n.Mask, Name: iface.Name})
		}
	}
	return out
}
func findNetwork(ip string) (networkChoice, error) {
	for _, choice := range networkChoices() {
		if choice.IP.String() == ip {
			return choice, nil
		}
	}
	return networkChoice{}, fmt.Errorf("指定されたIPv4アドレス %q がこのPCのプライベートLANに見つかりません", ip)
}
func sameSubnet(remote string, choice networkChoice) bool {
	ip := net.ParseIP(remote)
	if ip == nil || ip.To4() == nil {
		return false
	}
	return ip.Mask(choice.Mask).Equal(choice.IP.Mask(choice.Mask))
}
func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func randomToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func ensureDiscoveryName(dir string) (string, error) {
	file := filepath.Join(dir, "discovery-name.txt")
	if b, err := os.ReadFile(file); err == nil {
		name := strings.TrimSpace(string(b))
		if len(name) == 23 && strings.HasPrefix(name, "clipsync-") && strings.HasSuffix(name, ".local") && isHex8(name[9:17]) {
			return name, nil
		}
		return "", errors.New("保存されたmDNSホスト名が無効です")
	}
	name := "clipsync-" + randomToken(4) + ".local"
	if err := os.WriteFile(file, []byte(name+"\n"), 0600); err != nil {
		return "", err
	}
	return name, nil
}

// generateCertificates creates a dedicated per-host local CA in memory and signs one server
// certificate. The CA signing PRIVATE key is never written to disk. Clients must trust
// the public CA certificate explicitly. If IP changes or certificate expires, re-enroll.
func ensureCertificates(dir string, choice networkChoice, hostname string) (tls.Certificate, bool, error) {
	certPath := filepath.Join(dir, "server.crt")
	keyPath := filepath.Join(dir, "server.key")
	caPath := filepath.Join(dir, "ClipSync-RootCA.cer")
	if cert, err := tls.LoadX509KeyPair(certPath, keyPath); err == nil {
		if len(cert.Certificate) > 0 {
			if _, e := os.Stat(caPath); e != nil {
				goto issueNew
			}
			if leaf, err := x509.ParseCertificate(cert.Certificate[0]); err == nil && time.Now().Before(leaf.NotAfter.Add(-24*time.Hour)) && time.Now().After(leaf.NotBefore) {
				goodIP := false
				for _, v := range leaf.IPAddresses {
					if v.Equal(choice.IP) {
						goodIP = true
					}
				}
				goodName := false
				for _, v := range leaf.DNSNames {
					if v == hostname {
						goodName = true
					}
				}
				if goodIP && goodName {
					return cert, false, nil
				}
			}
		}
	}
issueNew:
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, false, err
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, false, err
	}
	serial := func() *big.Int {
		n, e := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
		if e != nil {
			panic(e)
		}
		return n
	}
	now := time.Now()
	caTemplate := &x509.Certificate{SerialNumber: serial(), Subject: pkix.Name{CommonName: "ClipSync Local Root (" + hostname + ")"}, NotBefore: now.Add(-time.Hour), NotAfter: now.AddDate(3, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, BasicConstraintsValid: true, IsCA: true, MaxPathLenZero: true}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		return tls.Certificate{}, false, err
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		return tls.Certificate{}, false, err
	}
	leafTemplate := &x509.Certificate{SerialNumber: serial(), Subject: pkix.Name{CommonName: hostname}, NotBefore: now.Add(-time.Hour), NotAfter: now.AddDate(1, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, DNSNames: []string{hostname, "localhost"}, IPAddresses: []net.IP{choice.IP, net.ParseIP("127.0.0.1")}, BasicConstraintsValid: true}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTemplate, caCert, &leafKey.PublicKey, caKey)
	if err != nil {
		return tls.Certificate{}, false, err
	}
	keyDER, err := x509.MarshalECPrivateKey(leafKey)
	if err != nil {
		return tls.Certificate{}, false, err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER})
	certPEM = append(certPEM, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})...)
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	// Creation errors fail closed: never start an insecure HTTP LAN server.
	if err = os.WriteFile(keyPath, keyPEM, 0600); err != nil {
		return tls.Certificate{}, false, err
	}
	if err = os.WriteFile(certPath, certPEM, 0600); err != nil {
		return tls.Certificate{}, false, err
	}
	if err = os.WriteFile(caPath, caDER, 0644); err != nil {
		return tls.Certificate{}, false, err
	}
	// CA signing key was not saved. Rotating LAN IP or cert requires new trust enrollment.
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	return cert, true, err
}

func isHex8(v string) bool {
	if len(v) != 8 {
		return false
	}
	for _, c := range v {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
