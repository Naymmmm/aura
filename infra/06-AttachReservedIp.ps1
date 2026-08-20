# 06-AttachReservedIp.ps1 — rescue vpn1: attach reserved IP + open firewall.
# vpn1 (→ romeo.api.copal.run) was discovered RUNNING but with NO public IP
# and an empty NSG (inbound default-deny). This script:
#   1. attaches a reserved public IP to the vpn1 VNIC
#   2. adds NSG ingress rules for TCP 22/80/443 + egress allow-all
#   3. (no security-list changes needed — a VNIC with an NSG ignores subnet SLs)
# Idempotent: safe to re-run.
# Usage: pwsh -NoProfile -File infra/06-AttachReservedIp.ps1
#
# NOTE: OCIDs/IPs below are redacted in this public copy — fill in the
# tenancy's values from OciHelpers if the rescue ever needs re-running.
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\OciHelpers.ps1"
Ensure-Session

$InstanceId = "ocid1.instance.oc1.ap-melbourne-1.<REDACTED>"
$ReservedIp = "ocid1.publicip.oc1.ap-melbourne-1.<REDACTED>"
$NsgId      = "ocid1.networksecuritygroup.oc1.ap-melbourne-1.<REDACTED>"

# --- 1. Attach reserved IP (idempotent: skip if already attached) ---
$vnicId = Oci compute instance list-vnics --instance-id $InstanceId --all --query 'data[0].id' --raw-output
$curIp  = Oci compute instance list-vnics --instance-id $InstanceId --all --query 'data[0]."public-ip"' --raw-output
if ($curIp -eq "<REDACTED>") {
  Write-Host "Reserved IP already attached (<REDACTED>)" -ForegroundColor Green
} else {
  $SubnetId = Oci compute instance list-vnics --instance-id $InstanceId --all --query 'data[0]."subnet-id"' --raw-output
  $privIp = Oci network private-ip list --subnet-id $SubnetId --ip-address "<REDACTED>" --query 'data[0].id' --raw-output
  if (-not $privIp) { throw "private IP <REDACTED> not found in subnet $SubnetId" }
  Oci network public-ip update --public-ip-id $ReservedIp --private-ip-id $privIp --query 'data."ip-address"' --raw-output
  Write-Host "Attached reserved IP <REDACTED> to vpn1" -ForegroundColor Green
}

# --- 2. NSG rules (add is incremental; skips exact duplicates) ---
$rules = @(
  @{ direction = "INGRESS"; protocol = "6"; source = "0.0.0.0/0"; tcpOptions = @{ destinationPortRange = @{ min = 22;  max = 22  } } },
  @{ direction = "INGRESS"; protocol = "6"; source = "0.0.0.0/0"; tcpOptions = @{ destinationPortRange = @{ min = 80;  max = 80  } } },
  @{ direction = "INGRESS"; protocol = "6"; source = "0.0.0.0/0"; tcpOptions = @{ destinationPortRange = @{ min = 443; max = 443 } } },
  @{ direction = "EGRESS";  protocol = "all"; destination = "0.0.0.0/0" }
)
$payload = $rules | ConvertTo-Json -Depth 6 -Compress
Oci network nsg rules add --nsg-id $NsgId --security-rules $payload --query 'data[].{id:id,dir:direction,proto:protocol}' --output json | Out-Null
Write-Host "NSG rules added (22/80/443 ingress, egress all)" -ForegroundColor Green

# --- 3. Verify ---
Start-Sleep -Seconds 3
$ip = Oci compute instance list-vnics --instance-id $InstanceId --all --query 'data[0]."public-ip"' --raw-output
Write-Host "vpn1 public IP now: $ip" -ForegroundColor Cyan
$null = ssh -i "$env:USERPROFILE\.ssh\id_ed25519" -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new -o BatchMode=yes ubuntu@$ip 'hostname' 2>$null
if ($LASTEXITCODE -eq 0) { Write-Host "SSH to vpn1 OK ✓" -ForegroundColor Green } else { Write-Host "SSH not open yet (firewall/agent may lag) — retry shortly" -ForegroundColor Yellow }
