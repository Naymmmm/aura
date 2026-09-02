# 03b-Remake.ps1 — full remake: terminate the old (disabled) instances, launch
# romeo + juliet + mercutio fresh (A1.Flex 1 OCPU/6GB, Ubuntu 24.04), write ips.txt.
# Run AFTER `oci session authenticate`. Next steps: 04-CloudflareDns.ps1 → 05-Bootstrap.ps1.

param(
  [string]$DiscoveredJson = "$PSScriptRoot\discovered.json",
  [string]$KeyFile        = "$env:USERPROFILE\.ssh\id_ed25519.pub",
  [string]$UserData       = "$PSScriptRoot\user-data.yaml",
  [string[]]$Names        = @("romeo", "juliet", "mercutio")
)
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\OciHelpers.ps1"
Ensure-Session

$d = Get-Content $DiscoveredJson | ConvertFrom-Json
$ipsFile = "$PSScriptRoot\ips.txt"

function Terminate-Instances {
  foreach ($line in Get-Content $ipsFile) {
    $p = $line -split "`t"
    if ($p.Count -lt 2) { continue }
    $name, $id = $p[0], $p[1]
    Write-Host "[terminate] $name ($id)" -ForegroundColor Yellow
    try {
      Oci compute instance terminate --instance-id $id --force --preserve-boot-volume false
      Write-Host "[terminate] $name ok" -ForegroundColor Green
    } catch {
      # disabled instances may refuse — that's fine, they can't come back either
      Write-Host "[terminate] $name refused: $($_.Exception.Message.Split("`n")[0])" -ForegroundColor Red
    }
  }
}

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
    "--assign-ipv6-ip",      "true",
    "--image-id",            $d.imageId,
    "--ssh-authorized-keys-file", $KeyFile,
    "--user-data-file",      $UserData,
    "--wait-for-state",      "RUNNING"
  )
  if ($d.nsgIds) { $a += @("--nsg-ids", ($d.nsgIds | ConvertTo-Json -Compress)) }
  Oci compute instance launch @a
}

# ---- main ----
if (Test-Path $ipsFile) {
  Write-Host "Terminating old instances..." -ForegroundColor Cyan
  Terminate-Instances
  Start-Sleep -Seconds 10
}

Remove-Item $ipsFile -ErrorAction SilentlyContinue
$adPool = @(@($d.vpn1.ad, $d.otherAd) | Where-Object { $_ })

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
      } else {
        # if the tenancy is suspended, launch will throw something non-capacity — surface it
        Write-Host "[$n] LAUNCH FAILED: $($_.Exception.Message.Split("`n")[0])" -ForegroundColor Red
        exit 1
      }
    }
  }
  if (-not $ok) { Write-Host "[$n] CAPACITY EXHAUSTED" -ForegroundColor Red; exit 2 }
  $inst = Oci compute instance list -c $d.compartmentId --display-name $n --query 'data[0].id' --raw-output
  $ip   = Oci compute instance list-vnics --instance-id $inst --query 'data[0]."public-ip"' --raw-output
  Add-Content $ipsFile "$n`t$inst`t$ip"
  Write-Host "[$n] RUNNING: $ip" -ForegroundColor Green
}

Write-Host "`nRemake done. Next: 04-CloudflareDns.ps1 (repoint DNS) -> 05-Bootstrap.ps1 (reuse creds)" -ForegroundColor Cyan
