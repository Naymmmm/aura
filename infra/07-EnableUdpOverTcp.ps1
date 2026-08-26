# 07-EnableUdpOverTcp.ps1 — replace the Caddy Naive server with sing-box's
# Naive inbound. Caddy's forward_proxy supports TCP CONNECT only; sing-box is
# required on both ends for Aura's UDP-over-TCP v2 traffic.
#
# The migration is transactional per server:
#   1. Generate and upload a config containing the existing credential pool.
#   2. Validate it with the pinned server image.
#   3. Stop (but keep) the old Caddy container and start sing-box.
#   4. Roll back to Caddy automatically if sing-box does not become healthy.
#
# Usage:
#   pwsh -File infra/07-EnableUdpOverTcp.ps1
#   pwsh -File infra/07-EnableUdpOverTcp.ps1 -Only mercutio
#   pwsh -File infra/07-EnableUdpOverTcp.ps1 -Only mercutio -Staging

param(
  [string]$IpsFile = "$PSScriptRoot\ips.txt",
  [string]$CredentialsFile = "$PSScriptRoot\credentials.json",
  [string]$Email = "admin@copal.run",
  [string]$SingBoxVersion = "v1.13.15",
  [string[]]$Only = @(),
  [switch]$Staging,
  [string]$SshKey = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ssh/id_ed25519')
)

$ErrorActionPreference = "Stop"
$sshUsers = @{ romeo = "ubuntu"; juliet = "ubuntu"; mercutio = "ubuntu" }

if (-not (Test-Path $IpsFile)) { throw "missing $IpsFile" }
if (-not (Test-Path $CredentialsFile)) { throw "missing $CredentialsFile" }
if (-not (Test-Path $SshKey)) { throw "missing SSH key $SshKey" }

$servers = @{}
foreach ($line in Get-Content $IpsFile) {
  $parts = $line -split "`t"
  if ($parts.Count -ge 3) { $servers[$parts[0]] = $parts[2] }
}
$credentials = Get-Content $CredentialsFile -Raw | ConvertFrom-Json
$image = "ghcr.io/sagernet/sing-box:$SingBoxVersion"

function Get-Hostname([string]$Name) { "$Name.api.copal.run" }

function Get-Users([object]$ServerCredentials) {
  $users = @(
    [ordered]@{
      username = [string]$ServerCredentials.username
      password = [string]$ServerCredentials.password
    }
  )
  foreach ($pair in @($ServerCredentials.pool)) {
    $users += [ordered]@{
      username = [string]$pair.username
      password = [string]$pair.password
    }
  }
  @($users | Where-Object { $_.username -and $_.password })
}

function New-ServerConfig([string]$Hostname, [array]$Users) {
  $provider = if ($Staging) {
    "https://acme-staging-v02.api.letsencrypt.org/directory"
  } else {
    "letsencrypt"
  }
  $config = [ordered]@{
    log = [ordered]@{ level = "info"; timestamp = $true }
    inbounds = @(
      [ordered]@{
        type = "naive"
        tag = "naive-in"
        listen = "::"
        listen_port = 443
        # Native UDP/QUIC is deliberately disabled. Aura carries UDP inside the
        # authenticated HTTP/2 TCP tunnel via udp_over_tcp v2.
        network = "tcp"
        users = $Users
        tls = [ordered]@{
          enabled = $true
          server_name = $Hostname
          acme = [ordered]@{
            domain = @($Hostname)
            data_directory = "/var/lib/sing-box/acme"
            default_server_name = $Hostname
            email = $Email
            provider = $provider
          }
        }
      }
    )
    outbounds = @([ordered]@{ type = "direct"; tag = "direct" })
    route = [ordered]@{ final = "direct" }
  }
  $config | ConvertTo-Json -Depth 10
}

function Invoke-Ssh([string]$User, [string]$Ip, [string]$Command) {
  & ssh -i $SshKey -o StrictHostKeyChecking=accept-new "$User@$Ip" $Command
  if ($LASTEXITCODE -ne 0) { throw "SSH command failed on $Ip" }
}

