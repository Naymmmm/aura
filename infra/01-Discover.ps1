# 01-Discover.ps1 — find VPN1's topology and dump everything the other scripts need.
# Writes infra/discovered.json (gitignored local state).

param(
  [string]$CompartmentId = "",   # optional; if empty, lists compartments for you to pick
  [string]$InstanceName   = "VPN1"
)
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\OciHelpers.ps1"
Ensure-Session

$out = [ordered]@{}

# --- Compartments ---
$comps = Oci iam compartment list --query 'data[].{name:name,id:id,state:"lifecycle-state"}' --output json | ConvertFrom-Json
Write-Host "Compartments:" -ForegroundColor Cyan
$comps | ForEach-Object { Write-Host ("  {0,-40} {1}" -f $_.name, $_.id) }
if (-not $CompartmentId) {
  Write-Host "No -CompartmentId given. Pick one and re-run: -CompartmentId <ocid>" -ForegroundColor Yellow
  exit 1
}
$out["compartmentId"] = $CompartmentId

# --- VPN1 instance ---
$inst = Oci compute instance list -c $CompartmentId --display-name $InstanceName `
  --query 'data[].{id:id,name:"display-name",ad:"availability-domain",shape:shape,ocpus:"shape-config".ocpus,memGB:"shape-config".memoryInGBs,state:"lifecycle-state"}' `
  --output json | ConvertFrom-Json
if (-not $inst -or $inst.Count -eq 0) {
  Write-Host "No instance named '$InstanceName' found in compartment. List all instances for hints:" -ForegroundColor Yellow
  Oci compute instance list -c $CompartmentId --query 'data[].{name:"display-name",state:"lifecycle-state",ad:"availability-domain"}' --output table
  exit 1
}
$i = $inst[0]
Write-Host "VPN1: $($i.id) | $($i.ad) | $($i.shape) | $($i.ocpus) OCPU / $($i.memGB) GB | $($i.state)" -ForegroundColor Cyan
$out["vpn1"] = [ordered]@{
  id          = $i.id
  ad          = $i.ad
  shape       = $i.shape
  shapeConfig = [ordered]@{ ocpus = $i.ocpus; memoryInGBs = $i.memGB }
}

# --- VNIC → subnet / NSG / IPs ---
$vnic = Oci compute instance list-vnics --instance-id $i.id `
  --query 'data[0].{subnet:"subnet-id",pubIp:"public-ip",privIp:"private-ip",nsg:"nsg-ids",mac:"mac-address"}' --output json | ConvertFrom-Json
Write-Host "VNIC: subnet=$($vnic.subnet) pub=$($vnic.pubIp) priv=$($vnic.privIp) nsg=$($vnic.nsg -join ',')" -ForegroundColor Cyan
$out["subnetId"] = $vnic.subnet
$out["vpn1"]["publicIp"] = $vnic.pubIp
$out["nsgIds"] = @($vnic.nsg)

# --- Subnet → VCN ---
$sub = Oci network subnet get --subnet-id $vnic.subnet `
  --query 'data.{vcn:"vcn-id",cidr:"cidr-block",ad:"availability-domain",sl:"security-list-ids"}' --output json | ConvertFrom-Json
$out["vcnId"] = $sub.vcn
$out["securityListIds"] = @($sub.sl)
Write-Host "Subnet: VCN=$($sub.vcn) cidr=$($sub.cidr) AD=$($sub.ad)" -ForegroundColor Cyan

# --- Firewall picture ---
if ($vnic.nsg) {
  Write-Host "Firewall path: NSG (attached to VNIC)" -ForegroundColor Cyan
  $nsg = Oci network nsg get --nsg-id $vnic.nsg[0] --query 'data.{name:"display-name",rules:"security-rules"}' --output json | ConvertFrom-Json
  $nsg.rules | ForEach-Object { Write-Host ("  NSG rule: {0} {1} {2} → {3} (src {4})" -f $_.direction, $_.protocol, $_.source, $_.tcpOptions.destinationPortRange.min, $_.source) }
} else {
  Write-Host "Firewall path: subnet security lists" -ForegroundColor Cyan
  foreach ($slId in $sub.sl) {
    $sl = Oci network security-list get --security-list-id $slId --query 'data.{name:"display-name",ingress:"ingress-security-rules"}' --output json | ConvertFrom-Json
    Write-Host ("  Security list: {0}" -f $sl.name)
    $sl.ingress | ForEach-Object { Write-Host ("    ingress: {0} {1} → {2}" -f $_.protocol, $_.source, $_.tcpOptions.destinationPortRange.min) }
  }
}

# --- Availability domains ---
$ads = Oci iam availability-domain list --query 'data[].name' --output json | ConvertFrom-Json
Write-Host "ADs: $($ads -join ', ')" -ForegroundColor Cyan
$out["ads"] = @($ads)
$out["otherAd"] = ($ads | Where-Object { $_ -ne $out["vpn1"].ad }) | Select-Object -First 1

# --- Ubuntu 24.04 aarch64 image ---
$img = Oci compute image list -c $CompartmentId --operating-system "Canonical Ubuntu" `
  --operating-system-version "24.04" --shape VM.Standard.A1.Flex --sort-by TIMECREATED `
  --query 'data[0].{id:id,name:"display-name"}' --output json | ConvertFrom-Json
Write-Host "Image: $($img.name) → $($img.id)" -ForegroundColor Cyan
$out["imageId"] = $img.id

# --- Reserved public IPs ---
$pub = Oci network public-ip list -c $CompartmentId --scope REGION --lifetime RESERVED `
  --query 'data[].{ip:"ip-address",state:"lifecycle-state"}' --output json | ConvertFrom-Json
Write-Host "Reserved public IPs in region: $($pub.Count)/2" -ForegroundColor Cyan
$pub | ForEach-Object { Write-Host ("  {0} ({1})" -f $_.ip, $_.state) }

$out | ConvertTo-Json -Depth 5 | Set-Content "$PSScriptRoot\discovered.json" -Encoding UTF8
Write-Host "`nWrote infra/discovered.json" -ForegroundColor Green
