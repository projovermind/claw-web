#Requires -RunAsAdministrator
<#
  claw-web WSL2 원클릭 설정 (Windows 측에서 관리자 PowerShell 로 실행)

    powershell -ExecutionPolicy Bypass -File .\claw-web-wsl-setup.ps1

  하는 일:
    1. WSL 에 systemd 활성화 (/etc/wsl.conf) + 필요 시 재시작
    2. claw-web 을 systemd --user 서비스로 등록 (터미널 닫아도 유지, 죽으면 자동 재시작)
    3. WSL NAT IP → 윈도우 0.0.0.0:3838 포트포워딩 + 방화벽 인바운드 허용
    4. 로그온 시 WSL 을 깨우고 포트포워딩을 다시 잡는 예약 작업 등록
       (WSL IP 는 재시작마다 바뀌므로 이 갱신이 없으면 다른 기기에서 접속이 끊긴다)

  -Refresh  : 예약 작업이 쓰는 모드. 포트포워딩만 다시 잡는다.
#>
param(
  [switch]$Refresh,
  [string]$Distro = '',
  [int]$Port = 3838,
  [string]$RepoDir = '~/claw-web'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$TaskName    = 'claw-web WSL'
$FirewallRule = "claw-web $Port"
$InstalledDir = Join-Path $env:ProgramData 'claw-web'
$InstalledPs1 = Join-Path $InstalledDir 'claw-web-wsl-setup.ps1'

function Info { param($m) Write-Host "  $m" }
function Ok   { param($m) Write-Host "  [OK] $m"   -ForegroundColor Green }
function Warn { param($m) Write-Host "  [!] $m"    -ForegroundColor Yellow }
function Die  { param($m) Write-Host "  [X] $m"    -ForegroundColor Red; exit 1 }
function Step { param($m) Write-Host ""; Write-Host "== $m" -ForegroundColor Cyan }

# ── WSL 헬퍼 ────────────────────────────────────────────
# 로그인 셸(-lc)로 실행해야 nvm PATH 가 잡힌다.
# ⚠️ Windows PowerShell 5.1 은 네이티브 exe 로 인자를 넘길 때 따옴표를 뭉갠다.
# bash 안의 따옴표가 사라지면 명령이 깨지고, 아래 2>&1 때문에 그 오류 텍스트가
# 반환값에 섞인다. 실제로 그 찌꺼기가 claw-web.service 의 PATH 줄에 박혀
# systemd 가 "Unknown key '+ try { $out'" 를 뱉는 사고가 났다.
# base64 로 감싸 전선에 따옴표를 아예 안 태운다.
function WslCmd {
  param([string]$Cmd)
  $lf  = $Cmd -replace "`r`n", "`n"
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($lf))
  return "echo $b64 | base64 -d | bash"
}
function Wsl {
  param([string]$Cmd, [switch]$AsRoot)
  $a = @()
  if ($Distro) { $a += @('-d', $Distro) }
  if ($AsRoot) { $a += @('-u', 'root') }
  $a += @('-e', 'bash', '-lc', (WslCmd $Cmd))
  # Windows PowerShell 5.1 은 네이티브 stderr 를 ErrorRecord 로 만들어서
  # $ErrorActionPreference='Stop' 이면 경고 한 줄에도 스크립트가 죽는다.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & wsl.exe @a 2>$null } finally { $ErrorActionPreference = $prev }
  # ANSI 색코드 제거. 그냥 두면 유닛 파일이나 콘솔에 제어문자가 새어 들어간다.
  return (($out | Out-String) -replace "\x1b\[[0-9;]*[A-Za-z]", '').Trim()
}

function WslOk {
  param([string]$Cmd, [switch]$AsRoot)
  $null = Wsl -Cmd $Cmd -AsRoot:$AsRoot
  return ($LASTEXITCODE -eq 0)
}

