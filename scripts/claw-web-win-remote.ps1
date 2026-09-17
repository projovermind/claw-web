<#
.SYNOPSIS
  윈도우 claw-web 을 "로그인 없이도 살아 있는" 상태로 만든다 — 터널을 윈도우 네이티브 서비스로,
  그리고 맥에서 붙을 수 있는 SSH 원격 채널을 연다.

.DESCRIPTION
  claw-web-win-recover.ps1 은 고장을 고치는 스크립트다. 이건 구조를 바꾸는 스크립트다.

  재부팅 뒤에도 계속 Error 1033 이 나는 이유는 세 가지였다:
    1. 기존 자동기동 작업이 전부 -AtLogOn 이라, 재부팅만 하고 아무도 로그인하지 않으면
       WSL 도 터널도 뜨지 않는다.
    2. cloudflared 가 WSL 안 systemd 에 있어서, WSL2 VM 이 꺼지면 터널도 같이 죽는다.
    3. WSL IP 는 부팅마다 바뀌는데 netsh portproxy 가 낡아서, TCP 는 붙는데 HTTP 는 0바이트다.

  그래서 이 스크립트는:
    (a) 터널을 WSL 밖으로 꺼내 윈도우 네이티브 서비스(SYSTEM, 자동시작)로 돌린다.
    (b) 윈도우 OpenSSH 서버를 터널에 실어 원격 채널을 연다 — 이 기계에 손이 닿게 된다.
    (c) 모든 자동기동을 AtStartup 으로 바꿔 로그인을 불필요하게 만든다.

  claw-web 서비스 자체는 계속 WSL 안에서 돈다. 바뀌는 건 "누가 무엇을 붙잡고 있느냐" 뿐이다.
  몇 번을 돌려도 안전하다(이미 된 단계는 건너뛴다).

.EXAMPLE
  # 관리자 PowerShell — 붙여넣기 한 번으로 끝난다
  powershell -ExecutionPolicy Bypass -File .\claw-web-win-remote.ps1

.EXAMPLE
  # 아무것도 바꾸지 않고 지금 상태만 본다
  powershell -ExecutionPolicy Bypass -File .\claw-web-win-remote.ps1 -Diagnose

.NOTES
  이 파일은 반드시 **UTF-8 BOM** 으로 저장해야 한다.
  Windows PowerShell 5.1 은 BOM 이 없으면 .ps1 을 시스템 코드페이지(한국어 = CP949)로 읽는다.
  그러면 한글 주석·문자열이 깨지면서 따옴표와 중괄호가 어긋나 ParserError 로 죽는다.

  새 터널을 만들거나 DNS 를 건드리지 않는다. 맥에서 이미 아래 터널로 라우팅해 뒀고,
  이 기계는 그 터널의 자격증명을 들고 있는 유일한 기계다. 추측해서 새로 만들면 DNS 가 어긋난다.
#>
[CmdletBinding()]
param(
  [string]$Hostname    = 'win.example.com',
  [string]$SshHostname = 'ssh.win.example.com',
  [int]$Port           = 3838,
  [string]$PubKey      = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILxG7ps1Aqqfw7+YZnmvWDVZJo8ymDX5KJCYgqGMDPfk clawweb-mac-to-win',
  [string]$TunnelId    = '10461111-e2eb-468f-bbb8-d7bf853dbf10',
  [string]$Distro      = '',                # 비우면 자동탐지
  [switch]$Diagnose                          # 고치지 않고 지금 상태만 뽑아본다
)

$ErrorActionPreference = 'Stop'

$CfDir       = 'C:\ProgramData\cloudflared'
$CfConfig    = Join-Path $CfDir 'config.yml'
$CfLog       = Join-Path $CfDir 'cloudflared.log'
$CfCred      = Join-Path $CfDir "$TunnelId.json"
$CfExeDir    = 'C:\Program Files\cloudflared'
# 서비스는 SYSTEM 으로 돈다. cloudflared 가 --config 없이 뜨면 SYSTEM 의 홈, 즉 여기를 본다.
# ProgramData 만 채워두면 서비스가 "설정 없음" 상태로 떠서 ingress 가 통째로 빈다.
$SysProfCfDir = Join-Path $env:SystemRoot 'System32\config\systemprofile\.cloudflared'
$StateDir    = 'C:\ProgramData\claw-web'
$IpFile      = Join-Path $StateDir 'wsl-ip.txt'
$AnchorPs1   = Join-Path $StateDir 'anchor.ps1'
$ProxyPs1    = Join-Path $StateDir 'portproxy.ps1'
$AnchorTask  = 'claw-web WSL anchor'
$ProxyTask   = 'claw-web portproxy'
$LegacyTasks = @('claw-web WSL')             # recover 스크립트가 걸어둔 -AtLogOn 작업

