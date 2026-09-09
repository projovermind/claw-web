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

.NOTES
  이 파일은 반드시 **UTF-8 BOM** 으로 저장해야 한다.
  Windows PowerShell 5.1 은 BOM 이 없으면 .ps1 을 시스템 코드페이지(한국어 = CP949)로 읽는다.
  그러면 한글 주석·문자열이 깨지면서 따옴표와 중괄호가 어긋나 ParserError 로 죽는다.
#>
[CmdletBinding()]
param(
  [string]$Hostname = '',                 # 비우면 WSL 의 config.yml 에서 읽는다
  [int]$Port        = 3838,
  [string]$Distro   = 'Ubuntu',
  [string]$RepoDir  = '~/claw-web',
  [switch]$SkipPull,                       # 네트워크가 막혔을 때 git pull 건너뛰기
  [switch]$Diagnose                        # 고치지 않고 지금 상태만 뽑아본다
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

# ⚠️ Windows PowerShell 5.1 은 네이티브 exe 로 인자를 넘길 때 따옴표를 뭉갠다.
# bash 안의 작은따옴표가 사라지면 awk '{print $1}' 의 $1 이 bash 위치인자로 해석돼
# 빈 문자열이 된다 (실제로 `awk: NF>=2 && length()==36` 로 깨졌다).
# 그래서 스크립트를 base64 로 감싸 전선에는 따옴표를 아예 안 태운다.
function WslCmd {
  param([string]$Cmd)
  $lf  = $Cmd -replace "`r`n", "`n"          # CRLF 로 저장돼도 bash 가 안 깨지게
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($lf))
  return "echo $b64 | base64 -d | bash"
}
function Wsl {
  param([string]$Cmd)
  $out = & wsl.exe -d $Distro -- bash -lc (WslCmd $Cmd) 2>&1
  # ANSI 색코드를 걷어낸다. 그냥 두면 레거시 콘솔에서 글자가 겹쳐 찍힌다.
  return (($out | Out-String) -replace "\x1b\[[0-9;]*[A-Za-z]", '').Trim()
}
function WslOk {
  param([string]$Cmd)
  & wsl.exe -d $Distro -- bash -lc (WslCmd $Cmd) *> $null
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

# ── 진단만 (-Diagnose) ───────────────────────────────────
# "됐다고 했는데 잠시 뒤 또 죽었다" 를 추측으로 고치지 않기 위한 모드.
# 아무것도 바꾸지 않고 지금 상태만 찍는다.
if ($Diagnose) {
  Step "진단"
  Info "WSL 부팅 시각 / 가동 시간"
  Write-Host (Wsl 'uptime -s; uptime -p; echo "systemd: $(test -d /run/systemd/system && echo yes || echo no)"')

  Info "서비스 상태"
  Write-Host (Wsl 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user list-units --no-pager --no-legend "claw-web*" ; echo "--- linger:"; loginctl show-user $USER -p Linger 2>/dev/null')

  Info "터널 유닛"
  Write-Host (Wsl 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user status claw-web-tunnel --no-pager -l | head -20')

  Info "터널 로그 (최근 40줄)"
  Write-Host (Wsl 'export XDG_RUNTIME_DIR=/run/user/$(id -u); journalctl --user -u claw-web-tunnel -n 40 --no-pager -o short-iso')

  Info "claw-web 로그 (최근 15줄)"
  Write-Host (Wsl 'export XDG_RUNTIME_DIR=/run/user/$(id -u); journalctl --user -u claw-web -n 15 --no-pager -o short-iso')

  Info "레포 상태"
  Write-Host (Wsl "cd $RepoDir 2>/dev/null && git log --oneline -3 && echo '--- origin 과의 차이:' && git rev-list --left-right --count HEAD...origin/main 2>/dev/null && echo '--- 로컬 수정:' && git status --short --untracked-files=no | head -10")

  Info "로컬 응답"
  Write-Host (Wsl "curl -s -o /dev/null -w 'WSL localhost:$Port -> %{http_code}\n' -m 5 http://localhost:$Port/api/health")

  Info "포트포워딩"
  & netsh interface portproxy show v4tov4
  [Console]::OutputEncoding = $prevEnc
  exit 0
}

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
  # 먼저 fast-forward 를 직접 뚫는다.
  # 기계에 있는 bootstrap 은 낡은 판이라 이 상황을 못 푼다 — pull 이 막혀 있으니
  # 고친 bootstrap 을 받으려면 pull 이 돼야 하는 순환에 빠진다. 그래서 여기서 끊는다.
  $ff = Wsl @'
cd "$HOME/claw-web" 2>/dev/null || exit 0
git fetch origin main --quiet 2>/dev/null || { echo "fetch 실패"; exit 0; }
ahead=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo 0)
behind=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)
if [ "$ahead" != 0 ]; then echo "로컬 전용 커밋 $ahead 개 — 손대지 않는다"; exit 0; fi
[ "$behind" = 0 ] && { echo "이미 최신"; exit 0; }
if ! err=$(git merge --ff-only origin/main 2>&1); then
  # 병합을 막는 파일만 골라 .bak 으로 남기고 되돌린다 (거의 항상 package-lock.json).
  blocked=$(printf '%s\n' "$err" | sed -n '/would be overwritten by merge/,/^Please/p' \
            | sed -n 's/^\t\(.*\)$/\1/p')
  [ -z "$blocked" ] && { printf '%s\n' "$err" | tail -3; exit 0; }
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    cp "$f" "$f.local-$(date +%Y%m%d-%H%M%S).bak" 2>/dev/null && echo "$f 보관 후 되돌림"
    git checkout -- "$f" 2>/dev/null || true
  done <<< "$blocked"
  git merge --ff-only origin/main >/dev/null 2>&1 || { echo "fast-forward 여전히 불가"; exit 0; }
fi
echo "$behind 커밋 최신화 → $(git rev-parse --short HEAD)"
'@
  Info $ff

  if (WslOk "test -f $RepoDir/scripts/win-bootstrap.sh") {
    Info "win-bootstrap 실행 중 (의존성·빌드·재시작)..."
    $bsOk = WslOk "cd $RepoDir && bash scripts/win-bootstrap.sh > /tmp/claw-recover-bootstrap.log 2>&1"
    Info (Wsl 'tail -8 /tmp/claw-recover-bootstrap.log')
    if ($bsOk) { Ok "최신화 완료" }
    # 최신화가 막혀도 터널 복구는 이 스크립트가 직접 하므로 계속 간다.
    else { Warn "최신화 실패 — 옛 코드 그대로 두고 복구는 계속한다" }
  } else {
    $pull = Wsl "cd $RepoDir && git pull --ff-only 2>&1 | tail -3"
    Info $pull
  }
}

