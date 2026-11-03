package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func defaultDataDir() string {
	if runtime.GOOS == "windows" {
		if x := os.Getenv("LOCALAPPDATA"); x != "" {
			return filepath.Join(x, "ClipSyncHost")
		}
	}
	x, err := os.UserConfigDir()
	if err != nil {
		return "ClipSyncHost"
	}
	return filepath.Join(x, "ClipSyncHost")
}
func openBrowser(url string) {
	if runtime.GOOS == "windows" {
		_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	}
}
func run() error {
	ipArg := flag.String("ip", "", "ホストに使用するプライベートIPv4アドレス（省略時は自動選択）")
	port := flag.Int("port", 4477, "LAN側のHTTPSポート")
	localPort := flag.Int("admin-port", 4478, "ホストPCだけで使用するlocalhost管理ポート")
	dataArg := flag.String("data-dir", defaultDataDir(), "設定と証明書の保存場所")
	noBrowser := flag.Bool("no-browser", false, "自動で管理画面を開かない")
	noMDNS := flag.Bool("no-mdns", false, "mDNSによるホスト発見通知を無効化")
	flag.Parse()
	if *port < 1024 || *port > 65535 || *localPort < 1024 || *localPort > 65535 || *port == *localPort {
		return fmt.Errorf("利用できるポート番号を指定してください（1024〜65535）")
	}
	choices := networkChoices()
	if len(choices) == 0 {
		return fmt.Errorf("利用可能なプライベートLANがありません。Wi-Fi/LAN接続を確認してください")
	}
	selected := *ipArg
	if selected == "" {
		if len(choices) == 1 {
			selected = choices[0].IP.String()
		} else {
			fmt.Println("複数のネットワークがあります。ClipSyncを共有するLANを選んでください:")
			for i, c := range choices {
				fmt.Printf("  %d. %s (%s)\n", i+1, c.IP, c.Name)
			}
			fmt.Print("番号 > ")
			var input string
			if _, err := fmt.Scanln(&input); err != nil {
				return fmt.Errorf("--ip オプションでLANを指定してください: %w", err)
			}
			n, err := strconv.Atoi(strings.TrimSpace(input))
			if err != nil || n < 1 || n > len(choices) {
				return fmt.Errorf("正しい番号を選んでください")
			}
			selected = choices[n-1].IP.String()
		}
	}
	choice, err := findNetwork(selected)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(*dataArg, 0700); err != nil {
		return err
	}
	hostname, err := ensureDiscoveryName(*dataArg)
	if err != nil {
		return err
	}
	cert, changed, err := ensureCertificates(*dataArg, choice, hostname)
	if err != nil {
		return fmt.Errorf("HTTPS証明書の準備に失敗しました: %w", err)
	}
	app, err := newHost(choice, hostname, *dataArg, *port, *localPort)
	if err != nil {
		return err
	}
	lanListener, err := net.Listen("tcp4", net.JoinHostPort(choice.IP.String(), strconv.Itoa(*port)))
	if err != nil {
		return fmt.Errorf("LAN側ポートを起動できません: %w", err)
	}
	adminListener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(*localPort)))
	if err != nil {
		lanListener.Close()
		return fmt.Errorf("管理画面ポートを起動できません: %w", err)
	}
	serverLAN := &http.Server{Handler: app.handle(false), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 45 * time.Second, MaxHeaderBytes: 16 * 1024}
	serverAdmin := &http.Server{Handler: app.handle(true), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 45 * time.Second, MaxHeaderBytes: 16 * 1024}
	tlsListener := tls.NewListener(lanListener, &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{cert}})
	var mdns *mdnsService
	if !*noMDNS {
		mdns, err = startMDNS(choice, hostname, *port)
		if err != nil {
			log.Printf("mDNSを開始できませんでした: %v (IPアドレスで接続できます)", err)
		} else {
			app.mdnsActive = true
		}
	}
	errorCh := make(chan error, 2)
	go func() { errorCh <- serverLAN.Serve(tlsListener) }()
	go func() { errorCh <- serverAdmin.Serve(adminListener) }()
	adminURL := fmt.Sprintf("http://localhost:%d/", *localPort)
	fmt.Println("\nClipSync Host / Windows LAN ホスト版")
	fmt.Println("----------------------------------------")
	fmt.Println("管理画面 (このPCのみ):", adminURL)
	fmt.Printf("スマホ・iPad:           https://%s:%d/\n", choice.IP, *port)
	if mdns != nil {
		fmt.Printf("mDNS対応端末:          https://%s:%d/\n", hostname, *port)
	}
	caPath := filepath.Join(*dataArg, "ClipSync-RootCA.cer")
	b, _ := os.ReadFile(caPath)
	fingerprint := sha256.Sum256(b)
	fmt.Println("公開CA証明書:", caPath)
	fmt.Println("証明書SHA-256:", strings.ToUpper(hex.EncodeToString(fingerprint[:])))
	if changed {
		fmt.Println("【重要】HTTPS証明書が新しく作成されました。接続端末へ公開CA証明書を安全に配布・信頼設定してください。")
	}
	fmt.Println("管理画面で端末を承認すると、次回は同じブラウザから自動接続します。")
	fmt.Println("WindowsファイアウォールはプライベートLANだけに限定し、ルーターのポート転送は禁止。")
	fmt.Println("このウィンドウを閉じると共有が止まり、掲示板本文は消去されます。終了: Ctrl+C")
	if !*noBrowser {
		go func() { time.Sleep(450 * time.Millisecond); openBrowser(adminURL) }()
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	select {
	case <-signals:
		fmt.Println("サーバーを終了します")
	case err := <-errorCh:
		if err != nil && err != http.ErrServerClosed {
			fmt.Println("サーバーエラー:", err)
		}
	}
	if mdns != nil {
		mdns.Close(choice, hostname, *port)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = serverLAN.Shutdown(ctx)
	_ = serverAdmin.Shutdown(ctx)
	return nil
}
func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "ClipSync Host エラー:", err)
		if runtime.GOOS == "windows" {
			fmt.Println("Enterを押すと終了します")
			var line string
			fmt.Scanln(&line)
		}
		os.Exit(1)
	}
}