function Install-Config([string]$User, [string]$Ip, [string]$Json) {
  $temporaryFile = New-TemporaryFile
  try {
    Set-Content -LiteralPath $temporaryFile -Value $Json -Encoding utf8NoBOM
    & scp -i $SshKey -o StrictHostKeyChecking=accept-new $temporaryFile "${User}@${Ip}:/tmp/aura-sing-box.json"
    if ($LASTEXITCODE -ne 0) { throw "config upload failed on $Ip" }
    Invoke-Ssh $User $Ip "sudo install -d -m 700 /etc/sing-box && sudo install -m 600 /tmp/aura-sing-box.json /etc/sing-box/config.json && rm -f /tmp/aura-sing-box.json"
  } finally {
    Remove-Item -LiteralPath $temporaryFile -Force -ErrorAction SilentlyContinue
  }
}

function Start-SingBox([string]$User, [string]$Ip) {
  $remote = @"
set -eu
image='$image'
sudo docker pull "`$image" >/dev/null
sudo docker run --rm -v /etc/sing-box:/etc/sing-box:ro "`$image" check -c /etc/sing-box/config.json

# Keep the stopped Caddy container as an immediate rollback target.
sudo docker rm -f aura-sing-box >/dev/null 2>&1 || true
sudo docker stop naive >/dev/null 2>&1 || true
sudo docker volume create sing-box-data >/dev/null

rollback() {
  sudo docker rm -f aura-sing-box >/dev/null 2>&1 || true
  sudo docker start naive >/dev/null 2>&1 || true
}
trap rollback EXIT

sudo docker run -d --name aura-sing-box --restart unless-stopped \
  -v /etc/sing-box:/etc/sing-box:ro \
  -v sing-box-data:/var/lib/sing-box \
  -p 80:80/tcp -p 443:443/tcp \
  "`$image" -D /var/lib/sing-box -C /etc/sing-box run >/dev/null

sleep 12
test "`$(sudo docker inspect -f '{{.State.Running}}' aura-sing-box 2>/dev/null)" = true
if sudo docker logs aura-sing-box 2>&1 | grep -Eiq 'FATAL|panic:'; then
  sudo docker logs aura-sing-box 2>&1 | tail -50
  exit 1
fi
trap - EXIT
"@
  Invoke-Ssh $User $Ip $remote
}

function Restore-Caddy([string]$User, [string]$Ip) {
  try {
    Invoke-Ssh $User $Ip "sudo docker rm -f aura-sing-box >/dev/null 2>&1 || true; sudo docker start naive >/dev/null 2>&1 || true"
  } catch {
    Write-Warning "automatic rollback also failed on $Ip; inspect both containers immediately"
  }
}

function Test-TcpProxy([string]$Name, [string]$ExpectedIp, [object]$Pair) {
  $hostname = Get-Hostname $Name
  $proxy = "https://$($Pair.username):$($Pair.password)@$hostname"
  $curlCommand = if (Get-Command curl.exe -ErrorAction SilentlyContinue) { "curl.exe" } else { "curl" }
  $actualIp = & $curlCommand -sS --max-time 25 --proxy $proxy https://api.ipify.org
  if ($LASTEXITCODE -ne 0 -or $actualIp -ne $ExpectedIp) {
    throw "TCP proxy test failed for $Name (expected $ExpectedIp, got '$actualIp')"
  }
}

$todo = @($servers.Keys | Where-Object { -not $Only -or $_ -in $Only })
if ($todo.Count -eq 0) { throw "no matching servers in $IpsFile" }

foreach ($name in $todo) {
  $ip = $servers[$name]
  $serverCredentials = $credentials.$name
  if (-not $serverCredentials) { throw "no credentials for $name" }
  $users = Get-Users $serverCredentials
  if ($users.Count -eq 0) { throw "no usable users for $name" }
  $sshUser = if ($sshUsers[$name]) { $sshUsers[$name] } else { "ubuntu" }

  Write-Host "=== $name ($ip): sing-box Naive + UoT v2 ===" -ForegroundColor Cyan
  $config = New-ServerConfig (Get-Hostname $name) $users
  Install-Config $sshUser $ip $config
  try {
    Start-SingBox $sshUser $ip
    Start-Sleep -Seconds 8
    Test-TcpProxy $name $ip $serverCredentials
  } catch {
    Write-Warning "sing-box validation failed on $name; restoring Caddy"
    Restore-Caddy $sshUser $ip
    throw
  }
  Write-Host "  $name is live on sing-box; Caddy remains stopped as container 'naive'" -ForegroundColor Green
}

Write-Host "`nServer migration complete. Reconnect Aura, then test a UDP-heavy app." -ForegroundColor Green
