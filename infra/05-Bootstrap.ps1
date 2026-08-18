# 05-Bootstrap.ps1 — deploy NaiveProxy (Caddy + forwardproxy) on all servers.
# For each server: wait cloud-init → write Caddyfile → docker run (LE staging first) → verify.
# Requires: infra/ips.txt (from 03), DNS records live (from 04).

param(
  [string]$IpsFile   = "$PSScriptRoot\ips.txt",
  [string]$Email     = "admin@copal.run",   # Let's Encrypt account email
  [switch]$Production,                        # skip staging CA (use only after staging verified)
  [string[]]$Only    = @()                    # e.g. -Only juliet,mercutio to skip romeo
)
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\OciHelpers.ps1"

$servers = @{}
foreach ($line in Get-Content $IpsFile) {
  $p = $line -split "`t"
  if ($p.Count -ge 3) { $servers[$p[0]] = $p[2] }
}

function Get-Hostname([string]$name) { return "$name.api.copal.run" }

function Write-CaddyfileOn([string]$name, [string]$ip, [string]$user, [string]$pass, [bool]$staging) {
  $hostname = Get-Hostname $name
  $caLine = if ($staging) { "  tls { ca https://acme-staging-v02.api.letsencrypt.org/directory }" } else { "  tls $Email" }
  $caddy = @"
{
	order forward_proxy before file_server
	admin off
}
:443, $hostname
$caLine
route {
	forward_proxy {
		basic_auth $user $pass
		hide_ip
		hide_via
		probe_resistance
	}
	file_server { root /var/www/html }
}
:80
respond "OK" 200
"@
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($caddy))
  ssh -i "$env:USERPROFILE\.ssh\id_ed25519" -o StrictHostKeyChecking=accept-new ubuntu@$ip "echo $b64 | base64 -d | sudo tee /etc/naiveproxy/Caddyfile > /dev/null"
  if ($LASTEXITCODE -ne 0) { throw "failed writing Caddyfile on $name" }
}

function Run-Naive([string]$name, [string]$ip) {
  ssh -i "$env:USERPROFILE\.ssh\id_ed25519" -o StrictHostKeyChecking=accept-new ubuntu@$ip @'
sudo docker rm -f naive 2>/dev/null; sudo docker volume create naive-data >/dev/null 2>&1 || true
sudo docker run -d --name naive --restart unless-stopped \
  -v naive-data:/root/.local/share/caddy \
  -v /etc/naiveproxy:/etc/naiveproxy \
  -e PATH=/etc/naiveproxy/Caddyfile \
  -p 80:80 -p 443:443 -p 443:443/udp \
  pocat/naiveproxy:latest
'@
  if ($LASTEXITCODE -ne 0) { throw "docker run failed on $name" }
}

function Wait-CloudInit([string]$ip, [int]$TimeoutSec = 600) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $out = ssh -i "$env:USERPROFILE\.ssh\id_ed25519" -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new ubuntu@$ip "sudo cloud-init status --wait 2>/dev/null | tail -1" 2>$null
    if ($LASTEXITCODE -eq 0 -and $out -match 'done') { Write-Host "  cloud-init done" -ForegroundColor Green; return }
    Start-Sleep -Seconds 15
  }
  throw "cloud-init not done within ${TimeoutSec}s on $ip"
}

function Test-Proxy([string]$name, [string]$ip, [string]$user, [string]$pass) {
  $hostname = Get-Hostname $name
  Write-Host "  proxy test: curl --proxy https://$user:***@$hostname ..."
  $out = curl.exe -sS --max-time 25 --proxy "https://$user`:$pass@$hostname" https://api.ipify.org 2>$null
  Write-Host "  exit IP via $name : $out"
  if ($out -ne $ip) { throw "proxy test failed for $name (expected $ip, got '$out')" }
  # probe resistance: unauthenticated request must NOT be a 407
  $code = curl.exe -sI --max-time 15 "https://$hostname" 2>$null | Select-Object -First 1
  Write-Host "  unauthenticated probe: $code"
  if ($code -match '407') { throw "probe_resistance not working on $name — got 407" }
}

# ---- main ----
$credsFile = "$PSScriptRoot\credentials.json"
if (Test-Path $credsFile) { $creds = Get-Content $credsFile | ConvertFrom-Json } else { $creds = @{} }

foreach ($name in $servers.Keys) {
  if ($Only -and $name -notin $Only) { continue }
  $ip = $servers[$name]
  Write-Host "=== $name ($ip) ===" -ForegroundColor Cyan

  if (-not (Test-Ssh $ip)) {
    Write-Host "  SSH not reachable yet — waiting for boot..." -ForegroundColor Yellow
    $deadline = (Get-Date).AddMinutes(5)
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 10
      if (Test-Ssh $ip) { break }
    }
  }
  Wait-CloudInit $ip

  # credentials: generate if missing (or reuse existing creds if this is romeo with existing config)
  if (-not $creds.$name) {
    $c = New-ProxyCreds
    $creds | Add-Member -NotePropertyName $name -NotePropertyValue $c -Force
  }
  $c = $creds.$name

  if (-not $Production) {
    Write-Host "  staging CA first (verifies ACME path without burning LE rate limits)" -ForegroundColor Yellow
    Write-CaddyfileOn $name $ip $c.username $c.password $true
    Run-Naive $name $ip
    Start-Sleep -Seconds 45
    Write-Host "  checking cert issuer..."
    $issuer = echo | openssl s_client -connect "$(Get-Hostname $name):443" -servername $(Get-Hostname $name) 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null
    Write-Host "  issuer: $issuer"
    if ($issuer -notmatch 'Fake LE Intermediate') { throw "staging cert not issued on $name: $issuer" }
  }

  Write-Host "  production CA..." -ForegroundColor Green
  Write-CaddyfileOn $name $ip $c.username $c.password $false
  Run-Naive $name $ip
  Start-Sleep -Seconds 45
  $issuer = echo | openssl s_client -connect "$(Get-Hostname $name):443" -servername $(Get-Hostname $name) 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null
  Write-Host "  issuer: $issuer"
  if ($issuer -notmatch 'R10|E1|R11') { Write-Host "  WARNING: cert issuer unexpected: $issuer" -ForegroundColor Yellow }

  Test-Proxy $name $ip $c.username $c.password
  Write-Host "  $name OK ✔" -ForegroundColor Green
}

$creds | ConvertTo-Json -Depth 3 | Set-Content $credsFile -Encoding UTF8
Write-Host "`nCredentials saved to infra/credentials.json (gitignored)" -ForegroundColor Green
