# fetch_naive.ps1 — build Aura Core and fetch its Windows runtime dependencies.
# Usage (from app/):  pwsh tool/fetch_naive.ps1
param(
  [string]$Version = "150.0.7871.63-1",
  [string]$Target  = "build/windows/x64/runner/Release"
)
$ErrorActionPreference = "Stop"

$dest = Join-Path (Split-Path $PSScriptRoot -Parent) $Target
$coreDir = Join-Path $dest "aura-core"
New-Item -ItemType Directory -Force -Path $coreDir | Out-Null

$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Push-Location (Join-Path $repoRoot "aura-core")
try {
  go build -trimpath -ldflags "-s -w -H=windowsgui" -o (Join-Path $coreDir "aura-core.exe") .
} finally {
  Pop-Location
}

$work = Join-Path $env:TEMP "aura-naive-$Version"
New-Item -ItemType Directory -Force -Path $work | Out-Null
$zip = Join-Path $work "naive.zip"
if (-not (Test-Path $zip)) {
  Write-Host "Downloading NaiveProxy $Version (windows-x64)..."
  Invoke-WebRequest "https://github.com/klzgrad/naiveproxy/releases/download/v$Version/naiveproxy-v$Version-win-x64.zip" -OutFile $zip
}
$extract = Join-Path $work "extract"
if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $extract -Force
$src = Get-ChildItem $extract -Directory | Select-Object -First 1
if (-not $src -or -not (Test-Path (Join-Path $src.FullName "naive.exe"))) {
  throw "unexpected NaiveProxy archive layout"
}
Copy-Item (Join-Path $src.FullName "naive.exe") $coreDir -Force

$wintunZip = Join-Path $work "wintun.zip"
if (-not (Test-Path $wintunZip)) {
  Write-Host "Downloading Wintun 0.14.1..."
  Invoke-WebRequest "https://www.wintun.net/builds/wintun-0.14.1.zip" -OutFile $wintunZip
}
$wintunExtract = Join-Path $work "wintun"
if (Test-Path $wintunExtract) { Remove-Item $wintunExtract -Recurse -Force }
Expand-Archive -Path $wintunZip -DestinationPath $wintunExtract -Force
Copy-Item (Join-Path $wintunExtract "wintun\bin\amd64\wintun.dll") $coreDir -Force

Write-Host "Aura Core dev bundle ready at: $coreDir" -ForegroundColor Green
Get-ChildItem $coreDir | Select-Object FullName, Length
