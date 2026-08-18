# fetch_singbox.ps1 — download sing-box + wintun.dll next to the dev-built exe.
# Usage (from app/):  pwsh tool/fetch_singbox.ps1
param(
  [string]$Version = "1.13.15",
  [string]$Target   = "build/windows/x64/runner/Release"
)
$ErrorActionPreference = "Stop"

$dest = Join-Path (Split-Path $PSScriptRoot -Parent) $Target
$sbDir = Join-Path $dest "sing-box"
New-Item -ItemType Directory -Force -Path $sbDir | Out-Null

$zip = "$env:TEMP\sing-box-$Version.zip"
if (-not (Test-Path $zip)) {
  Write-Host "Downloading sing-box $Version (windows-amd64)..."
  Invoke-WebRequest "https://github.com/SagerNet/sing-box/releases/download/v$Version/sing-box-$Version-windows-amd64.zip" -OutFile $zip
}
$extract = "$env:TEMP\singbox-extract"
if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $extract -Force

# The zip contains a version-named subfolder — copy ALL files from it
# (sing-box.exe + libcronet.dll + license).
$src = Get-ChildItem $extract -Directory | Select-Object -First 1
if (-not $src) { throw "unexpected zip layout" }
Get-ChildItem $src.FullName | Copy-Item -Destination $sbDir -Recurse -Force

if (-not (Test-Path (Join-Path $sbDir "wintun.dll"))) {
  Write-Host "wintun.dll not bundled — downloading 0.14.1..."
  $w = "$env:TEMP\wintun.zip"
  if (-not (Test-Path $w)) { Invoke-WebRequest "https://www.wintun.net/builds/wintun-0.14.1.zip" -OutFile $w }
  Expand-Archive -Path $w -DestinationPath "$env:TEMP\wintun-extract" -Force
  Copy-Item "$env:TEMP\wintun-extract\wintun\bin\amd64\wintun.dll" $sbDir -Force
}

Write-Host "sing-box ready at: $sbDir" -ForegroundColor Green
Get-ChildItem $sbDir | Select-Object Name, Length
