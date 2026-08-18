# 04-CloudflareDns.ps1 — grey-cloud A records for the 3 proxies (mandatory: DNS-only),
# orange-cloud record for api.copal.run (Worker).
# Auth: token from ~/.cloudflare-auth-token or repo root .cloudflare-auth-token
#       (or $env:CF_API_TOKEN). No email/password — account-id + API token only.

param(
  [string]$ZoneName = "copal.run",
  [string]$DiscoveredJson = "$PSScriptRoot\discovered.json"
)
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\CloudflareHelpers.ps1"

$h = Get-CfHeaders
$ZONE_ID = Get-CfZoneId $ZoneName
Write-Host "Zone: $ZoneName ($ZONE_ID)" -ForegroundColor Cyan

$d = Get-Content $DiscoveredJson | ConvertFrom-Json

# --- load IPs ---
$servers = @{}
foreach ($line in Get-Content "$PSScriptRoot\ips.txt") {
  $parts = $line -split "`t"
  if ($parts.Count -ge 3) { $servers[$parts[0]] = $parts[2] }
}
$servers["romeo"] = $d.vpn1.publicIp

function Set-Record([string]$name, [string]$ip, [bool]$proxied) {
  $existing = (Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?name=$name" -Headers $h).result
  foreach ($r in $existing) {
    Invoke-RestMethod -Method Delete -Uri "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/$($r.id)" -Headers $h | Out-Null
  }
  $body = @{ type = 'A'; name = $name; content = $ip; ttl = 1; proxied = $proxied } | ConvertTo-Json -Compress
  $resp = Invoke-RestMethod -Method Post -Uri "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" `
    -Headers $h -ContentType 'application/json' -Body $body
  if (-not $resp.success) { throw "DNS create failed for $name : $($resp.errors | ConvertTo-Json -Compress)" }
  Write-Host "created $name -> $ip (proxied=$proxied)" -ForegroundColor Green
}

# Grey-cloud (proxied=$false) — MUST resolve to real OCI IPs for Caddy LE HTTP-01 + naive tunnel
Set-Record "romeo.api"    $servers["romeo"]    $false
Set-Record "juliet.api"   $servers["juliet"]   $false
Set-Record "mercutio.api" $servers["mercutio"] $false

# Orange-cloud (proxied=$true) — api.copal.run hits the Worker; placeholder IP is replaced by CF
Set-Record "api"          "192.0.2.1"          $true

Write-Host "`nVerify BEFORE bootstrapping Caddy:" -ForegroundColor Yellow
Write-Host '  nslookup juliet.api.copal.run 1.1.1.1   -> expect OCI IP'
Write-Host '  nslookup api.copal.run 1.1.1.1           -> expect Cloudflare anycast IP'
