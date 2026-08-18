# 00-EnsureSession.ps1 — OCI session auth (browser login required).
# Run once:  powershell -File infra/00-EnsureSession.ps1
# Interactive login must be run by the user in a real terminal:
#   oci session authenticate --profile copal --region ap-melbourne-1

param([switch]$Authenticate)
$ErrorActionPreference = "Stop"

if ($Authenticate) {
  oci session terminate --profile-name copal --auth security_token 2>$null
  oci session authenticate --profile copal --region ap-melbourne-1 --session-expiration-in-minutes 60
  if ($LASTEXITCODE -ne 0) { throw "Authentication failed" }
}

# Validate existing session
oci session validate --profile copal --auth security_token
if ($LASTEXITCODE -ne 0) {
  Write-Host "No valid session. Run this with -Authenticate:" -ForegroundColor Yellow
  Write-Host "  powershell -ExecutionPolicy Bypass -File infra/00-EnsureSession.ps1 -Authenticate"
  exit 1
}
Write-Host "OCI session OK (profile: copal, region: ap-melbourne-1)" -ForegroundColor Green
