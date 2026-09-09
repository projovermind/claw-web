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
function WslRoot {
  param([string]$Cmd)
  $out = & wsl.exe -d $Distro -u root -- bash -lc (WslCmd $Cmd) 2>&1
  return (($out | Out-String) -replace "\x1b\[[0-9;]*[A-Za-z]", '').Trim()
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
  # 가동 시간이 매번 짧게 리셋돼 있으면 VM 이 계속 꺼지고 있다는 뜻이다.
  Write-Host (Wsl 'uptime -s; uptime -p; echo "systemd: $(test -d /run/systemd/system && echo yes || echo no)"; echo "앵커: $(ps -eo args= | grep -c "^/bin/sleep infinity") 개"')

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
Step "1/8  WSL"
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

# ── 2. WSL VM 을 붙잡아 둔다 ─────────────────────────────
# 여섯 번 반복된 실패의 진짜 원인이 여기였다. WSL2 는 마지막 세션이 끝나면
# VM 자체를 꺼버린다. systemd 도 cloudflared 도 같이 사라지므로, 스크립트가
# 도는 동안에는 멀쩡히 붙었다가 창을 닫으면 몇 십 초 뒤 죽는다.
# 사용자 로그가 이걸 증명한다: systemd 사용자 매니저 PID 가 294 → 284 로
# "줄었다". 한 번의 부팅 안에서 PID 는 줄어들 수 없다 = VM 이 새로 뜬 것.
# 그래서 절대 끝나지 않는 앵커 프로세스를 하나 물려 VM 을 열어둔다.
Step "2/8  WSL 상주 고정"
$anchorUp = (Wsl "ps -eo args= 2>/dev/null | grep -c '^/bin/sleep infinity'")
if ($anchorUp -notmatch '^[1-9]') {
  Start-Process -FilePath 'wsl.exe' `
    -ArgumentList @('-d', $Distro, '-u', 'root', '--exec', '/bin/sleep', 'infinity') `
    -WindowStyle Hidden
  Start-Sleep -Seconds 3
  $anchorUp = (Wsl "ps -eo args= 2>/dev/null | grep -c '^/bin/sleep infinity'")
}
if ($anchorUp -match '^[1-9]') { Ok "앵커 동작 중 — 창을 닫아도 VM 이 살아 있다" }
else { Warn "앵커가 뜨지 않았다 — 창을 닫으면 터널이 같이 죽을 수 있다" }

# 로그온할 때마다 앵커를 다시 세운다 (재부팅 대비)
$anchorTask = "$TaskName anchor"
try {
  Unregister-ScheduledTask -TaskName $anchorTask -Confirm:$false -ErrorAction SilentlyContinue
  $aAct = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -Command `"wsl.exe -d $Distro -u root --exec /bin/sleep infinity`""
  $aSet = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $anchorTask -Action $aAct `
    -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Settings $aSet -Force | Out-Null
  Ok "로그온 시 앵커 자동 기동 등록 ('$anchorTask')"
} catch { Warn "앵커 작업 등록 실패: $($_.Exception.Message)" }


# ── 3. 레포 최신화 ───────────────────────────────────────
Step "3/8  레포 최신화"
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

# ── 4. claw-web 서비스 ───────────────────────────────────
Step "4/8  claw-web 서비스"
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

# ── 5. cloudflared 터널 상주 ─────────────────────────────
# 여기가 1033 의 원인이었다. 옛 자동터널은 ~/Library/LaunchAgents 에 plist 를
# 쓰려다 WSL 에서 죽었는데, 그 직전에 DNS 는 이미 새 터널로 돌려놓은 상태였다.
Step "5/8  cloudflared 터널"
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

# WSL2 의 경로 MTU 가 깨져 있으면 큰 패킷이 조용히 사라진다.
# cloudflared 의 TLS 핸드셰이크가 오류 없이 멈추는 원인이라, 1400 으로 낮추고
# root systemd 유닛으로 재부팅 뒤에도 유지되게 한다.
$mtu = WslRoot @'
cur=$(cat /sys/class/net/eth0/mtu 2>/dev/null || echo 0)
[ "$cur" = 0 ] && { echo "eth0 MTU 를 못 읽었다 — 건드리지 않는다"; exit 0; }
if [ "$cur" -le 1400 ] 2>/dev/null; then echo "MTU $cur — 그대로 둔다"; exit 0; fi
ip link set dev eth0 mtu 1400 2>/dev/null || { echo "MTU 변경 실패 (현재 $cur)"; exit 0; }
cat > /etc/systemd/system/claw-web-mtu.service <<EOF
[Unit]
Description=claw-web — lower eth0 MTU for cloudflared
After=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/sbin/ip link set dev eth0 mtu 1400

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload 2>/dev/null
systemctl enable claw-web-mtu >/dev/null 2>&1
echo "MTU $cur → 1400 (재부팅 뒤에도 유지)"
'@
Info $mtu

# 엣지에 TCP 로 닿기는 하는지 (핸드셰이크 이전 단계 확인)
$edge = Wsl @'
T=""; command -v timeout >/dev/null 2>&1 && T="timeout 6"
for ip in 198.41.200.233 198.41.192.7; do
  if $T bash -c "exec 3<>/dev/tcp/$ip/7844" 2>/dev/null; then
    echo "엣지 $ip:7844 연결됨"
  else
    echo "엣지 $ip:7844 연결 안 됨"
  fi
done
'@
Info $edge

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
# Go 1.24+ 는 TLS ClientHello 에 X25519MLKEM768(양자내성) 키를 실어서 1.7KB 가 넘는다.
# WSL2 는 경로 MTU 가 깨져 있어 그 두 번째 패킷이 조용히 사라지고, 핸드셰이크가
# 오류도 없이 멈춘다. 실제로 'curve preferences' 다음 줄이 영영 안 나왔다.
Environment=GODEBUG=tlsmlkem=0
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

# ── 실제로 엣지에 등록되는 조합을 찾는다 ────────────────
# 이 기계 안에서 패킷을 볼 수 없으니 추측하지 않는다.
# 조합을 하나씩 걸어보고 저널에 'Registered tunnel connection' 이 뜨는지로 판정한다.
# 뜨면 그 설정을 그대로 남기고 멈춘다.
Info "엣지에 등록되는 설정을 찾는 중 (조합당 최대 40초)..."
$ladder = Wsl @'
export XDG_RUNTIME_DIR=/run/user/$(id -u)
U="$HOME/.config/systemd/user/claw-web-tunnel.service"
CFB=$(command -v cloudflared)

write_unit() {   # $1 = Environment 줄(없으면 빈 문자열), $2 = ExecStart 추가 인자
  mkdir -p "$(dirname "$U")"
  cat > "$U" <<EOF
[Unit]
Description=claw-web cloudflared tunnel
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
$1
ExecStart=$CFB --no-autoupdate --config $HOME/.cloudflared/config.yml $2 tunnel run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
}

attempt() {      # $1 = 설명, $2 = Environment 줄, $3 = 추가 인자
  write_unit "$2" "$3"
  t0=$(date +%s)
  systemctl --user restart claw-web-tunnel 2>/dev/null
  for _ in $(seq 1 40); do
    if journalctl --user -u claw-web-tunnel --since "@$t0" --no-pager 2>/dev/null \
       | grep -q "Registered tunnel connection"; then
      echo "OK|$1"; return 0
    fi
    sleep 1
  done
  echo "  실패: $1"
  return 1
}

attempt "기본"                        ""                                ""      && exit 0
attempt "양자내성 키 끄기"            "Environment=GODEBUG=tlsmlkem=0"  ""      && exit 0
attempt "양자내성 끄기 + IPv4 고정"   "Environment=GODEBUG=tlsmlkem=0"  "--edge-ip-version 4" && exit 0
attempt "QUIC 로 전환"                "Environment=GODEBUG=tlsmlkem=0"  "--protocol quic"     && exit 0
echo "NONE|어떤 조합으로도 등록되지 않았다"
'@

$hit = ($ladder -split "`n" | Where-Object { $_ -match '^(OK|NONE)\|' } | Select-Object -Last 1)
($ladder -split "`n" | Where-Object { $_ -match '^\s+실패' }) | ForEach-Object { Info $_.Trim() }

if ($hit -match '^OK\|(.+)$') {
  Ok "터널 등록됨 — 설정: $($Matches[1])"
} else {
  Warn "어떤 조합으로도 엣지에 등록되지 않았다. 아래 증거를 보라."
  Write-Host (Wsl @'
echo "--- eth0 MTU: $(cat /sys/class/net/eth0/mtu 2>/dev/null)"
echo "--- ping 으로 확인한 실제 경로 MTU:"
found=""
for s in 1472 1420 1372 1272 1172 972; do
  if ping -M do -s $s -c 1 -W 3 1.1.1.1 >/dev/null 2>&1; then found=$((s+28)); break; fi
done
echo "    ${found:-측정 불가 (ICMP 차단일 수 있다)}"
echo "--- 엣지 :7844 로 평범한 TLS (작은 ClientHello) 가 되는지:"
if command -v openssl >/dev/null 2>&1; then
  timeout 15 openssl s_client -connect 198.41.200.233:7844 </dev/null 2>&1     | grep -m2 -E "CONNECTED|Cipher is|verify error|errno" || echo "    응답 없음"
else
  echo "    openssl 없음"
fi
echo "--- 터널 로그 마지막 25줄:"
export XDG_RUNTIME_DIR=/run/user/$(id -u)
journalctl --user -u claw-web-tunnel -n 25 --no-pager -o short-iso
'@)
  Die "터널 등록 실패 — 위 증거를 그대로 보여주면 원인을 짚겠다."
}

# DNS 를 이 터널로 돌린다. 옛 자동터널이 죽은 터널을 가리켜 놨을 수 있어서(=Error 1033)
# --overwrite-dns 로 강제한다. 이게 없으면 "record already exists" 만 나고 안 고쳐진다.
$route = Wsl "cloudflared tunnel route dns --overwrite-dns $tid $Hostname 2>&1 | tail -2"
if ($route -match 'success|Added|created|updated|already configured') { Ok "DNS → 이 터널" }
else { Warn "DNS 경로 확인 필요: $route" }

# ── 6. 포트포워딩 갱신 ───────────────────────────────────
# WSL IP 는 재부팅마다 바뀐다. 옛 규칙이 남아 있으면 TCP 는 붙는데 응답이 없다.
Step "6/8  LAN 포트포워딩"
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

# ── 7. 로그온 작업 재등록 ────────────────────────────────
Step "7/8  재부팅 대비"
$self = $MyInvocation.MyCommand.Path
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$self`" -SkipPull -Hostname $Hostname -Port $Port -Distro $Distro"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$set     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $set -RunLevel Highest -Force | Out-Null
Ok "로그온 시 자동 복구 등록 ('$TaskName')"

# ── 8. 실제 확인 ─────────────────────────────────────────
Step "8/8  확인"
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

# 여기가 핵심 검증이다. 지금부터 90초 동안 wsl.exe 를 단 한 번도 부르지 않는다.
# 앵커가 제대로 물려 있지 않으면 이 사이에 VM 이 꺼지면서 터널이 같이 죽는다.
# 즉 이 확인을 통과했다는 건 "창을 닫아도 살아 있다" 를 실제로 증명한 것이다.
if ($tunnelOk) {
  Info "90초 동안 WSL 을 건드리지 않고 그대로 둔다 (창을 닫은 것과 같은 상태)..."
  Start-Sleep -Seconds 90
  $tunnelOk = $false
  try {
    $r = Invoke-WebRequest -Uri "https://$Hostname/api/health" -TimeoutSec 10 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $tunnelOk = $true }
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -and $code -ne 530) { $tunnelOk = $true }
  }
  if ($tunnelOk) { Ok "손 떼고 90초 뒤에도 살아 있다 — 창을 닫아도 유지된다" }
  else { Warn "손 떼자마자 죽었다 = VM 이 꺼진 것이다. 앵커 상태를 아래에서 보라" }
}

Write-Host ""
if ($tunnelOk) {
  Write-Host "  https://$Hostname  살아났다." -ForegroundColor Green
} else {
  Write-Host "  https://$Hostname  아직 응답 없음." -ForegroundColor Yellow
  Write-Host "  WSL 앵커 / 가동시간:" -ForegroundColor Yellow
  Write-Host (Wsl 'echo "앵커 $(ps -eo args= | grep -c "^/bin/sleep infinity") 개, uptime $(cut -d. -f1 /proc/uptime)초"')
  Write-Host "  MTU:" -ForegroundColor Yellow
  Write-Host (Wsl 'echo "eth0 mtu = $(cat /sys/class/net/eth0/mtu 2>/dev/null)"')
  Write-Host "  터널 유닛 상태:" -ForegroundColor Yellow
  Write-Host (Wsl 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user status claw-web-tunnel --no-pager -l | head -12')
  Write-Host "  터널 로그 (최근 40줄):" -ForegroundColor Yellow
  Write-Host (Wsl 'export XDG_RUNTIME_DIR=/run/user/$(id -u); journalctl --user -u claw-web-tunnel -n 40 --no-pager -o short-iso')
}
Write-Host ""

[Console]::OutputEncoding = $prevEnc
