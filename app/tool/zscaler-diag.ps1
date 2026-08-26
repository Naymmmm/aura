# zscaler-diag.ps1 — run this on the machine where Aura can't reach websites.
# Prints what's actually happening at each layer so we can tell whether
# Zscaler is MITM-ing the tunnel, killing the data path, or conflicting routes.
#
#   pwsh -File app/tool/zscaler-diag.ps1
# Paste the whole output back.

$ErrorActionPreference = 'Continue'
Write-Host "===== Aura / Zscaler diagnostic =====" -ForegroundColor Cyan
Write-Host "run at: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"

# 1. Real TLS issuer for each naive host — Zscaler MITM re-signs with its own CA.
Write-Host "`n--- 1. TLS certificate issuer (MITM check) ---" -ForegroundColor Cyan
foreach ($h in @('romeo.api.copal.run', 'juliet.api.copal.run', 'mercutio.api.copal.run')) {
  try {
    $tcp = New-Object System.Net.Sockets.TcpClient($h, 443)
    $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, { $true })
    $ssl.AuthenticateAsClient($h)
    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($ssl.RemoteCertificate)
    Write-Host "  $h"
    Write-Host "    issuer : $($cert.Issuer)"
    $ssl.Dispose(); $tcp.Close()
  } catch {
    Write-Host "  $h -> ERROR: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}
Write-Host "  (issuer should contain 'Let's Encrypt' — anything else = MITM)"

# 2. Does the naive proxy data path actually work from this machine?
#    Reads the creds from Aura's own generated config so we test the exact pair.
Write-Host "`n--- 2. Naive proxy roundtrip (creds from Aura's own config) ---" -ForegroundColor Cyan
$cfgFile = Get-ChildItem "$env:APPDATA" -Recurse -Filter config.json -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match 'aura|com\.example' } | Select-Object -First 1
if ($cfgFile) {
  $cfg = Get-Content $cfgFile.FullName -Raw | ConvertFrom-Json
  foreach ($ob in $cfg.outbounds) {
    if ($ob.type -eq 'naive') {
      $url = "https://$($ob.username):$($ob.password)@$($ob.server):$($ob.server_port)"
      $out = curl.exe -sS --max-time 20 --proxy $url https://api.ipify.org 2>&1
      Write-Host "  $($ob.tag) -> $out"
    }
  }
} else {
  Write-Host "  no aura config.json found in %APPDATA% — connect once first, then re-run" -ForegroundColor Yellow
}

# 3. Proxy env vars — these route curl/http clients around the tunnel.
Write-Host "`n--- 3. System proxy env ---" -ForegroundColor Cyan
Write-Host "  HTTP_PROXY  = $env:HTTP_PROXY"
Write-Host "  HTTPS_PROXY = $env:HTTPS_PROXY"
Write-Host "  WinINET proxy = $(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProxyEnable) / $((Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue).ProxyServer)"

# 4. TUN adapters / route table — Zscaler ZPA installs its own TUN + routes.
Write-Host "`n--- 4. TUN-ish network adapters ---" -ForegroundColor Cyan
Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object {
  $_.InterfaceDescription -match 'TUN|TAP|WireGuard|Zscaler|ZPA|Astrill' -or $_.Name -match 'tun|wg'
} | Format-Table Name, InterfaceDescription, Status, LinkSpeed -AutoSize

Write-Host "`n--- 5. Default routes (0.0.0.0) ---" -ForegroundColor Cyan
route print -4 | Select-String '0\.0\.0\.0\s+0\.0\.0\.0' | ForEach-Object { $_.Line }

# 6. Zscaler processes.
Write-Host "`n--- 6. Zscaler processes ---" -ForegroundColor Cyan
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'zscaler|zpa|zcc|ZS' } |
  Select-Object ProcessName, Id | Format-Table -AutoSize

# 7. Does plain HTTPS to a website work outside the tunnel right now?
Write-Host "`n--- 7. Baseline internet (no tunnel) ---" -ForegroundColor Cyan
$code = curl.exe -s -o NUL -w '%{http_code}' --max-time 15 https://api.ipify.org 2>$null
Write-Host "  direct https://api.ipify.org -> HTTP $code"

Write-Host "`n===== end — paste this output back to Claude =====" -ForegroundColor Cyan