# ── 3. claw-web 서비스 ───────────────────────────────────
Step "3/7  claw-web 서비스"
# 유닛 파일이 깨져 있을 수 있다. 옛 설치 스크립트가 PowerShell 오류 텍스트를
# 그대로 PATH 줄에 박아 넣은 사고가 있었다 (systemd: Unknown key '+ try { $out').
# systemd 문법에 안 맞는 줄이 하나라도 있으면 다시 쓴다.
$fix = Wsl @'
U="$HOME/.config/systemd/user/claw-web.service"
R="$HOME/claw-web"
if [ ! -f "$U" ]; then
  bad=999
else
  bad=$(grep -vcE '^[[:space:]]*($|#|\[|[A-Za-z][A-Za-z0-9]*=)' "$U" 2>/dev/null || true)
fi
[ "$bad" = 0 ] && { echo "유닛 정상"; exit 0; }
NODE=$(command -v node) || { echo "node 를 못 찾음"; exit 1; }
mkdir -p "$(dirname "$U")" "$R/data/user/logs"
cat > "$U" <<EOF
[Unit]
Description=Claw Web
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=$R
Environment=NODE_ENV=production
Environment=PATH=$(dirname "$NODE"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$NODE $R/server/index.js
Restart=always
RestartSec=3
StandardOutput=append:$R/data/user/logs/claw-web.log
StandardError=append:$R/data/user/logs/claw-web.err.log

[Install]
WantedBy=default.target
EOF
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user daemon-reload
systemctl --user restart claw-web 2>/dev/null || true
echo "깨진 줄 $bad 개 — 유닛을 다시 썼다"
'@
Info $fix
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
# 기본값(10초에 5회)에 걸리면 systemd 가 영영 포기한다. 터널은 끝까지 재시도해야 한다.
StartLimitIntervalSec=0

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
if ($route -match 'success|Added|created|updated|already configured') { Ok "DNS → 이 터널" }
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

# 붙자마자 죽는 경우가 있었다. 한 번 200 받았다고 끝내지 않고 60초 뒤 다시 본다.
if ($tunnelOk) {
  Info "60초 뒤 한 번 더 확인한다 (붙었다가 죽는 경우가 있었다)..."
  Start-Sleep -Seconds 60
  $tunnelOk = $false
  try {
    $r = Invoke-WebRequest -Uri "https://$Hostname/api/health" -TimeoutSec 10 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $tunnelOk = $true }
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -and $code -ne 530) { $tunnelOk = $true }
  }
  if ($tunnelOk) { Ok "60초 뒤에도 살아 있다" } else { Warn "붙었다가 다시 끊겼다 — 아래 로그를 보라" }
}

Write-Host ""
if ($tunnelOk) {
  Write-Host "  https://$Hostname  살아났다." -ForegroundColor Green
} else {
  Write-Host "  https://$Hostname  아직 응답 없음." -ForegroundColor Yellow
  Write-Host "  터널 유닛 상태:" -ForegroundColor Yellow
  Write-Host (Wsl 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user status claw-web-tunnel --no-pager -l | head -12')
  Write-Host "  터널 로그 (최근 40줄):" -ForegroundColor Yellow
  Write-Host (Wsl 'export XDG_RUNTIME_DIR=/run/user/$(id -u); journalctl --user -u claw-web-tunnel -n 40 --no-pager -o short-iso')
}
Write-Host ""

[Console]::OutputEncoding = $prevEnc
