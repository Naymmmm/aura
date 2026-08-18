# 02-EnsureCapacity.ps1 — if VPN1 eats the whole Always-Free ARM pool (4 OCPU/24GB),
# resize it to 1 OCPU/6GB so juliet+mercutio can launch. STOP → update → START.

param(
  [string]$DiscoveredJson = "$PSScriptRoot\discovered.json",
  [int]$TargetOcpus       = 1,
  [int]$TargetMemGB       = 6
)
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\OciHelpers.ps1"
Ensure-Session

$d   = Get-Content $DiscoveredJson | ConvertFrom-Json
$cur = $d.vpn1.shapeConfig

if ([int]$cur.ocpus -le $TargetOcpus -and [int]$cur.memoryInGBs -le $TargetMemGB) {
  Write-Host "VPN1 already fits: $($cur.ocpus) OCPU / $($cur.memoryInGBs) GB. Nothing to resize." -ForegroundColor Green
  exit 0
}

Write-Host "VPN1 is $($cur.ocpus)/$($cur.memoryInGBs) — resizing to ${TargetOcpus}/${TargetMemGB} to free Always-Free capacity. (downtime ~1-2 min)" -ForegroundColor Yellow
Oci compute instance action --instance-id $d.vpn1.id --action STOP --wait-for-state STOPPED
Oci compute instance update --instance-id $d.vpn1.id `
  --shape-config "{`"ocpus`":$TargetOcpus,`"memoryInGBs`":$TargetMemGB}"
Oci compute instance action --instance-id $d.vpn1.id --action START --wait-for-state RUNNING

$ip = Oci compute instance list-vnics --instance-id $d.vpn1.id --query 'data[0]."public-ip"' --raw-output
Write-Host "VPN1 back online. Public IP: $ip (expected: $($d.vpn1.publicIp) — update romeo DNS if different)" -ForegroundColor Cyan
Write-Host "Capacity after: 3 × ${TargetMemGB} GB = $($TargetMemGB * 3) GB of 24 GB budget." -ForegroundColor Green
