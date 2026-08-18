# Shared helpers for Aura infra scripts.
# Usage: . "$PSScriptRoot\OciHelpers.ps1"

param() # keep script as a dot-sourced library

$script:Profile = "copal"
$script:Auth    = "security_token"

function Oci {
  # Wrapper that always passes --profile copal --auth security_token.
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  & oci.exe --profile $script:Profile --auth $script:Auth @Args
  if ($LASTEXITCODE -ne 0) { throw "oci $($Args -join ' ') failed with exit code $LASTEXITCODE" }
}

function Oci-Raw {
  # Like Oci but returns raw exit code instead of throwing (for retry loops).
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  & oci.exe --profile $script:Profile --auth $script:Auth @Args
  return $LASTEXITCODE
}

function Ensure-Session {
  # Refresh the session token; every script calls this first.
  Oci session refresh 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Session refresh failed — run: oci session authenticate --profile copal --region ap-melbourne-1" -ForegroundColor Yellow
    throw "OCI session expired. Re-authenticate first."
  }
}

function New-ProxyCreds {
  # Random naiveproxy username + strong password, per server.
  $u = -join ((97..122) | Get-Random -Count 10 | ForEach-Object { [char]$_ })
  $p = -join (48..57 + 65..90 + 97..122 | Get-Random -Count 24 | ForEach-Object { [char]$_ })
  return @{ username = $u; password = $p }
}

function Test-Ssh([string]$HostName, [string]$User = "ubuntu", [int]$TimeoutSec = 8) {
  # Quick reachability check with the standard key.
  $null = ssh -i "$env:USERPROFILE\.ssh\id_ed25519" -o ConnectTimeout=$TimeoutSec `
    -o StrictHostKeyChecking=accept-new -o BatchMode=yes $User@$HostName 'echo ok' 2>$null
  return $LASTEXITCODE -eq 0
}
