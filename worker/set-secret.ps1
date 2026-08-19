# set-secret.ps1 — one-shot: pushes API_SECRET to the copal-api worker.
# Reads the token from ~/.cloudflare-auth-token (or repo root) — no email/password.
# Usage:  pwsh -File worker/set-secret.ps1
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\..\infra\CloudflareHelpers.ps1"

$env:CLOUDFLARE_API_TOKEN  = Get-CfToken
$env:CLOUDFLARE_ACCOUNT_ID = Get-CfAccountId

$lines = (Get-Content "$PSScriptRoot\.dev.vars" -Raw) -split "`r?`n"
$secret = (($lines | Where-Object { $_ -like 'API_SECRET=*' } | Select-Object -First 1) -replace '^API_SECRET=', '').Trim()
if ($secret.Length -ne 64) { throw "API_SECRET not found or wrong length in worker/.dev.vars" }

$admin = (($lines | Where-Object { $_ -like 'ADMIN_PASSWORD=*' } | Select-Object -First 1) -replace '^ADMIN_PASSWORD=', '').Trim()
if ($admin.Length -lt 16) { throw "ADMIN_PASSWORD not found or too short in worker/.dev.vars" }

$secret | npx wrangler secret put API_SECRET --name copal-api
if ($LASTEXITCODE -ne 0) { throw "wrangler secret put API_SECRET failed" }
Write-Host "API_SECRET set on copal-api ✓" -ForegroundColor Green

$admin | npx wrangler secret put ADMIN_PASSWORD --name copal-api
if ($LASTEXITCODE -ne 0) { throw "wrangler secret put ADMIN_PASSWORD failed" }
Write-Host "ADMIN_PASSWORD set on copal-api ✓" -ForegroundColor Green