# ── 포트포워딩 (설치·갱신 공통) ─────────────────────────
function Set-PortProxy {
  $ip = (Wsl 'hostname -I' ) -split '\s+' | Where-Object { $_ -match '^\d+\.' } | Select-Object -First 1
  if (-not $ip) { Die 'WSL IP 를 못 읽었습니다. WSL 이 떠 있는지 확인하세요.' }

  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=0.0.0.0 2>&1 | Out-Null
    & netsh interface portproxy add v4tov4 listenport=$Port listenaddress=0.0.0.0 `
        connectport=$Port connectaddress=$ip 2>&1 | Out-Null
    $rc = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
  if ($rc -ne 0) { Die "netsh portproxy 등록 실패 (관리자 권한인지 확인)" }

  if (-not (Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $FirewallRule -Direction Inbound `
      -LocalPort $Port -Protocol TCP -Action Allow | Out-Null
  }
  return $ip
}

# ── -Refresh: 로그온 시 호출되는 경량 경로 ──────────────
if ($Refresh) {
  $null = Wsl 'true'                      # 배포판 부팅 (linger 로 서비스가 따라 올라옴)
  for ($i = 0; $i -lt 30; $i++) {
    if (WslOk 'systemctl --user is-active --quiet claw-web') { break }
    Start-Sleep -Seconds 2
  }
  $ip = Set-PortProxy
  Write-Host "claw-web portproxy -> ${ip}:${Port}"
  exit 0
}

# ═══════════════════════════════════════════════════════
Write-Host ""
Write-Host " claw-web WSL 설정" -ForegroundColor White
Write-Host ""

# ── 1. 사전 확인 ────────────────────────────────────────
Step '사전 확인'

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { Die 'WSL 이 설치되어 있지 않습니다.' }

$whoami = Wsl 'whoami'
if ($LASTEXITCODE -ne 0 -or -not $whoami) { Die "WSL 배포판에 접속할 수 없습니다: $whoami" }
Ok "WSL 사용자: $whoami"

$repo = Wsl "cd $RepoDir 2>/dev/null && pwd"
if (-not $repo) { Die "$RepoDir 를 찾을 수 없습니다. -RepoDir 로 경로를 지정하세요." }
Ok "claw-web: $repo"

$node = Wsl 'command -v node'
if (-not $node) { Die 'WSL 안에서 node 를 찾을 수 없습니다.' }
Ok "node: $node ($(Wsl 'node -v'))"

$cfgExists = WslOk "test -f $RepoDir/data/private/web-config.json"
if (-not $cfgExists) { Warn 'data/private/web-config.json 이 없습니다 — 서버가 기본값으로 시드합니다.' }

# ── 2. systemd 활성화 ───────────────────────────────────
Step 'systemd 활성화'

$init = Wsl 'ps -p 1 -o comm='
if ($init -match 'systemd') {
  Ok 'systemd 이미 활성'
} else {
  Info "현재 init: $init — /etc/wsl.conf 수정 후 WSL 을 재시작합니다"
  $null = Wsl -AsRoot @'
set -e
touch /etc/wsl.conf
if grep -q '^\s*systemd\s*=' /etc/wsl.conf; then
  sed -i 's/^\s*systemd\s*=.*/systemd=true/' /etc/wsl.conf
elif grep -q '^\[boot\]' /etc/wsl.conf; then
  sed -i '/^\[boot\]/a systemd=true' /etc/wsl.conf
else
  printf '\n[boot]\nsystemd=true\n' >> /etc/wsl.conf
fi
'@
  if ($LASTEXITCODE -ne 0) { Die '/etc/wsl.conf 수정 실패' }

  Info 'wsl --shutdown ...'
  & wsl.exe --shutdown | Out-Null
  Start-Sleep -Seconds 8

  $init = ''
  for ($i = 0; $i -lt 15; $i++) {
    $init = Wsl 'ps -p 1 -o comm='
    if ($init -match 'systemd') { break }
    Start-Sleep -Seconds 2
  }
  if ($init -notmatch 'systemd') {
    Die "systemd 가 올라오지 않았습니다 (init=$init). WSL 버전이 오래됐을 수 있습니다: wsl --update"
  }
  Ok 'systemd 활성화됨'
}

# ── 3. 서비스 등록 ──────────────────────────────────────
Step 'claw-web 서비스 등록'

$null = Wsl 'pkill -f "node server/index.js" || true'   # 포그라운드로 돌던 인스턴스 정리

