# set-secret.ps1 — one-shot: pushes API_SECRET to the copal-api worker.
# Reads the token from ~/.cloudflare-auth-token (or repo root) — no email/password.
# Usage:  pwsh -File worker/set-secret.ps1
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\..\infra\CloudflareHelpers.ps1"

$env:CLOUDFLARE_API_TOKEN  = Get-CfToken
$env:CLOUDFLARE_ACCOUNT_ID = Get-CfAccountId

$secret = ((Get-Content "$PSScriptRoot\.dev.vars" -Raw) -replace '^API_SECRET=', '').Trim()
if ($secret.Length -ne 64) { throw "API_SECRET not found or wrong length in worker/.dev.vars" }

$secret | npx wrangler secret put API_SECRET --name copal-api
if ($LASTEXITCODE -ne 0) { throw "wrangler secret put failed" }
Write-Host "API_SECRET set on copal-api ✓" -ForegroundColor Green
