# 06-AddCredPool.ps1 — bake a rotating cred pool (64 pairs/server) into every Caddyfile.
# Keeps the 1 static pair (emergency fallback) + adds 64 pool pairs per server, so the
# Worker can hand each session its own temp pair. Requires: servers live + bootstrapped
# (05), infra/credentials.json, infra/ips.txt.
# Usage:
#   pwsh -File infra/06-AddCredPool.ps1 -Only mercutio -SkipKv   # dry run, one server
#   pwsh -File infra/06-AddCredPool.ps1                          # all servers + KV push

param(
  [string]$IpsFile   = "$PSScriptRoot\ips.txt",
  [string]$Email     = "admin@copal.run",
  [int]$PoolSize     = 64,
  [string[]]$Only    = @(),   # e.g. -Only mercutio
  [switch]$SkipKv             # skip the wrangler KV push (dry run)
)
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\OciHelpers.ps1"

$servers = @{}
foreach ($line in Get-Content $IpsFile) {
  $p = $line -split "`t"
  if ($p.Count -ge 3) { $servers[$p[0]] = $p[2] }
}
$sshUsers = @{ romeo = "ubuntu"; juliet = "ubuntu"; mercutio = "ubuntu" }
$credsFile = "$PSScriptRoot\credentials.json"
if (Test-Path $credsFile) { $creds = Get-Content $credsFile | ConvertFrom-Json } else { $creds = @{} }
$poolOut = @{}

function Get-Hostname([string]$name) { return "$name.api.copal.run" }

function Write-PoolCaddyfile([string]$name, [string]$ip, [string]$sshUser) {
  $c = $creds.$name
  $hostname = Get-Hostname $name
  # one basic_auth line per pair: static first (emergency fallback), then the pool
  $authLines = "			basic_auth $($c.username) $($c.password)"
  foreach ($pair in $c.pool) {
    $authLines += "`n			basic_auth $($pair.username) $($pair.password)"
  }
  $caddy = @"
{
	order forward_proxy before file_server
	admin off
}
:443, $hostname {
	tls $Email
	route {
		forward_proxy {
$authLines
			hide_ip
			hide_via
			probe_resistance
		}
		file_server {
			root /var/www/html
		}
	}
}
:80 {
	respond "OK" 200
}
"@
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($caddy.Replace("`r", "")))
  ssh -i "$env:USERPROFILE\.ssh\id_ed25519" -o StrictHostKeyChecking=accept-new $sshUser@$ip "sudo mkdir -p /etc/naiveproxy && echo $b64 | base64 -d | sudo tee /etc/naiveproxy/Caddyfile > /dev/null"
  if ($LASTEXITCODE -ne 0) { throw "failed writing Caddyfile on $name" }
}

function Run-Naive([string]$name, [string]$ip, [string]$sshUser) {
  ssh -i "$env:USERPROFILE\.ssh\id_ed25519" -o StrictHostKeyChecking=accept-new $sshUser@$ip @'
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

function Test-PoolProxy([string]$name, [string]$ip, [string]$user, [string]$pass) {
  $hostname = Get-Hostname $name
  $out = curl.exe -sS --max-time 25 --proxy "https://$user`:$pass@$hostname" https://api.ipify.org 2>$null
  Write-Host "  pool pair $user -> $out"
  if ($out -ne $ip) { throw "pool proxy test failed for $name ($user expected $ip, got '$out')" }
}

# ---- main ----
$todo = @($servers.Keys | Where-Object { -not $Only -or $_ -in $Only })

foreach ($name in $todo) {
  $ip = $servers[$name]
  $sshUser = $sshUsers[$name]
  if (-not $sshUser) { $sshUser = "ubuntu" }
  Write-Host "=== $name ($ip) as $sshUser ===" -ForegroundColor Cyan

  if (-not $creds.$name) { throw "no creds for $name — run 05-Bootstrap.ps1 first" }
  $c = $creds.$name

  # generate the pool once, persist immediately (idempotent on re-runs)
  if (-not $c.pool) {
    $existing = @{}
    foreach ($u in @($c.username) + @($c.pool | ForEach-Object { $_.username })) { if ($u) { $existing[$u] = $true } }
    $pool = @()
    while ($pool.Count -lt $PoolSize) {
      $p = New-ProxyCreds
      if (-not $existing.ContainsKey($p.username)) {
        $existing[$p.username] = $true
        $pool += $p
      }
    }
    $creds.$name | Add-Member -NotePropertyName pool -NotePropertyValue $pool -Force
    $creds | ConvertTo-Json -Depth 4 | Set-Content $credsFile -Encoding UTF8
    Write-Host "  generated $($pool.Count) pool pairs"
  } else {
    Write-Host "  pool already exists ($($c.pool.Count) pairs)"
  }

  Write-Host "  writing Caddyfile (1 static + $($c.pool.Count) pool basic_auth lines)..."
  Write-PoolCaddyfile $name $ip $sshUser
  Run-Naive $name $ip $sshUser

  # container restart: bcrypt-provisioning 65 pairs takes a few seconds — poll the probe
  $probeOk = $false
  foreach ($try in 1..5) {
    Start-Sleep -Seconds 20
    $code = curl.exe -sI --max-time 15 "https://$(Get-Hostname $name)" 2>$null | Select-Object -First 1
    if ($code -match '404|403|401|200') { $probeOk = $true; Write-Host "  probe (try $try): $code"; break }
  }
  if (-not $probeOk) {
    ssh -i "$env:USERPROFILE\.ssh\id_ed25519" -o StrictHostKeyChecking=accept-new $sshUser@$ip "sudo docker logs naive 2>&1 | tail -30"
    throw "Caddy never came up on $name after reload"
  }

  # verify: static + 2 pool pairs through the proxy
  Test-PoolProxy $name $ip $c.username $c.password
  Test-PoolProxy $name $ip $c.pool[0].username $c.pool[0].password
  Test-PoolProxy $name $ip $c.pool[41].username $c.pool[41].password
  $code = curl.exe -sI --max-time 15 "https://$(Get-Hostname $name)" 2>$null | Select-Object -First 1
  Write-Host "  unauthenticated probe: $code"
  if ($code -match '407') { throw "probe_resistance not working on $name — got 407" }

  $poolOut[$name] = @($c.pool | ForEach-Object { @{ user = $_.username; pass = $_.password } })
  Write-Host "  $name pool OK ✔" -ForegroundColor Green
}

$poolJson = $poolOut | ConvertTo-Json -Depth 3
$poolFile = "$PSScriptRoot\..\worker\pool.json"
Set-Content $poolFile $poolJson -Encoding UTF8
Write-Host "`nPool written to worker/pool.json ($($poolJson.Length) bytes)" -ForegroundColor Green

if (-not $SkipKv) {
  Write-Host "Pushing pool to KV..." -ForegroundColor Cyan
  . "$PSScriptRoot\..\infra\CloudflareHelpers.ps1"
  $env:CLOUDFLARE_API_TOKEN  = Get-CfToken
  $env:CLOUDFLARE_ACCOUNT_ID = Get-CfAccountId
  Push-Location "$PSScriptRoot\..\worker"
  npx wrangler kv key put pool --binding SERVERS --path $poolFile --remote
  $rc = $LASTEXITCODE
  Pop-Location
  if ($rc -ne 0) { throw "wrangler kv key put failed" }
  Write-Host "pool pushed to KV ✓" -ForegroundColor Green
} else {
  Write-Host "(-SkipKv) not pushing to KV" -ForegroundColor Yellow
}
