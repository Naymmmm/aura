# CloudflareHelpers.ps1 — token/account/zone resolution from the auth file.
#
# Auth file format (no email/password — pure account-id + API token):
#   key token : <API-TOKEN>
#   key account id : <ACCOUNT-ID>
#
# Lookup order for the token:
#   1. $env:CF_API_TOKEN
#   2. $HOME\.cloudflare-auth-token        (home folder)
#   3. $PSScriptRoot\..\.cloudflare-auth-token   (repo root)

$script:CfHeaders = $null
$script:CfZoneCache = @{}

function Get-CfAuthFile {
  $candidates = @(
    "$env:USERPROFILE\.cloudflare-auth-token",
    (Join-Path (Split-Path $PSScriptRoot -Parent) ".cloudflare-auth-token")
  )
  foreach ($c in $candidates) {
    if (Test-Path $c) { return $c }
  }
  return $null
}

function Get-CfToken {
  if ($env:CF_API_TOKEN) { return $env:CF_API_TOKEN.Trim() }
  $f = Get-CfAuthFile
  if (-not $f) { throw "No Cloudflare token found — set `$env:CF_API_TOKEN or create ~/.cloudflare-auth-token" }
  $raw = [System.IO.File]::ReadAllText($f)
  if ($raw -match 'token\s*[:=]\s*([A-Za-z0-9_-]{30,80})') { return $Matches[1] }
  # fallback: longest token-shaped word
  $m = [regex]::Matches($raw, '[A-Za-z0-9_-]{30,80}') | Sort-Object { $_.Length } -Descending
  if ($m.Count -eq 0) { throw "No token-shaped value in $f" }
  return $m[0].Value
}

function Get-CfAccountId {
  if ($env:CF_ACCOUNT_ID) { return $env:CF_ACCOUNT_ID.Trim() }
  $f = Get-CfAuthFile
  if (-not $f) { return $null }
  $raw = [System.IO.File]::ReadAllText($f)
  if ($raw -match 'account\s*id\s*[:=]\s*([A-Za-z0-9_-]{16,64})') { return $Matches[1] }
  return $null
}

function Get-CfHeaders {
  if ($script:CfHeaders) { return $script:CfHeaders }
  $script:CfHeaders = @{ Authorization = "Bearer $(Get-CfToken)" }
  return $script:CfHeaders
}

function Get-CfZoneId([string]$ZoneName) {
  if ($script:CfZoneCache.ContainsKey($ZoneName)) { return $script:CfZoneCache[$ZoneName] }
  $resp = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/zones?name=$ZoneName" -Headers (Get-CfHeaders)
  if (-not $resp.success -or -not $resp.result) { throw "Zone not found: $ZoneName (token valid? has Zone:Read?)" }
  $script:CfZoneCache[$ZoneName] = $resp.result[0].id
  return $resp.result[0].id
}

function Test-CfAuth {
  # Live check: token + account id resolve to a working session.
  $headers = Get-CfHeaders
  $who = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/accounts" -Headers $headers
  $accounts = @($who.result)
  Write-Host "Cloudflare auth OK — $($accounts.Count) account(s)" -ForegroundColor Green
  foreach ($a in $accounts) { Write-Host "  $($a.name)  $($a.id)" -ForegroundColor Cyan }
  $fileAcct = Get-CfAccountId
  if ($fileAcct) {
    $match = $accounts | Where-Object { $_.id -eq $fileAcct }
    if ($match) { Write-Host "  account id from file matches ✓" -ForegroundColor Green }
    else { Write-Host "  WARNING: account id in file ($fileAcct) not among the accounts above" -ForegroundColor Yellow }
  }
}