function Info { param($m) Write-Host "    $m" }
function Ok   { param($m) Write-Host "    [OK] $m"  -ForegroundColor Green }
function Warn { param($m) Write-Host "    [!]  $m"  -ForegroundColor Yellow }
function Die  { param($m) Write-Host "    [X]  $m"  -ForegroundColor Red; exit 1 }
function Step { param($m) Write-Host ""; Write-Host "== $m" -ForegroundColor Cyan }

# WSL 출력은 UTF-16 이라 그냥 파이프하면 깨진다.
$prevEnc = [Console]::OutputEncoding
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:WSL_UTF8 = '1'

# ⚠️ Windows PowerShell 5.1 은 네이티브 exe 로 인자를 넘길 때 따옴표를 뭉갠다.
# bash 안의 작은따옴표가 사라지면 awk '{print $1}' 의 $1 이 bash 위치인자로 해석돼
# 빈 문자열이 된다. 그래서 스크립트를 base64 로 감싸 전선에는 따옴표를 아예 안 태운다.
function WslCmd {
  param([string]$Cmd)
  $lf  = $Cmd -replace "`r`n", "`n"
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($lf))
  return "echo $b64 | base64 -d | bash"
}
function Wsl {
  param([string]$Cmd)
  $out = & wsl.exe -d $Distro -- bash -lc (WslCmd $Cmd) 2>&1
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

# BOM 없는 UTF-8 로 쓴다. config.yml / sshd_config / authorized_keys 는 BOM 이 붙으면
# 파서가 첫 줄을 통째로 못 읽는다 (sshd 는 "bad configuration" 으로 죽는다).
function Save-Text {
  param([string]$Path, [string]$Text, [switch]$Bom)
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $enc = New-Object System.Text.UTF8Encoding($Bom.IsPresent)
  [IO.File]::WriteAllText($Path, ($Text -replace "`r`n", "`n"), $enc)
}

function Get-WslDistro {
  $raw = & wsl.exe -l -q 2>$null
  $names = @()
  foreach ($line in $raw) {
    $n = ($line -replace "`0", '').Trim()      # WSL_UTF8 이 안 먹는 옛 빌드 대비
    if ($n -and $n -notmatch '^docker-desktop') { $names += $n }
  }
  if ($names -contains 'Ubuntu') { return 'Ubuntu' }
  if ($names.Count -ge 1) { return $names[0] }
  return ''
}

function Get-CloudflaredExe {
  foreach ($p in @(
    (Join-Path $CfExeDir 'cloudflared.exe'),
    "$env:ProgramFiles\cloudflared\cloudflared.exe",
    "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe"
  )) { if ($p -and (Test-Path $p)) { return $p } }
  $c = Get-Command cloudflared.exe -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  return ''
}

# 작업의 트리거 종류를 사람이 읽을 수 있게. MSFT_TaskBootTrigger = AtStartup,
# MSFT_TaskLogonTrigger = AtLogOn. 이 구분이 이 스크립트의 존재 이유다.
function Show-Tasks {
  $tasks = Get-ScheduledTask -TaskName 'claw-web*' -ErrorAction SilentlyContinue
  if (-not $tasks) { Info "등록된 claw-web 작업 없음"; return }
  foreach ($t in $tasks) {
    $trg = (@($t.Triggers | ForEach-Object {
      switch ($_.CimClass.CimClassName) {
        'MSFT_TaskBootTrigger'  { 'AtStartup' }
        'MSFT_TaskLogonTrigger' { 'AtLogOn' }
        default                 { $_.CimClass.CimClassName -replace '^MSFT_Task', '' }
      }
    }) -join ',')
    if (-not $trg) { $trg = '(트리거 없음)' }
    $usr = $t.Principal.UserId
    if ($t.Principal.LogonType) { $usr = "$usr/$($t.Principal.LogonType)" }
    Info ("{0,-22} {1,-9} {2,-12} {3}" -f $t.TaskName, $t.State, $trg, $usr)
  }
}

Write-Host ""
Write-Host "  claw-web 윈도우 원격화" -ForegroundColor Cyan
Write-Host "  ──────────────────────"

# ── 0. 관리자 확인 ───────────────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Die "관리자 PowerShell 에서 실행해야 한다 (서비스 등록·작업 스케줄러·netsh 에 필요)." }

if (-not $Distro) {
  $Distro = Get-WslDistro
  if (-not $Distro) { Die "WSL 배포판을 찾을 수 없다. 'wsl -l -v' 로 확인하고 -Distro 로 지정하라." }
}
Info "WSL 배포판: $Distro"

# ── 진단만 (-Diagnose) ───────────────────────────────────
# "됐다고 했는데 잠시 뒤 또 죽었다" 를 추측으로 고치지 않기 위한 모드. 아무것도 바꾸지 않는다.
if ($Diagnose) {
  Step "진단"

  Info "WSL 가동 시간 / 앵커"
  # 가동 시간이 매번 짧게 리셋돼 있으면 VM 이 계속 꺼지고 있다는 뜻이다.
  Write-Host (Wsl 'uptime -s; uptime -p; echo "systemd: $(test -d /run/systemd/system && echo yes || echo no)"; echo "앵커: $(ps -eo args= | grep -c "^/bin/sleep infinity") 개"')

  Info "WSL claw-web / 터널 유닛"
  Write-Host (Wsl 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user list-units --no-pager --no-legend "claw-web*" "cloudflared*" 2>/dev/null; echo "--- WSL 안 터널(있으면 중복이다):"; systemctl --user is-enabled claw-web-tunnel 2>/dev/null || echo "claw-web-tunnel 없음/비활성"')

  Info "윈도우 cloudflared 서비스"
  $svc = Get-Service cloudflared -ErrorAction SilentlyContinue
  if ($svc) {
    Write-Host "    상태: $($svc.Status) / 시작유형: $($svc.StartType)"
  } else { Warn "cloudflared 윈도우 서비스가 없다 — 터널이 아직 WSL 안에 있다" }

  Info "cloudflared 로그 (최근 40줄)"
  if (Test-Path $CfLog) { Get-Content $CfLog -Tail 40 | ForEach-Object { Write-Host "      $_" } }
  else { Warn "$CfLog 없음" }

  Info "sshd"
  $sshd = Get-Service sshd -ErrorAction SilentlyContinue
  if ($sshd) { Write-Host "    상태: $($sshd.Status) / 시작유형: $($sshd.StartType)" } else { Warn "sshd 서비스 없음" }
  $lsn = Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue
  if ($lsn) { Ok "22 번 포트 리스닝 중" } else { Warn "22 번 포트가 열려 있지 않다" }

  Info "예약 작업과 트리거"
  Show-Tasks

  Info "포트포워딩"
  & netsh interface portproxy show v4tov4

  Info "레포 상태"
  Write-Host (Wsl "cd ~/claw-web 2>/dev/null && git log --oneline -3 && echo '--- origin 과의 차이:' && git rev-list --left-right --count HEAD...origin/main 2>/dev/null && echo '--- 로컬 수정:' && git status --short --untracked-files=no | head -10")

  [Console]::OutputEncoding = $prevEnc
  exit 0
}

# ── 1. WSL 깨우기 ────────────────────────────────────────
Step "1/9  WSL"
& wsl.exe -d $Distro -u root --exec /bin/true *> $null
if (-not (WslOk 'true')) { Die "WSL 배포판 '$Distro' 에 접속할 수 없다. 'wsl -l -v' 로 이름을 확인하라." }
Ok "WSL '$Distro' 응답함"
if (-not (WslOk 'test -d /run/systemd/system')) {
  Warn "systemd 가 꺼져 있다 — claw-web 서비스가 안 뜰 수 있다 (/etc/wsl.conf 의 systemd=true 확인)"
}
Wsl 'loginctl enable-linger $USER 2>/dev/null' | Out-Null

# ── 2. 터널 자격증명을 윈도우로 꺼내온다 ─────────────────
# DNS 가 이 UUID 를 가리키고 있다. 자격증명이 없다고 새 터널을 만들면
# 도메인은 여전히 옛 UUID 를 보므로 영영 안 붙는다. 그래서 못 찾으면 죽는다.
Step "2/9  터널 자격증명"
if (-not (Test-Path $CfDir)) { New-Item -ItemType Directory -Force -Path $CfDir | Out-Null }

$grabCred = @'
for d in /root/.cloudflared /home/*/.cloudflared; do
  f="$d/__ID__.json"
  [ -f "$f" ] && { base64 -w0 "$f"; exit 0; }
done
exit 1
'@ -replace '__ID__', $TunnelId

$credB64 = WslRoot $grabCred
if ($credB64 -notmatch '^[A-Za-z0-9+/=]+$') {
  Warn "WSL 안에서 $TunnelId.json 을 찾지 못했다. .cloudflared 디렉터리 내용:"
  Write-Host (WslRoot 'ls -la /root/.cloudflared /home/*/.cloudflared 2>&1 | head -40')
  Die "터널 자격증명이 없다. 새 터널을 만들지 말 것 — DNS 가 $TunnelId 를 가리키고 있다."
}
[IO.File]::WriteAllBytes($CfCred, [Convert]::FromBase64String($credB64))
Ok "자격증명 → $CfCred"

# cert.pem 은 tunnel run 에는 필수가 아니지만, 나중에 route/list 를 쓰려면 필요하다.
$grabCert = @'
for d in /root/.cloudflared /home/*/.cloudflared; do
  [ -f "$d/cert.pem" ] && { base64 -w0 "$d/cert.pem"; exit 0; }
done
exit 1
'@
$certB64 = WslRoot $grabCert
if ($certB64 -match '^[A-Za-z0-9+/=]+$') {
  [IO.File]::WriteAllBytes((Join-Path $CfDir 'cert.pem'), [Convert]::FromBase64String($certB64))
  Ok "cert.pem → $CfDir"
} else {
  Warn "cert.pem 을 못 찾았다 — 터널 실행에는 지장 없다 (route/list 명령만 못 쓴다)"
}

# ── 3. cloudflared.exe ───────────────────────────────────
Step "3/9  cloudflared.exe"
$cf = Get-CloudflaredExe
if ($cf) {
  Ok "이미 있음: $cf"
} else {
  Info "winget 으로 설치 시도..."
  if (Get-Command winget.exe -ErrorAction SilentlyContinue) {
    & winget.exe install --id Cloudflare.cloudflared -e --silent `
      --accept-source-agreements --accept-package-agreements *> $null
    $cf = Get-CloudflaredExe
  }
  if (-not $cf) {
    Info "winget 실패 — 공식 바이너리를 직접 받는다"
    if (-not (Test-Path $CfExeDir)) { New-Item -ItemType Directory -Force -Path $CfExeDir | Out-Null }
    $dst = Join-Path $CfExeDir 'cloudflared.exe'
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -UseBasicParsing -TimeoutSec 180 `
        -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' `
        -OutFile $dst
    } catch { Die "cloudflared 다운로드 실패: $($_.Exception.Message)" }
    $cf = $dst
  }
  if (-not $cf -or -not (Test-Path $cf)) { Die "cloudflared.exe 를 확보하지 못했다." }
  Ok "설치됨: $cf"
}

# ── 4. config.yml ────────────────────────────────────────
# ingress 는 위에서부터 첫 일치가 이긴다. 마지막 404 는 없으면 cloudflared 가 뜨지 않는다.
Step "4/9  config.yml"
$yml = @"
tunnel: $TunnelId
credentials-file: $CfCred
protocol: http2
logfile: $CfLog
loglevel: info

ingress:
  - hostname: $Hostname
    service: http://127.0.0.1:$Port
  - hostname: $SshHostname
    service: ssh://127.0.0.1:22
  - service: http_status:404
"@
Save-Text -Path $CfConfig -Text $yml
Ok "$CfConfig ($Hostname → :$Port, $SshHostname → :22)"

# SYSTEM 의 홈에도 같은 것을 둔다. 서비스 등록이 어떤 이유로든 --config 를 잃어버려도
# cloudflared 가 기본 탐색 경로에서 같은 설정을 찾아내 ingress 가 비지 않는다.
# credentials-file 은 절대경로라 어느 쪽에서 읽혀도 같은 파일을 가리킨다.
try {
  if (-not (Test-Path $SysProfCfDir)) { New-Item -ItemType Directory -Force -Path $SysProfCfDir | Out-Null }
  Save-Text -Path (Join-Path $SysProfCfDir 'config.yml') -Text $yml
  Copy-Item $CfCred (Join-Path $SysProfCfDir "$TunnelId.json") -Force
  $certSrc = Join-Path $CfDir 'cert.pem'
  if (Test-Path $certSrc) { Copy-Item $certSrc (Join-Path $SysProfCfDir 'cert.pem') -Force }
  Ok "SYSTEM 홈에도 복사 → $SysProfCfDir"
} catch {
  Warn "SYSTEM 홈 복사 실패: $($_.Exception.Message) — --config 가 제대로 박히면 문제되지 않는다"
}

# ── 5. WSL 안의 터널을 내린다 ────────────────────────────
# 같은 터널에 커넥터가 둘이면 엣지가 요청을 둘로 나눠 보낸다. WSL 쪽은 VM 이 꺼지면
# 사라지므로, 그때마다 절반이 실패하는 간헐적 고장이 된다. 그래서 확실히 내린다.
# claw-web 서비스 자체는 계속 WSL 에서 돈다.
Step "5/9  WSL 안 터널 정리"
$down = Wsl @'
export XDG_RUNTIME_DIR=/run/user/$(id -u)
for u in claw-web-tunnel cloudflared; do
  if systemctl --user list-unit-files --no-legend 2>/dev/null | grep -q "^$u\."; then
    systemctl --user disable --now "$u" >/dev/null 2>&1 && echo "내림: $u (user)"
  fi
done
pkill -f "cloudflared.*tunnel run" >/dev/null 2>&1 && echo "남아 있던 cloudflared 프로세스 종료"
systemctl --user enable --now claw-web >/dev/null 2>&1
systemctl --user is-active --quiet claw-web && echo "claw-web 실행 중" || echo "claw-web 이 뜨지 않았다"
exit 0
'@
Info $down
WslRoot 'systemctl disable --now cloudflared >/dev/null 2>&1 || true' | Out-Null

# ── 6. 윈도우 서비스로 터널 상주 ─────────────────────────
# 여기가 이 스크립트의 핵심이다. SYSTEM 계정 + 자동시작이라 로그인이 필요 없고,
# WSL VM 이 꺼져도 터널은 계속 엣지에 붙어 있다.
Step "6/9  cloudflared 윈도우 서비스"
$svc = Get-Service cloudflared -ErrorAction SilentlyContinue
if ($svc) {
  Info "기존 서비스 제거 후 새 config 로 다시 설치"
  Stop-Service cloudflared -Force -ErrorAction SilentlyContinue
  & $cf service uninstall *> $null
  Start-Sleep -Seconds 2
}
# --config 를 install 앞에 붙여야 한다. cloudflared 는 등록할 binPath 를 지금 받은 인자에서
# 그대로 만들어 쓰기 때문에, 여기서 빠지면 서비스가 설정 없이 등록된다.
& $cf --config $CfConfig service install *> $null
Start-Sleep -Seconds 2
$svc = Get-Service cloudflared -ErrorAction SilentlyContinue
if (-not $svc) { Die "cloudflared 서비스 등록 실패. '$cf --config $CfConfig service install' 을 직접 실행해 오류를 보라." }

# 등록된 binPath 를 직접 읽어 확인한다. 버전에 따라 --config 를 삼키는 경우가 있고,
# 그러면 서비스는 Running 인데 ingress 가 비어서 전 호스트가 404 로 떨어진다.
# "설치했으니 됐겠지" 로 넘어가면 이 증상을 못 잡는다.
$binPath = (Get-CimInstance Win32_Service -Filter "Name='cloudflared'" -ErrorAction SilentlyContinue).PathName
if (-not $binPath) {
  Warn "서비스 binPath 를 읽지 못했다 — 확인을 건너뛴다"
} elseif ($binPath -match '--config') {
  Ok "binPath 에 --config 포함됨"
  Info $binPath
} else {
  Warn "binPath 에 --config 가 없다 — 교정한다"
  Info "이전: $binPath"
  # 맨 앞 실행파일 토큰만 떼어내고 그 뒤에 --config 를 끼워 넣는다. 나머지 인자는 보존한다.
  if ($binPath -match '^\s*(?:"(?<exe>[^"]+)"|(?<exe>\S+))\s*(?<rest>.*)$') {
    $exe  = $Matches['exe']
    $rest = $Matches['rest'].Trim()
    if (-not $rest) { $rest = 'tunnel run' }
    $newPath = '"{0}" --config "{1}" {2}' -f $exe, $CfConfig, $rest
    & sc.exe config cloudflared binPath= $newPath *> $null
    $binPath = (Get-CimInstance Win32_Service -Filter "Name='cloudflared'" -ErrorAction SilentlyContinue).PathName
    if ($binPath -match '--config') { Ok "교정됨: $binPath" }
    else { Warn "교정 실패 — SYSTEM 홈($SysProfCfDir)의 config.yml 로 버틴다" }
  } else {
    Warn "binPath 를 해석하지 못했다: $binPath"
  }
}

Set-Service cloudflared -StartupType Automatic
# 죽으면 스스로 되살아나게. 이게 없으면 한 번 죽고 끝이다.
& sc.exe failure cloudflared reset= 0 actions= restart/5000/restart/5000/restart/5000 *> $null
if (Test-Path $CfLog) { Remove-Item $CfLog -Force -ErrorAction SilentlyContinue }
Start-Service cloudflared -ErrorAction SilentlyContinue
Ok "서비스 등록 (SYSTEM / 자동시작 / 실패 시 5초 뒤 재시작)"

# 서비스는 journalctl 이 없다. 등록 여부는 로그 파일로만 확인된다.
Info "엣지 등록 확인 중 (최대 45초)..."
$registered = $false
foreach ($i in 1..45) {
  Start-Sleep -Seconds 1
  if ((Test-Path $CfLog) -and (Select-String -Path $CfLog -Pattern 'Registered tunnel connection' -Quiet -ErrorAction SilentlyContinue)) {
    $registered = $true; break
  }
}
if ($registered) { Ok "엣지에 등록됨" }
else {
  Warn "45초 안에 등록되지 않았다 — 로그 꼬리:"
  if (Test-Path $CfLog) { Get-Content $CfLog -Tail 25 | ForEach-Object { Write-Host "      $_" } }
  else { Warn "$CfLog 이 생기지도 않았다 (서비스가 즉시 죽었을 수 있다)" }
}

# ── 7. SSH 원격 채널 ─────────────────────────────────────
# 이 기계엔 원격 채널이 전혀 없었다. 고장나면 사용자가 그 앞에 앉아야 했다.
# 터널의 ssh:// ingress + 윈도우 OpenSSH 서버로 맥에서 직접 붙을 수 있게 만든다.
# 방화벽은 건드리지 않는다 — 접속은 터널을 통해 127.0.0.1 로만 들어온다.
Step "7/9  SSH 원격 채널"
$cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' -ErrorAction SilentlyContinue
if ($cap -and $cap.State -ne 'Installed') {
  Info "OpenSSH 서버 설치 중..."
  Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' *> $null
}
if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) { Die "OpenSSH 서버 설치 실패 (sshd 서비스 없음)." }
Set-Service sshd -StartupType Automatic
Start-Service sshd -ErrorAction SilentlyContinue
Ok "sshd 자동시작 + 기동"

$akPath = 'C:\ProgramData\ssh\administrators_authorized_keys'
$keys = @()
if (Test-Path $akPath) {
  $keys = @(Get-Content $akPath -ErrorAction SilentlyContinue | Where-Object { $_.Trim() })
}
# 키 본문(타입+base64)만 비교한다. 주석만 다른 같은 키를 두 번 넣지 않기 위해서다.
$keyBody = ($PubKey -split '\s+')[0..1] -join ' '
if ($keys | Where-Object { (($_ -split '\s+')[0..1] -join ' ') -eq $keyBody }) {
  Ok "공개키가 이미 등록돼 있다"
} else {
  $keys += $PubKey.Trim()
  Save-Text -Path $akPath -Text (($keys -join "`n") + "`n")
  Ok "공개키 등록 → $akPath"
}
# sshd 는 이 파일이 SYSTEM/Administrators 외에 쓰기 가능하면 통째로 무시한다.
& icacls.exe $akPath /inheritance:r /grant 'SYSTEM:F' /grant 'BUILTIN\Administrators:F' *> $null
Ok "ACL: SYSTEM + Administrators 만"

# sshd_config — 지시자는 반드시 첫 Match 블록 *앞* 에 넣어야 한다.
# 파일 끝에 붙이면 기본 sshd_config 마지막의 'Match Group administrators' 안으로
# 들어가 버려서, 관리자 계정에만 적용되는 다른 의미가 된다.
$scPath = 'C:\ProgramData\ssh\sshd_config'
if (Test-Path $scPath) {
  $lines = @(Get-Content $scPath)
  $matchIdx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*Match\s') { $matchIdx = $i; break }
  }
  $head = if ($matchIdx -ge 0) { @($lines[0..($matchIdx-1)]) } else { $lines }
  $tail = if ($matchIdx -ge 0) { @($lines[$matchIdx..($lines.Count-1)]) } else { @() }
  if ($matchIdx -eq 0) { $head = @() }
  $head = @($head | Where-Object {
    $_ -notmatch '^\s*#?\s*(PubkeyAuthentication|PasswordAuthentication)\s' -and
    $_ -notmatch '^\s*#\s*claw-web\b'
  })
  $head += @('# claw-web — 터널 경유 원격 채널 (키 인증만)', 'PubkeyAuthentication yes', 'PasswordAuthentication no')
  Save-Text -Path $scPath -Text (((@($head) + $tail) -join "`n") + "`n")
  Restart-Service sshd -ErrorAction SilentlyContinue
  Ok "sshd_config: 키 인증만 허용 (비밀번호 차단)"
} else {
  Warn "sshd_config 이 없다 — sshd 가 한 번도 안 떴을 수 있다"
}

# ── 8. 자동기동 전면 교체 (로그인 불필요) ────────────────
# 여기가 재부팅 실패의 진짜 원인이었다. 기존 작업은 전부 -AtLogOn 이라
# 재부팅 후 아무도 로그인하지 않으면 WSL 이 영영 안 뜬다.
Step "8/9  자동기동 (AtStartup 으로 교체)"
if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Force -Path $StateDir | Out-Null }

foreach ($t in $LegacyTasks) {
  if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
    Info "옛 로그온 작업 제거: $t"
  }
}

# 앵커: WSL VM 을 붙잡아 두는 프로세스. WSL2 는 마지막 세션이 끝나면 VM 을 꺼버린다.
# SYSTEM 으로는 wsl.exe 가 동작하지 않으므로 S4U(암호 없이 사용자 컨텍스트)로 돈다.
# 부팅 직후엔 WSL 서브시스템이 아직 준비되지 않을 수 있어 30초 간격으로 10번 재시도한다.
#
# bash 로 넘길 명령은 base64 로 미리 싸둔다. PowerShell 5.1 이 네이티브 exe 인자의
# 따옴표를 뭉개면 bash -lc 가 첫 단어만 받고 나머지를 위치인자로 삼아 조용히 실패한다.
$startB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(
  'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user start claw-web'))
$anchorBody = @"
`$ErrorActionPreference = 'SilentlyContinue'
`$distro = '$Distro'
`$ipFile = '$IpFile'

`$up = `$false
for (`$i = 1; `$i -le 10; `$i++) {
  & wsl.exe -d `$distro -u root --exec /bin/true
  if (`$LASTEXITCODE -eq 0) { `$up = `$true; break }
  Start-Sleep -Seconds 30
}
if (-not `$up) { exit 1 }

# WSL IP 를 남긴다. portproxy 작업은 SYSTEM 이라 wsl.exe 를 못 쓰고 이 파일을 읽는다.
`$raw = & wsl.exe -d `$distro -- hostname -I 2>`$null
`$ip = ((`$raw | Out-String) -replace "``0", '').Trim().Split(' ')[0]
if (`$ip -match '^\d+\.\d+\.\d+\.\d+$') {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent `$ipFile) | Out-Null
  [IO.File]::WriteAllText(`$ipFile, `$ip)
}

# claw-web 서비스 기동 보장 (linger 가 꺼져 있어도 여기서 살아난다)
& wsl.exe -d `$distro -- bash -c "echo $startB64 | base64 -d | bash"

# 끝나지 않는 앵커. 이 프로세스가 사는 동안 VM 이 꺼지지 않는다.
& wsl.exe -d `$distro -u root --exec /bin/sleep infinity
"@
Save-Text -Path $AnchorPs1 -Text $anchorBody -Bom

# portproxy: WSL IP 는 부팅마다 바뀐다. 낡은 규칙이 남으면 TCP 는 붙는데 HTTP 가 0바이트다.
# 0.0.0.0 규칙은 127.0.0.1 로 들어오는 연결을 받지 않는다. 터널(윈도우 서비스)은
# 127.0.0.1 로 붙으므로 **둘 다** 등록해야 한다. 이게 빠져서 터널만 살고 응답이 없었다.
$proxyBody = @"
`$ErrorActionPreference = 'SilentlyContinue'
`$port   = $Port
`$ipFile = '$IpFile'

# 앵커 작업이 WSL 을 깨우고 IP 를 적을 때까지 기다린다 (최대 5분).
`$ip = ''
for (`$i = 1; `$i -le 60; `$i++) {
  if (Test-Path `$ipFile) {
    `$c = (Get-Content `$ipFile -Raw).Trim()
    if (`$c -match '^\d+\.\d+\.\d+\.\d+$') { `$ip = `$c; break }
  }
  Start-Sleep -Seconds 5
}
if (-not `$ip) { exit 1 }

foreach (`$la in @('0.0.0.0', '127.0.0.1')) {
  & netsh.exe interface portproxy delete v4tov4 listenport=`$port listenaddress=`$la | Out-Null
  & netsh.exe interface portproxy add v4tov4 listenport=`$port listenaddress=`$la connectport=`$port connectaddress=`$ip | Out-Null
}
"@
Save-Text -Path $ProxyPs1 -Text $proxyBody -Bom

$me  = ([Security.Principal.WindowsIdentity]::GetCurrent()).Name
$set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
         -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)

try {
  Unregister-ScheduledTask -TaskName $AnchorTask -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $AnchorTask -Force `
    -Action    (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$AnchorPs1`"") `
    -Trigger   (New-ScheduledTaskTrigger -AtStartup) `
    -Principal (New-ScheduledTaskPrincipal -UserId $me -LogonType S4U -RunLevel Highest) `
    -Settings  $set | Out-Null
  Ok "'$AnchorTask' — AtStartup / $me (S4U, 로그인 불필요)"
} catch { Warn "앵커 작업 등록 실패: $($_.Exception.Message)" }

try {
  Unregister-ScheduledTask -TaskName $ProxyTask -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $ProxyTask -Force `
    -Action    (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ProxyPs1`"") `
    -Trigger   (New-ScheduledTaskTrigger -AtStartup) `
    -Principal (New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest) `
    -Settings  $set | Out-Null
  Ok "'$ProxyTask' — AtStartup / SYSTEM"
} catch { Warn "포트포워딩 작업 등록 실패: $($_.Exception.Message)" }

# 지금 당장도 되게 — 재부팅을 기다리지 않는다.
$anchorUp = (Wsl "ps -eo args= 2>/dev/null | grep -c '^/bin/sleep infinity'")
if ($anchorUp -notmatch '^[1-9]') {
  Start-Process -FilePath 'wsl.exe' `
    -ArgumentList @('-d', $Distro, '-u', 'root', '--exec', '/bin/sleep', 'infinity') `
    -WindowStyle Hidden
  Start-Sleep -Seconds 3
}
$wslIp = (Wsl "hostname -I | awk '{print `$1}'")
if ($wslIp -match '^\d+\.\d+\.\d+\.\d+$') {
  Save-Text -Path $IpFile -Text $wslIp
  foreach ($la in @('0.0.0.0', '127.0.0.1')) {
    & netsh.exe interface portproxy delete v4tov4 listenport=$Port listenaddress=$la *> $null
    & netsh.exe interface portproxy add v4tov4 listenport=$Port listenaddress=$la connectport=$Port connectaddress=$wslIp *> $null
  }
  Ok "포트포워딩 지금 적용: 0.0.0.0:$Port / 127.0.0.1:$Port → ${wslIp}:$Port"
} else {
  Warn "WSL IP 를 못 읽었다 — 재부팅 후 '$ProxyTask' 가 다시 시도한다"
}

Info "등록된 작업:"
Show-Tasks

# ── 9. 확인 ──────────────────────────────────────────────
Step "9/9  확인"
$fail = @()

try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 10 -UseBasicParsing
  Ok "127.0.0.1:$Port → HTTP $($r.StatusCode)"
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  if ($code) { Ok "127.0.0.1:$Port → HTTP $code (도달함)" }
  else { $fail += "127.0.0.1:$Port 응답 없음 — portproxy 의 127.0.0.1 항목 또는 WSL claw-web 확인"; Warn $fail[-1] }
}

$svc = Get-Service cloudflared -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') { Ok "cloudflared 서비스 Running" }
else { $fail += "cloudflared 서비스가 Running 이 아니다 ($($svc.Status))"; Warn $fail[-1] }

if (Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue) { Ok "SSH 22 번 리스닝" }
else { $fail += "22 번 포트가 리스닝 상태가 아니다 — sshd 확인"; Warn $fail[-1] }

Info "터널이 엣지에 붙는 데 10~20초 걸린다..."
$tunnelOk = $false
foreach ($i in 1..12) {
  Start-Sleep -Seconds 5
  try {
    $r = Invoke-WebRequest -Uri "https://$Hostname/api/health" -TimeoutSec 10 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $tunnelOk = $true; break }
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    # 401 등은 "도달은 했다" 는 뜻이다. 530/1033 만 터널 미등록이다.
    if ($code -and $code -ne 530) { $tunnelOk = $true; break }
  }
}
if ($tunnelOk) { Ok "https://$Hostname 응답" }
else { $fail += "https://$Hostname 응답 없음 (여전히 530/1033)"; Warn $fail[-1] }

Write-Host ""
if ($fail.Count -eq 0) {
  Write-Host "  전부 통과. 이제 재부팅해도 로그인 없이 살아난다." -ForegroundColor Green
  Write-Host ""
  Write-Host "  맥에서 이 기계에 붙는 법:" -ForegroundColor Cyan
  Write-Host "    ssh -o ProxyCommand=`"cloudflared access ssh --hostname $SshHostname`" $env:USERNAME@win"
} else {
  Write-Host "  실패한 항목:" -ForegroundColor Yellow
  foreach ($f in $fail) { Write-Host "    - $f" -ForegroundColor Yellow }
  Write-Host ""
  Write-Host "  cloudflared 로그 (최근 30줄):" -ForegroundColor Yellow
  if (Test-Path $CfLog) { Get-Content $CfLog -Tail 30 | ForEach-Object { Write-Host "      $_" } }
  else { Write-Host "      $CfLog 없음" }
  Write-Host ""
  Write-Host "  더 자세히: powershell -ExecutionPolicy Bypass -File .\claw-web-win-remote.ps1 -Diagnose" -ForegroundColor Yellow
}
Write-Host ""

[Console]::OutputEncoding = $prevEnc
