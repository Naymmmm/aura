# 03-NewServers.ps1 — launch juliet + mercutio (A1.Flex 1 OCPU/6GB, Ubuntu 24.04 aarch64)
# in VPN1's subnet, with the capacity retry ladder. Writes infra/ips.txt.

param(
  [string]$DiscoveredJson = "$PSScriptRoot\discovered.json",
  [string]$KeyFile        = "$env:USERPROFILE\.ssh\id_ed25519.pub",
  [string]$UserData       = "$PSScriptRoot\user-data.yaml",
  [string[]]$Names        = @("juliet", "mercutio")
)
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\OciHelpers.ps1"
Ensure-Session

if (-not (Test-Path $KeyFile)) { throw "SSH key not found: $KeyFile" }
$d = Get-Content $DiscoveredJson | ConvertFrom-Json
if (-not $d.imageId) { throw "discovered.json missing imageId — run 01-Discover.ps1 first" }

$ipsFile = "$PSScriptRoot\ips.txt"
if (Test-Path $ipsFile) { Remove-Item $ipsFile }

function Launch-A1([string]$Name, [string]$Ad, [int]$Ocpus, [int]$MemGB) {
  $a = @(
    "--compartment-id",      $d.compartmentId,
    "--availability-domain", $Ad,
    "--shape",               "VM.Standard.A1.Flex",
    "--shape-config",        "{`"ocpus`":$Ocpus,`"memoryInGBs`":$MemGB}",
    "--display-name",        $Name,
    "--hostname-label",      $Name,
    "--subnet-id",           $d.subnetId,
    "--assign-public-ip",    "true",
    "--image-id",            $d.imageId,
    "--ssh-authorized-keys-file", $KeyFile,
    "--user-data-file",      $UserData,
    "--wait-for-state",      "RUNNING"
  )
  if ($d.nsgIds) { $a += @("--nsg-ids", ($d.nsgIds | ConvertTo-Json -Compress)) }
  Oci compute instance launch @a
}

$adPool = @($d.vpn1.ad, $d.otherAd) | Where-Object { $_ }

foreach ($n in $Names) {
  $ok = $false
  for ($i = 1; $i -le 10 -and -not $ok; $i++) {
    $ad = $adPool[$i % $adPool.Count]
    try {
      Write-Host "[$n] attempt $i on $ad ..."
      Launch-A1 $n $ad 1 6
      $ok = $true
    } catch {
      if ($_.Exception.Message -match 'capacity|Out of host') {
        Write-Host "[$n] out of capacity on $ad — retrying in 60s (attempt $i/10)" -ForegroundColor Yellow
        Start-Sleep -Seconds 60
      } else { throw }
    }
  }
  if (-not $ok) {
    Write-Host "[$n] CAPACITY EXHAUSTED on all ADs — fallback: single 2 OCPU/12 GB node serving both hostnames. Update DNS/bootstrapping manually." -ForegroundColor Red
    exit 2
  }
  $inst = Oci compute instance list -c $d.compartmentId --display-name $n --query 'data[0].id' --raw-output
  $ip   = Oci compute instance list-vnics --instance-id $inst --query 'data[0]."public-ip"' --raw-output
  Add-Content $ipsFile "$n`t$inst`t$ip"
  Write-Host "[$n] RUNNING: $ip" -ForegroundColor Green
}

Write-Host "`nips.txt written. Next: 04-CloudflareDns.ps1 (needs CF token)" -ForegroundColor Cyan
