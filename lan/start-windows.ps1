# ClipSync LAN Windows startup. Run from PowerShell (Node.js 20+ and mkcert required).
param([string]$LanIp = "", [switch]$RenewCert)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 20以上をインストールしてください。" }
if (-not (Get-Command mkcert -ErrorAction SilentlyContinue)) { throw "mkcert をインストールしてください。README を参照してください。" }
if (-not $LanIp) {
  $ips = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' -and $_.AddressState -eq 'Preferred' } | Select-Object -ExpandProperty IPAddress -Unique)
  if ($ips.Count -ne 1) { throw "複数のLANアドレスがあります。-LanIp 192.168.x.x を指定してください。候補: $($ips -join ', ')" }
  $LanIp = $ips[0]
}
if (-not (Test-Path 'certs')) { New-Item -ItemType Directory 'certs' | Out-Null }
$cert = Join-Path $PSScriptRoot 'certs/lan.crt'
$key = Join-Path $PSScriptRoot 'certs/lan.key'
$ipMemo = Join-Path $PSScriptRoot 'certs/lan-ip.txt'
$priorIp = if (Test-Path $ipMemo) { (Get-Content $ipMemo -Raw).Trim() } else { "" }
if ((-not (Test-Path $cert)) -or (-not (Test-Path $key)) -or $RenewCert -or $priorIp -ne $LanIp) {
  Write-Host "HTTPS証明書を生成します。端末側でもmkcertの公開CA証明書を信頼する設定が必要です。" -ForegroundColor Cyan
  & mkcert -install
  if ($LASTEXITCODE -ne 0) { throw "mkcert -install に失敗しました。" }
  & mkcert -cert-file $cert -key-file $key $LanIp localhost 127.0.0.1
  if ($LASTEXITCODE -ne 0) { throw "証明書生成に失敗しました。" }
  Set-Content -Path $ipMemo -Value $LanIp
}
$env:CLIPSYNC_HOST_IP = $LanIp
$env:CLIPSYNC_TLS_CERT = $cert
$env:CLIPSYNC_TLS_KEY = $key
Write-Host "ホスト管理: https://localhost:4477/" -ForegroundColor Green
Write-Host "他の端末: https://${LanIp}:4477/" -ForegroundColor Green
Write-Host "* Windowsファイアウォールでは、必ずプライベートネットワークからの接続に限定してください。" -ForegroundColor Yellow
& node server.cjs
