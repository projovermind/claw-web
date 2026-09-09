<#
.SYNOPSIS
  윈도우(WSL2) claw-web 을 한 번에 되살린다 — 서비스·터널·포트포워딩·재부팅 대비까지.

.DESCRIPTION
  "https://win.subinggrae.cc 가 Error 1033" / "LAN 은 붙는데 응답이 없다" 상태를 고친다.

  하는 일:
    1. WSL 부팅 (재부팅 후엔 아무도 안 깨우면 꺼져 있다)
    2. 레포 최신화 — 옛 claw-web 은 터널 상주 등록이 macOS 전용이라 WSL 에서 실패했다
    3. claw-web 서비스 기동
    4. cloudflared 터널을 systemd 유닛으로 등록해 상주 (이게 없어서 1033 이 났다)
    5. netsh portproxy 갱신 — WSL IP 는 재부팅마다 바뀐다
    6. 로그온 작업 재등록 → 다음 재부팅부터는 알아서 복구
    7. LAN·터널 양쪽 실제 응답 확인

  몇 번을 돌려도 안전하다. 이미 된 단계는 건너뛴다.

.EXAMPLE
  # 관리자 PowerShell
  powershell -ExecutionPolicy Bypass -File .\claw-web-win-recover.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\claw-web-win-recover.ps1 -Hostname win.example.com
#>
[CmdletBinding()]
param(
  [string]$Hostname = '',                 # 비우면 WSL 의 config.yml 에서 읽는다
  [int]$Port        = 3838,
  [string]$Distro   = 'Ubuntu',
  [string]$RepoDir  = '~/claw-web',
  [switch]$SkipPull                        # 네트워크가 막혔을 때 git pull 건너뛰기
)

$ErrorActionPreference = 'Stop'
$TaskName = 'claw-web WSL'

function Info { param($m) Write-Host "    $m" }
function Ok   { param($m) Write-Host "    [OK] $m"  -ForegroundColor Green }
function Warn { param($m) Write-Host "    [!]  $m"  -ForegroundColor Yellow }
function Die  { param($m) Write-Host "    [X]  $m"  -ForegroundColor Red; exit 1 }
function Step { param($m) Write-Host ""; Write-Host "== $m" -ForegroundColor Cyan }

# WSL 출력은 UTF-16 이라 그냥 파이프하면 깨진다.
$prevEnc = [Console]::OutputEncoding
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Wsl {
  param([string]$Cmd)
  $out = & wsl.exe -d $Distro -- bash -lc $Cmd 2>&1
  return ($out | Out-String).Trim()
}
function WslOk {
  param([string]$Cmd)
  & wsl.exe -d $Distro -- bash -lc $Cmd *> $null
  return ($LASTEXITCODE -eq 0)
}

Write-Host ""
Write-Host "  claw-web 윈도우 복구" -ForegroundColor Cyan
Write-Host "  ────────────────────"

# ── 0. 관리자 확인 (netsh 에 필요) ───────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Die "관리자 PowerShell 에서 실행해야 한다 (포트포워딩·작업 등록에 필요)." }

# ── 1. WSL 깨우기 ────────────────────────────────────────
Step "1/7  WSL"
if (-not (WslOk 'true')) { Die "WSL 배포판 '$Distro' 에 접속할 수 없다. 'wsl -l -v' 로 이름을 확인하라." }
Ok "WSL '$Distro' 응답함"

if (-not (WslOk 'test -d /run/systemd/system')) {
  Warn "systemd 가 꺼져 있다 — /etc/wsl.conf 에 켜고 WSL 을 재시작한다"
  Wsl 'grep -q "systemd=true" /etc/wsl.conf 2>/dev/null || (printf "[boot]\nsystemd=true\n" | sudo tee -a /etc/wsl.conf >/dev/null)' | Out-Null
  & wsl.exe --shutdown
  Start-Sleep -Seconds 8
  if (-not (WslOk 'test -d /run/systemd/system')) { Die "systemd 활성화 실패. 'wsl --shutdown' 후 다시 시도하라." }
}
Ok "systemd 동작 중"

# 터미널을 닫아도 서비스가 유지되게
Wsl 'loginctl enable-linger $USER 2>/dev/null' | Out-Null

