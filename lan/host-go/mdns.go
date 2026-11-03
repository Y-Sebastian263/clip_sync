package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"
)

const multicastIP = "224.0.0.251"
const multicastPort = 5353
const serviceName = "_clipsync._tcp.local"

func dnsName(s string) []byte {
	b := []byte{}
	for _, x := range strings.Split(s, ".") {
		if len(x) > 63 {
			return nil
		}
		b = append(b, byte(len(x)))
		b = append(b, []byte(x)...)
	}
	return append(b, 0)
}
func dnsRecord(buf *bytes.Buffer, name string, typ uint16, ttl uint32, data []byte, cacheFlush bool) {
	buf.Write(dnsName(name))
	_ = binary.Write(buf, binary.BigEndian, typ)
	class := uint16(1)
	if cacheFlush {
		class |= 0x8000
	}
	_ = binary.Write(buf, binary.BigEndian, class)
	_ = binary.Write(buf, binary.BigEndian, ttl)
	_ = binary.Write(buf, binary.BigEndian, uint16(len(data)))
	buf.Write(data)
}
func discoveryPacket(ip net.IP, host string, port int, ttl uint32) []byte {
	var b bytes.Buffer
	_ = binary.Write(&b, binary.BigEndian, uint16(0))
	_ = binary.Write(&b, binary.BigEndian, uint16(0x8400))
	_ = binary.Write(&b, binary.BigEndian, uint16(0))
	_ = binary.Write(&b, binary.BigEndian, uint16(5))
	_ = binary.Write(&b, binary.BigEndian, uint16(0))
	_ = binary.Write(&b, binary.BigEndian, uint16(0))
	instance := "ClipSync-" + strings.TrimSuffix(strings.TrimPrefix(host, "clipsync-"), ".local") + "." + serviceName
	dnsRecord(&b, "_services._dns-sd._udp.local", 12, ttl, dnsName(serviceName), false)
	dnsRecord(&b, serviceName, 12, ttl, dnsName(instance), false)
	var srv bytes.Buffer
	_ = binary.Write(&srv, binary.BigEndian, uint16(0))
	_ = binary.Write(&srv, binary.BigEndian, uint16(0))
	_ = binary.Write(&srv, binary.BigEndian, uint16(port))
	srv.Write(dnsName(host))
	dnsRecord(&b, instance, 33, ttl, srv.Bytes(), true)
	txt := []byte{6}
	txt = append(txt, []byte("path=/")...)
	txt = append(txt, 5)
	txt = append(txt, []byte("tls=1")...)
	dnsRecord(&b, instance, 16, ttl, txt, true)
	dnsRecord(&b, host, 1, ttl, ip.To4(), true)
	return b.Bytes()
}

// Read compressed DNS names defensively: maximum 25 pointers and label length 63.
func readDNSName(packet []byte, pos int) (string, int, bool) {
	var parts []string
	end := -1
	for i := 0; i < 45; i++ {
		if pos < 0 || pos >= len(packet) {
			return "", 0, false
		}
		n := int(packet[pos])
		if n&0xc0 == 0xc0 {
			if pos+1 >= len(packet) {
				return "", 0, false
			}
			if end < 0 {
				end = pos + 2
			}
			pos = (n&0x3f)<<8 | int(packet[pos+1])
			continue
		}
		if n&0xc0 != 0 {
			return "", 0, false
		}
		pos++
		if n == 0 {
			if end >= 0 {
				return strings.ToLower(strings.Join(parts, ".")), end, true
			}
			return strings.ToLower(strings.Join(parts, ".")), pos, true
		}
		if n > 63 || pos+n > len(packet) {
			return "", 0, false
		}
		parts = append(parts, string(packet[pos:pos+n]))
		pos += n
	}
	return "", 0, false
}
func wantsDiscovery(packet []byte, host string) bool {
	if len(packet) < 12 || len(packet) > 1500 || packet[2]&0x80 != 0 {
		return false
	}
	count := int(binary.BigEndian.Uint16(packet[4:6]))
	if count > 20 {
		return false
	}
	pos := 12
	for i := 0; i < count; i++ {
		name, next, ok := readDNSName(packet, pos)
		if !ok || next+4 > len(packet) {
			return false
		}
		typ := binary.BigEndian.Uint16(packet[next : next+2])
		pos = next + 4
		if name == serviceName || name == host || name == "_services._dns-sd._udp.local" || strings.HasSuffix(name, "."+serviceName) {
			if typ == 1 || typ == 12 || typ == 16 || typ == 33 || typ == 255 {
				return true
			}
		}
	}
	return false
}

type mdnsService struct {
	mu     sync.Mutex
	conn   *net.UDPConn
	sender *net.UDPConn
	stop   chan struct{}
	active bool
}

func startMDNS(choice networkChoice, host string, port int) (*mdnsService, error) {
	ifaces, _ := net.Interfaces()
	var iface *net.Interface
	for i := range ifaces {
		addresses, _ := ifaces[i].Addrs()
		for _, addr := range addresses {
			if ipnet, ok := addr.(*net.IPNet); ok && ipnet.IP.Equal(choice.IP) {
				iface = &ifaces[i]
			}
		}
	}
	if iface == nil {
		return nil, fmt.Errorf("network interface for %s unavailable", choice.IP)
	}
	group := &net.UDPAddr{IP: net.ParseIP(multicastIP), Port: multicastPort}
	conn, err := net.ListenMulticastUDP("udp4", iface, group)
	if err != nil {
		return nil, err
	}
	_ = conn.SetReadBuffer(4096)
	sender, err := net.ListenUDP("udp4", &net.UDPAddr{IP: choice.IP, Port: 0})
	if err != nil {
		conn.Close()
		return nil, err
	}
	m := &mdnsService{conn: conn, sender: sender, stop: make(chan struct{}), active: true}
	announce := discoveryPacket(choice.IP, host, port, 120)
	send := func(payload []byte, target *net.UDPAddr) {
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.active {
			_, _ = m.sender.WriteToUDP(payload, target)
		}
	}
	multicast := &net.UDPAddr{IP: net.ParseIP(multicastIP), Port: multicastPort}
	send(announce, multicast)
	go func() {
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				send(announce, multicast)
			case <-m.stop:
				return
			}
		}
	}()
	go func() {
		b := make([]byte, 1600)
		last := time.Time{}
		for {
			_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
			n, addr, err := conn.ReadFromUDP(b)
			if err != nil {
				select {
				case <-m.stop:
					return
				default:
					continue
				}
			}
			if !sameSubnet(addr.IP.String(), choice) || !wantsDiscovery(b[:n], host) || time.Since(last) < 500*time.Millisecond {
				continue
			}
			last = time.Now()
			if addr.Port >= 1024 && addr.Port != multicastPort {
				send(announce, addr)
			} else {
				send(announce, multicast)
			}
		}
	}()
	return m, nil
}
func (m *mdnsService) Close(choice networkChoice, host string, port int) {
	m.mu.Lock()
	if !m.active {
		m.mu.Unlock()
		return
	}
	m.active = false
	close(m.stop)
	_, _ = m.sender.WriteToUDP(discoveryPacket(choice.IP, host, port, 0), &net.UDPAddr{IP: net.ParseIP(multicastIP), Port: multicastPort})
	m.mu.Unlock()
	m.conn.Close()
	m.sender.Close()
}