# 경로는 전부 WSL 쪽에서 뽑는다 (PowerShell 의 Split-Path 는 구분자를 \ 로 바꿔버린다)
$nodeDir = Wsl 'dirname "$(command -v node)"'
$home_   = Wsl 'echo $HOME'
$unit = @"
[Unit]
Description=Claw Web
After=network.target

[Service]
Type=simple
WorkingDirectory=$repo
Environment=NODE_ENV=production
Environment=PATH=${nodeDir}:${home_}/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$node $repo/server/index.js
Restart=always
RestartSec=3
StandardOutput=append:$repo/data/user/logs/claw-web.log
StandardError=append:$repo/data/user/logs/claw-web.err.log

[Install]
WantedBy=default.target
"@

# LF 로 써야 systemd 가 읽는다 (CRLF 면 unit 파싱 실패)
$tmp = Join-Path $env:TEMP 'claw-web.service'
[IO.File]::WriteAllText($tmp, ($unit -replace "`r`n", "`n"), (New-Object Text.UTF8Encoding $false))
$tmpWsl = (& wsl.exe -e wslpath -a "$tmp").Trim()

$null = Wsl "mkdir -p ~/.config/systemd/user $RepoDir/data/user/logs && cp '$tmpWsl' ~/.config/systemd/user/claw-web.service"
if ($LASTEXITCODE -ne 0) { Die 'unit 파일 설치 실패' }
Remove-Item $tmp -Force -ErrorAction SilentlyContinue

$null = Wsl 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user daemon-reload && systemctl --user enable --now claw-web'
if ($LASTEXITCODE -ne 0) {
  Warn '서비스 시작 실패 — 로그:'
  Info (Wsl 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user status claw-web --no-pager -l | tail -20')
  Die '위 로그를 확인하세요.'
}

# 터미널을 다 닫아도 사용자 서비스가 살아있게
$null = Wsl -AsRoot "loginctl enable-linger $whoami"
Ok '서비스 등록 완료 (자동 재시작 · linger 활성)'

# ── 4. 포트포워딩 ───────────────────────────────────────
Step '포트포워딩 · 방화벽'

$wslIp = Set-PortProxy
Ok "WSL ${wslIp}:${Port} -> 0.0.0.0:${Port}"
Ok "방화벽 인바운드 허용: $FirewallRule"

# ── 5. 로그온 시 자동 갱신 ──────────────────────────────
Step '자동 시작 예약 작업'

New-Item -ItemType Directory -Force -Path $InstalledDir | Out-Null
Copy-Item -Path $PSCommandPath -Destination $InstalledPs1 -Force

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$InstalledPs1`" -Refresh"
$me      = "$env:USERDOMAIN\$env:USERNAME"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
$princ   = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Highest
$set     = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $princ -Settings $set -Force | Out-Null
Ok "예약 작업 '$TaskName' 등록 (로그온 시 WSL 기동 + 포트포워딩 갱신)"

# ── 6. 확인 ─────────────────────────────────────────────
Step '확인'

$health = $null
for ($i = 0; $i -lt 15; $i++) {
  try {
    $health = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$Port/api/health").Content
    break
  } catch { Start-Sleep -Seconds 2 }
}
if (-not $health) {
  Warn "http://127.0.0.1:$Port/api/health 응답 없음. 로그 확인:"
  Info "  wsl tail -30 $RepoDir/data/user/logs/claw-web.err.log"
  exit 1
}
Ok "health: $health"

$lanIp = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.InterfaceAlias -notmatch 'WSL|Loopback' } |
  Select-Object -First 1).IPAddress

Write-Host ""
Write-Host " 완료" -ForegroundColor Green
Write-Host ""
Write-Host "  이 PC:        http://localhost:$Port"
if ($lanIp) { Write-Host "  다른 기기에서: http://${lanIp}:${Port}   <- claw-web '기기 추가' 에 넣을 URL" }
Write-Host ""
Write-Host "  상태:  wsl systemctl --user status claw-web"
Write-Host "  로그:  wsl journalctl --user -u claw-web -f"
Write-Host "  중지:  wsl systemctl --user stop claw-web"
Write-Host ""