# ── 2. 레포 최신화 ───────────────────────────────────────
Step "2/7  레포 최신화"
if (-not (WslOk "test -d $RepoDir/.git")) { Die "$RepoDir 에 claw-web 레포가 없다." }
if ($SkipPull) {
  Warn "-SkipPull 지정 — 건너뜀"
} else {
  $pull = Wsl "cd $RepoDir && git pull --ff-only 2>&1 | tail -3"
  Info $pull
  # 의존성/빌드는 bootstrap 이 알아서 판단한다
  if (WslOk "test -f $RepoDir/scripts/win-bootstrap.sh") {
    Info "win-bootstrap 실행 중 (의존성·빌드·재시작)..."
    $bs = Wsl "cd $RepoDir && bash scripts/win-bootstrap.sh 2>&1 | tail -6"
    Info $bs
  }
  Ok "최신화 완료"
}

# ── 3. claw-web 서비스 ───────────────────────────────────
Step "3/7  claw-web 서비스"
Wsl 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user daemon-reload; systemctl --user enable --now claw-web' | Out-Null
Start-Sleep -Seconds 3
if (WslOk 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user is-active --quiet claw-web') {
  Ok "claw-web 실행 중"
} else {
  Warn (Wsl 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user status claw-web --no-pager -l | tail -12')
  Die "claw-web 서비스가 뜨지 않았다."
}

# ── 4. cloudflared 터널 상주 ─────────────────────────────
# 여기가 1033 의 원인이었다. 옛 자동터널은 ~/Library/LaunchAgents 에 plist 를
# 쓰려다 WSL 에서 죽었는데, 그 직전에 DNS 는 이미 새 터널로 돌려놓은 상태였다.
Step "4/7  cloudflared 터널"
if (-not (WslOk 'command -v cloudflared')) {
  Die "WSL 안에 cloudflared 가 없다. 먼저: bash $RepoDir/scripts/claw-web-cf-tunnel.sh <호스트명>"
}
if (-not (WslOk 'test -f ~/.cloudflared/cert.pem')) {
  Die "cloudflared 로그인이 안 돼 있다. 먼저: bash $RepoDir/scripts/claw-web-cf-tunnel.sh <호스트명>"
}

if (-not $Hostname) {
  $Hostname = Wsl "grep -m1 -oP 'hostname:\s*\K\S+' ~/.cloudflared/config.yml 2>/dev/null"
}
if (-not $Hostname) { Die "호스트명을 알 수 없다. -Hostname 으로 직접 지정하라 (예: win.subinggrae.cc)." }
Info "호스트명: $Hostname"

# 이 기계가 자격증명을 들고 있는 터널을 찾는다.
# 자격증명 파일 이름은 cloudflared 버전에 따라 <uuid>.json 이기도 하고 <이름>.json 이기도 해서
# 파일명으로 추측하지 않고, config.yml → tunnel list 순으로 확인한다.
$tinfo = Wsl @'
# 1) config.yml 에 적힌 것이 정본
cfg=~/.cloudflared/config.yml
id=$(sed -n 's/^tunnel:[[:space:]]*//p' "$cfg" 2>/dev/null | head -1)
cred=""
if [ -n "$id" ]; then
  for c in "$HOME/.cloudflared/$id.json" \
           "$(sed -n 's/^credentials-file:[[:space:]]*//p' "$cfg" 2>/dev/null | head -1)"; do
    [ -n "$c" ] && [ -f "$c" ] && { cred="$c"; break; }
  done
fi
# 2) 없으면 등록된 터널 중 자격증명 파일이 이 기계에 있는 것을 고른다.
#    파일 이름은 <uuid>.json 일 때도 <터널이름>.json 일 때도 있어서 둘 다 본다.
if [ -z "$cred" ]; then
  while read -r tid tname; do
    for c in "$HOME/.cloudflared/$tid.json" "$HOME/.cloudflared/$tname.json"; do
      [ -f "$c" ] && { id="$tid"; cred="$c"; break 2; }
    done
  done < <(cloudflared tunnel list 2>/dev/null \
           | awk 'NF>=2 && length($1)==36 && $1 ~ /-/ {print $1, $2}')
fi
echo "$id|$cred"
'@


$parts = ($tinfo -split '\|')
$tid   = $parts[0].Trim()
$tcred = if ($parts.Count -gt 1) { $parts[1].Trim() } else { '' }
if (-not $tid -or -not $tcred) {
  Die "이 기계에 터널 자격증명이 없다. 먼저: bash $RepoDir/scripts/claw-web-cf-tunnel.sh $Hostname"
}
Ok "터널 $tid"
Info "자격증명: $tcred"

# config.yml 과 systemd 유닛을 확실히 써둔다 (있으면 덮어쓴다 — 내용이 정본)
$mk = @"
set -e
CFB=`$(command -v cloudflared)
cat > ~/.cloudflared/config.yml <<EOF
tunnel: $tid
credentials-file: $tcred
protocol: http2

ingress:
  - hostname: $Hostname
    service: http://localhost:$Port
  - service: http_status:404
EOF
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/claw-web-tunnel.service <<EOF
[Unit]
Description=claw-web cloudflared tunnel
After=network.target

[Service]
Type=simple
ExecStart=`$CFB --no-autoupdate --config `$HOME/.cloudflared/config.yml tunnel run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
export XDG_RUNTIME_DIR=/run/user/`$(id -u)
# 옛 이름의 유닛이 남아 있으면 충돌하므로 정리
systemctl --user disable --now cloudflared 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable --now claw-web-tunnel
"@
Wsl $mk | Out-Null
Start-Sleep -Seconds 5

if (WslOk 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user is-active --quiet claw-web-tunnel') {
  Ok "터널 서비스 실행 중"
} else {
  Warn (Wsl 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user status claw-web-tunnel --no-pager -l | tail -15')
  Die "터널이 뜨지 않았다."
}

# DNS 를 이 터널로 돌린다. 옛 자동터널이 죽은 터널을 가리켜 놨을 수 있어서(=Error 1033)
# --overwrite-dns 로 강제한다. 이게 없으면 "record already exists" 만 나고 안 고쳐진다.
$route = Wsl "cloudflared tunnel route dns --overwrite-dns $tid $Hostname 2>&1 | tail -2"
if ($route -match 'success|Added|created|updated') { Ok "DNS → 이 터널" }
else { Warn "DNS 경로 확인 필요: $route" }

# ── 5. 포트포워딩 갱신 ───────────────────────────────────
# WSL IP 는 재부팅마다 바뀐다. 옛 규칙이 남아 있으면 TCP 는 붙는데 응답이 없다.
Step "5/7  LAN 포트포워딩"
$wslIp = (Wsl "hostname -I | awk '{print `$1}'")
if (-not $wslIp) { Die "WSL IP 를 못 읽었다." }
Info "WSL IP: $wslIp"
& netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=0.0.0.0 2>&1 | Out-Null
& netsh interface portproxy add v4tov4 listenport=$Port listenaddress=0.0.0.0 `
    connectport=$Port connectaddress=$wslIp 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Die "netsh portproxy 등록 실패" }
New-NetFirewallRule -DisplayName "claw-web $Port" -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort $Port -ErrorAction SilentlyContinue | Out-Null
Ok "0.0.0.0:$Port → ${wslIp}:$Port"

# ── 6. 로그온 작업 재등록 ────────────────────────────────
Step "6/7  재부팅 대비"
$self = $MyInvocation.MyCommand.Path
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$self`" -SkipPull -Hostname $Hostname -Port $Port -Distro $Distro"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$set     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $set -RunLevel Highest -Force | Out-Null
Ok "로그온 시 자동 복구 등록 ('$TaskName')"

# ── 7. 실제 확인 ─────────────────────────────────────────
Step "7/7  확인"
$localOk = WslOk "curl -fsS -m 8 http://localhost:$Port/api/health -o /dev/null"
if ($localOk) { Ok "WSL 내부 :$Port 응답" } else { Warn "WSL 내부 응답 없음" }

try {
  $r = Invoke-WebRequest -Uri "http://localhost:$Port/api/health" -TimeoutSec 10 -UseBasicParsing
  Ok "윈도우 → WSL 포트포워딩 응답 (HTTP $($r.StatusCode))"
} catch { Warn "윈도우에서 :$Port 응답 없음 — portproxy 확인 필요" }

Info "터널이 엣지에 붙는 데 10~20초 걸린다. 기다리는 중..."
$tunnelOk = $false
foreach ($i in 1..12) {
  Start-Sleep -Seconds 5
  try {
    $r = Invoke-WebRequest -Uri "https://$Hostname/api/health" -TimeoutSec 10 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $tunnelOk = $true; break }
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -and $code -ne 530) { $tunnelOk = $true; break }   # 인증 401 등은 도달했다는 뜻
  }
}

Write-Host ""
if ($tunnelOk) {
  Write-Host "  https://$Hostname  살아났다." -ForegroundColor Green
} else {
  Write-Host "  https://$Hostname  아직 응답 없음." -ForegroundColor Yellow
  Write-Host "  터널 로그:" -ForegroundColor Yellow
  Write-Host (Wsl 'export XDG_RUNTIME_DIR=/run/user/$(id -u); journalctl --user -u claw-web-tunnel -n 20 --no-pager')
}
Write-Host ""

[Console]::OutputEncoding = $prevEnc
