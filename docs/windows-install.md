# Windows 설치 (WSL2)

claw-web 은 파일 스토어 + Claude CLI 전제라 Windows 네이티브가 아니라 **WSL2 Ubuntu** 안에서 돌린다.
아래 스크립트들이 설치 이후의 모든 반복 작업(상주화·포트 노출·외부 공개·업데이트)을 대신한다.

| 스크립트 | 실행 위치 | 하는 일 |
|---|---|---|
| `scripts/claw-web-wsl-setup.ps1` | Windows **관리자** PowerShell | systemd 활성화, `claw-web.service` 등록, LAN 포트포워딩, 로그온 자동 실행 |
| `scripts/claw-web-cf-tunnel.sh` | WSL 셸 | cloudflared 설치·터널 생성·DNS 등록·서비스 상주 → 외부 도메인 공개 |
| `scripts/win-bootstrap.sh` | WSL 셸 | 설치 후 상시 사용 — pull·의존성·빌드·재시작·자동업데이트 타이머를 한 번에 |
| `scripts/omniroute-setup.sh` | WSL 셸 (맥도 동일) | 선택 — OmniRoute 게이트웨이 설치·상주·키 발급·백엔드 연결까지 한 번에 |
| `scripts/omniroute-probe.mjs` | WSL 셸 (맥도 동일) | 무료 모델이 아직 살아 있고 툴을 부르는지 재검증 |
| `scripts/claw-web-win-recover.ps1` | Windows **관리자** PowerShell | 고장났을 때 한 방에 복구 — 서비스·터널·포트포워딩·재부팅 대비까지 |
| `scripts/claw-web-win-remote.ps1` | Windows **관리자** PowerShell | 구조적 해결 — 터널을 윈도우 서비스로 옮기고, SSH 원격 채널을 열고, 자동기동을 로그인 불필요하게 전환 |

---

## 0. 사전 준비

```powershell
wsl --install -d Ubuntu     # 이미 있으면 생략. 재부팅 필요할 수 있음
```

WSL 셸에서:

```bash
# Node 20+ (nvm 권장)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc && nvm install 22

# node-pty 네이티브 빌드에 필요 — 없으면 npm install 이 node-gyp 에서 죽는다
sudo apt update && sudo apt install -y build-essential python3 pkg-config

# Claude CLI (네이티브 설치는 PATH 에 안 잡혀 있을 수 있다)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
claude --version
```

> **클론 위치는 반드시 리눅스 파일시스템(`~/claw-web`)** 으로. `/mnt/c/...` 아래에 두면
> 9p 파일시스템을 타서 npm install 과 파일 스토어 접근이 몇 배 느려진다.

## 1. 설치

```bash
cd ~ && git clone https://github.com/projovermind/claw-web.git
cd claw-web && bash install.sh
```

`install.sh` 는 실행 권한 비트가 커밋돼 있지 않으므로 `bash` 로 부른다.

## 2. 상주화 + LAN 노출 (Windows 쪽)

**관리자 PowerShell** 에서:

```powershell
cd \\wsl$\Ubuntu\home\<사용자>\claw-web\scripts
powershell -ExecutionPolicy Bypass -File .\claw-web-wsl-setup.ps1
```

하는 일:

1. `/etc/wsl.conf` 에 `systemd=true` 를 넣고 `wsl --shutdown` 후 PID 1 이 systemd 인지 검증
2. 포그라운드로 떠 있던 `node server/index.js` 정리
3. `~/.config/systemd/user/claw-web.service` 작성 → `systemctl --user enable --now`
4. `loginctl enable-linger` — 터미널을 닫아도 서비스가 유지된다
5. `netsh interface portproxy` + 방화벽 규칙 → 다른 기기에서 `http://<윈도우LAN IP>:3838`
6. 로그온 시 `-Refresh` 로 재실행되는 작업 스케줄러 등록
   — **WSL IP 는 재부팅마다 바뀌므로** portproxy 를 매번 다시 걸어줘야 한다

옵션: `-Port 3838`, `-Distro Ubuntu`, `-RepoDir '~/claw-web'`, `-Refresh`(포트포워딩만 갱신)

## 3. 외부 공개 (WSL 쪽)

Cloudflare 에 존이 등록돼 있어야 한다.

```bash
cd ~/claw-web
bash scripts/claw-web-cf-tunnel.sh win.example.com
```

중간에 `cloudflared tunnel login` 에서 **한 번 멈춘다** — 출력된 URL 을 브라우저로 열어
해당 존을 승인하면 나머지(터널 생성 → CNAME 등록 → `config.yml` → systemd 등록 → 헬스체크)는 자동이다.

QUIC 이 일부 네트워크에서 끊기므로 `protocol: http2` 를 고정하고,
SSE/WebSocket 이 오래 열려 있는 특성 때문에 `tcpKeepAlive` 를 세워둔다.

터널이 뜨면 LAN 포트포워딩은 없어도 되지만, 집 안에서 저지연으로 쓰려면 그대로 둬도 무방하다.

## 4. 기기 등록

각 claw-web 인스턴스는 **자기 목록만** 갖는다. 원격 조종이 아니라 상대 기계의 claw-web 으로
건너뛰는 북마크이므로, 맥·윈도우 **양쪽 모두에서** 설정 → 기기에 서로를 등록해야 한다.
순번을 맞춰두면 어느 쪽에서든 `Alt`+같은 숫자가 같은 기계를 가리킨다.

## 5. 에이전트 공유 (선택)

맥에서 만든 에이전트 정의를 그대로 당겨올 수 있다. `workingDir` 만 경로 매핑으로 번역된다 →
[docs/agent-sync.md](agent-sync.md)

```bash
node scripts/sync-agents.mjs --dry-run
```

## 6. 자동 업데이트

설치 이후에는 이 한 줄이면 된다 — pull 부터 타이머 등록까지 전부 한다. 몇 번을 돌려도 안전하다.

```bash
curl -fsSL https://raw.githubusercontent.com/projovermind/claw-web/main/scripts/win-bootstrap.sh | bash
```

개별로 쓰려면:

```bash
bash scripts/self-update.sh --install-timer
bash scripts/self-update.sh --check          # git·프로세스·워커 상태만 확인
```

타이머는 **5분 주기**로 두 가지를 본다.

1. `origin/main` 이 앞서 있으면 → pull, `package-lock.json` 이 바뀐 경우에만 `npm install`,
   `client/` 가 바뀐 경우에만 재빌드
2. **떠 있는 프로세스가 디스크보다 낡았으면 → 재시작.** git 업데이트가 없어도 돈다.
   손으로 빌드해 둔 변경도 여기서 반영된다.

재시작이 대화를 끊기 때문에 **워커가 하나라도 살아 있으면 아무것도 하지 않고** 다음 주기로 미룬다.
그래서 실질적으로 "세션이 없으면 5분 안에 알아서 최신으로 맞춰진다"에 가깝다.
커밋 안 된 로컬 변경이 있으면 pull 은 건너뛰되, 재시작 판단은 그대로 한다.

로그: `data/user/logs/self-update.log`

맥에서도 같은 명령이 먹는다 — systemd 대신 LaunchAgent `com.claw-web.update` 를 걸고
재시작은 `launchctl kickstart -k gui/$(id -u)/com.claw-web.server` 으로 한다.
해제는 `launchctl bootout gui/$(id -u)/com.claw-web.update`.
구버전 개인 설치본은 레이블이 `cc.subinggrae.*` 일 수 있다 — `scripts/migrate-launchagent-labels.sh` 참고.

설정 → 기기 목록의 오른쪽에 각 기기의 버전이 뜬다. 주황색이면 이쪽과 버전이 다르다는 뜻 —
그 기기에서 아직 업데이트가 안 돌았거나, 디스크는 최신인데 재시작을 안 한 상태다
(`/api/health` 의 `version` 은 프로세스가 뜰 때 읽은 값이다).

## 7. OmniRoute 게이트웨이 (선택)

여러 제공자의 무료 티어로 폴백해 주는 게이트웨이다. **호스팅 API 가 아니라 이 기계에서 직접 돌린다** —
그래서 어디서 키를 발급받는 게 아니라 게이트웨이가 자기 키를 만들어 준다.

```bash
bash scripts/omniroute-setup.sh                 # 이 기계에서만 (127.0.0.1)
bash scripts/omniroute-setup.sh --lan           # 같은 공유기의 다른 기기에서도 대시보드 접속
bash scripts/omniroute-setup.sh --password 원하는비번
bash scripts/omniroute-setup.sh --uninstall     # 상주만 해제
```

npm 전역 설치 → `REQUIRE_API_KEY` 잠금 → 상주 등록(맥 LaunchAgent / WSL systemd) →
대시보드 비밀번호 → API 키 발급 → claw-web 백엔드 등록·토큰 주입 → 실제 호출 검증까지 한다.
여러 번 돌려도 안전하고, 이미 된 단계는 건너뛴다.

끝나면 **에이전트 편집 → 백엔드 `OmniRoute` + 모델 `auto`** 로 쓴다.

### 실을 모델 고르기

OmniRoute 에는 479개 모델이 뜨지만 **대부분은 브라우저 인증을 붙여야 열린다.** 아무 키 없이
바로 되는 건 `oc`(OpenCode Free)와 `cfp`(Cloudflare Playground) 둘뿐이고, 그 안에서도 절반은 죽어 있다.

거기에 더 좁은 조건이 하나 있다. claw-web 에이전트는 Read/Write/Bash 를 직접 호출해야 하므로
**모델이 실제로 `tool_use` 블록을 내보내야 한다.** 카탈로그의 `tool_calling: true` 표기는 믿을 게 못 된다 —
Cloudflare Playground 쪽은 전부 `true` 로 적혀 있지만 실제로는 툴을 부르지 않는다.

그래서 프리셋에는 **직접 호출해 보고 통과한 것만** 실었다.

| 프리셋의 모델 | 실제 모델 | 툴 호출 | 비고 |
|---|---|---|---|
| `auto` | 게이트웨이 자동 선택 | ✅ | 기본값. 지금은 `big-pickle` 로 간다 |
| `big-pickle` | `oc/big-pickle` | ✅ | **주력.** 가장 빠르고 정확하다 |
| `mimo-2.5` | `oc/mimo-v2.5-free` | ✅ | |
| `muse-spark-1.2` | `oc/muse-spark-1.2-contributor-free` | ✅ | |
| `glm-5.2-chat` | `cfp/zai-org/glm-5.2` | ❌ | **대화 전용** — 아래 참고 |

**GLM-5.2 는 에이전트에 못 쓴다.** 답변 품질 자체는 좋은데(코드 리뷰 4/4, 한국어 정상),
이 경로에서는 툴을 부르는 대신 `{"jsonrpc":"2.0","method":"mcp_read_file",...}` 를 **그냥 본문 텍스트로**
뱉는다. 모델이 아니라 OmniRoute 가 그걸 `tool_use` 로 되돌리지 못하는 것이다.
에이전트에 물리면 "파일을 읽겠습니다" 하고 아무것도 안 한 채 끝난다. 요약·번역·질의응답에만 써라.

무료 티어는 수시로 죽으므로, 안 되기 시작하면 다시 골라내면 된다.

```bash
node scripts/omniroute-probe.mjs            # 프리셋에 실린 것만 재검증
node scripts/omniroute-probe.mjs --all      # 무료 제공자 전체를 훑는다
node scripts/omniroute-probe.mjs --all --json   # 프리셋에 붙여넣을 models 맵을 뽑는다
```

알아둘 것:

- 기본 바인딩은 루프백이다. `--lan` 을 준 적이 있으면 재실행해도 그 선택을 되돌리지 않는다.
- 대시보드 초기 비밀번호는 `CHANGEME` 다. 스크립트가 이걸 감지하면 무작위 값으로 바꾸고 출력한다
  (**그때만 보여준다** — 적어둘 것). 이미 바꿔둔 게 있으면 건드리지 않는다.
- 키를 다시 만들려면 `--password` 로 알려줘야 한다. OmniRoute 는 발급된 키를 다시 보여주지 않는다.
- 모델 별칭에 `opus`/`sonnet`/`haiku` 를 쓰면 안 된다. 러너의 `MODEL_ID_MAP` 이 먼저 가로채
  `claude-sonnet-4-6` 을 보내고 OmniRoute 가 400 `Ambiguous` 로 거절한다.
- `claude/glm/...` 같은 값도 안 된다. OmniRoute 는 **앞부분을 제공자 이름으로** 읽어서
  `No active credentials for provider: claude` 401 을 낸다. 그런 경로를 쓰려면
  대시보드 → Providers 에서 해당 제공자를 먼저 연결해야 한다(브라우저 인증).
- 무료 티어는 클로드가 아니고 프롬프트가 외부로 나간다. 운영 데이터 에이전트에는 붙이지 말 것.

---

## 원격 채널 + 로그인 없이 자동 복구

`claw-web-win-recover.ps1` 은 **고장을 고친다.** 이건 **고장이 반복되는 구조를 바꾼다.**

재부팅 뒤에도 계속 `Error 1033` 이 나던 이유는 세 가지였다.

1. 자동기동 예약 작업이 전부 `-AtLogOn` 이었다 → 재부팅만 하고 아무도 로그인하지 않으면 WSL 도 터널도 뜨지 않는다.
2. cloudflared 가 WSL 안 systemd 에 있었다 → WSL2 VM 이 꺼지면 터널도 같이 죽는다.
3. WSL IP 는 부팅마다 바뀌는데 `netsh portproxy` 가 낡는다 → TCP 는 붙는데 HTTP 는 0바이트다.

그리고 이 기계엔 원격 채널이 전혀 없었다. 고장나면 사용자가 그 앞에 앉아야 했다.

```powershell
# 관리자 PowerShell — 이 세 줄을 통째로 붙여넣으면 끝난다
cd $env:USERPROFILE
iwr -useb https://raw.githubusercontent.com/projovermind/claw-web/main/scripts/claw-web-win-remote.ps1 -OutFile claw-web-win-remote.ps1
powershell -ExecutionPolicy Bypass -File .\claw-web-win-remote.ps1
```

하는 일:

- **터널을 WSL 밖으로** — 자격증명을 WSL 에서 꺼내 `C:\ProgramData\cloudflared\` 로 옮기고,
  `cloudflared service install` 로 윈도우 네이티브 서비스(SYSTEM, 자동시작)를 만든다.
  WSL VM 이 꺼져도 터널은 엣지에 붙어 있다. WSL 안의 옛 터널 유닛은 내린다(커넥터 중복 제거).
- **SSH 원격 채널** — 윈도우 OpenSSH 서버를 켜고 터널에 `ssh://` ingress 를 하나 더 실어,
  맥에서 이 기계에 직접 붙을 수 있게 한다. 방화벽 규칙은 만들지 않는다(터널 경유 loopback 전용).
- **자동기동 전면 교체** — `claw-web WSL anchor` 와 `claw-web portproxy` 를 **AtStartup** 으로 다시 건다.
  앵커는 `-LogonType S4U` 로 현재 사용자 컨텍스트에서 돈다(SYSTEM 으로는 `wsl.exe` 가 안 된다).
  포트포워딩은 `0.0.0.0` 과 `127.0.0.1` **둘 다** 등록한다 — 윈도우 서비스가 된 터널은
  `127.0.0.1` 로 붙는데, `0.0.0.0` 규칙은 loopback 연결을 받지 않는다.
- 옛 `-AtLogOn` 작업(`claw-web WSL`)은 제거한다.

`claw-web` 서비스 자체는 계속 WSL 안에서 돈다. 바뀌는 건 "누가 무엇을 붙잡고 있느냐" 뿐이다.
몇 번을 돌려도 안전하다.

기본값은 `-Hostname win.example.com` `-SshHostname ssh.win.example.com` `-Port 3838`
`-TunnelId 10461111-e2eb-468f-bbb8-d7bf853dbf10`, 배포판은 자동탐지(`-Distro` 로 고정 가능).
맥 공개키를 바꾸려면 `-PubKey "ssh-ed25519 AAAA... 주석"`.

마지막에 등록된 작업과 **실제 트리거 종류**(AtStartup / AtLogOn)를 찍어준다.
`AtLogOn` 이 남아 있으면 그 작업은 아직 안 고쳐진 것이다.

### 맥에서 이 기계에 붙기

```bash
# 키: ~/.ssh/clawweb_win_ed25519 (공개키는 위 스크립트가 윈도우에 등록한다)
ssh -i ~/.ssh/clawweb_win_ed25519 \
    -o ProxyCommand="cloudflared access ssh --hostname ssh.win.example.com" \
    <윈도우사용자>@win
```

`~/.ssh/config` 에 박아두면 `ssh win` 한 줄이 된다.

```
Host win
  HostName ssh.win.example.com
  User <윈도우사용자>
  IdentityFile ~/.ssh/clawweb_win_ed25519
  ProxyCommand cloudflared access ssh --hostname %h
```

> DNS 는 맥에서 이미 이 터널로 라우팅해 뒀다. 스크립트는 새 터널을 만들거나 DNS 를 건드리지 않는다.
> 자격증명을 못 찾으면 `.cloudflared` 디렉터리 내용을 찍고 **멈춘다** — 추측해서 새 터널을 만들면
> 도메인은 여전히 옛 UUID 를 보므로 영영 안 붙는다.

> 상태만 보려면 `-Diagnose`. WSL 가동시간, 윈도우 cloudflared 서비스 상태와 로그 40줄,
> sshd 상태, 등록된 작업과 트리거 종류, portproxy 표, 레포와 origin 의 차이를 찍는다. 아무것도 바꾸지 않는다.

> 이 `.ps1` 도 **UTF-8 BOM** 으로 저장돼 있다. BOM 을 떼면 Windows PowerShell 5.1 이 CP949 로 읽어서
> 한글이 깨지고 `ParserError` 로 죽는다. 편집할 때 유지할 것.

---

## 고장났을 때 — 한 방 복구

재부팅 뒤 `https://<호스트명>` 이 안 열리거나 LAN 도 응답이 없으면, 어디가 깨졌는지 찾지 말고 이걸 돌린다.
WSL 기동 → 레포 최신화 → claw-web 서비스 → **cloudflared 터널 상주** → 포트포워딩 → 로그온 작업 재등록 →
LAN·터널 양쪽 실제 응답 확인까지 한 번에 한다. 몇 번을 돌려도 안전하다(이미 된 단계는 건너뛴다).

```powershell
# 관리자 PowerShell
cd $env:USERPROFILE
iwr -useb https://raw.githubusercontent.com/projovermind/claw-web/main/scripts/claw-web-win-recover.ps1 -OutFile claw-web-win-recover.ps1
powershell -ExecutionPolicy Bypass -File .\claw-web-win-recover.ps1
```

고쳐도 잠시 뒤 또 죽는다면, 추측하지 말고 상태부터 뽑는다. 아무것도 바꾸지 않는다.

```powershell
powershell -ExecutionPolicy Bypass -File .\claw-web-win-recover.ps1 -Diagnose
```

WSL 가동 시간, 서비스·linger 상태, 터널 유닛 로그 40줄, 레포와 origin 의 차이, 포트포워딩을 찍는다.

호스트명은 WSL 의 `~/.cloudflared/config.yml` 에서 읽는다. 못 읽거나 바꾸고 싶으면 `-Hostname win.example.com`.
그 외 `-Port 3838` `-Distro Ubuntu` `-RepoDir ~/claw-web` `-SkipPull`.

마지막에 로그온 예약 작업 `claw-web WSL` 을 다시 걸어두므로, **다음 재부팅부터는 알아서 복구된다.**

> WSL 로 넘기는 명령은 base64 로 감싼다. Windows PowerShell 5.1 이 네이티브 exe 인자의
> 따옴표를 뭉개서, `awk '{print $1}'` 의 `$1` 이 bash 위치인자로 해석돼 빈 값이 되기 때문이다.

> 이 `.ps1` 은 **UTF-8 BOM** 으로 저장돼 있다. BOM 을 떼면 Windows PowerShell 5.1 이
> CP949 로 읽어서 한글이 깨지고 `ParserError: UnexpectedToken` 으로 죽는다. 편집할 때 유지할 것.

> WSL VM 을 앵커 프로세스(`sleep infinity`)로 붙잡아 둔다. 이게 없으면 스크립트가 도는
> 동안에만 터널이 살아 있고, 창을 닫는 순간 VM 과 함께 죽는다. 마지막 8단계는 90초 동안
> WSL 을 한 번도 부르지 않고 기다린 뒤 도메인을 다시 때려본다 — 창을 닫은 것과 같은 상태에서
> 살아 있는지를 실제로 확인하기 위해서다.

> DNS 는 `--overwrite-dns` 로 강제로 이 기계의 터널을 가리키게 바꾼다.
> 죽은 터널을 가리키고 있던 게 Error 1033 의 원인이라 그냥 두면 안 고쳐진다.

> 이 스크립트는 **지금 난 고장**을 고친다. 재부팅 때마다 같은 고장이 반복된다면 원인은 `-AtLogOn` 트리거와
> WSL 안의 터널이다 — 구조적 해결은 위 `claw-web-win-remote.ps1` 쪽이다.


## 자주 걸리는 것들

| 증상 | 원인 · 해결 |
|---|---|
| `claude: command not found` | 네이티브 설치본이 PATH 밖 → `export PATH="$HOME/.local/bin:$PATH"` |
| `npm install` 이 node-gyp 에서 실패 | `build-essential python3 pkg-config` 미설치 |
| `./install.sh: Permission denied` | exec 비트가 커밋돼 있지 않다 → `bash install.sh` |
| `EADDRINUSE :3838` | 이미 떠 있는 인스턴스가 있다. `curl localhost:3838/api/health` 로 확인 |
| `ipconfig.exe \| grep` → binary file matches | Windows 실행파일이 UTF-16 출력 → `ipconfig.exe \| tr -d '\0' \| grep -a IPv4` |
| 재부팅 후 LAN 접속 불가 | WSL IP 가 바뀌었다 → `claw-web-wsl-setup.ps1 -Refresh` |
| `git pull` → `untracked working tree files would be overwritten` | 푸시 전에 손으로 받아둔 파일이 남아 있다 → `win-bootstrap.sh` 가 알아서 비켜놓는다 (내용이 같으면 삭제, 다르면 `*.local-*.bak` 보관) |
| `Cannot find module '.../scripts/xxx.mjs'` | pull 이 위 사유로 중단됐다 → 같은 해법 |
| 서비스 상태 확인 | `systemctl --user status claw-web cloudflared` |
| 스크립트는 `살아났다` 인데 창을 닫으면 몇 분 뒤 **Error 1033 / 530** | WSL2 는 마지막 세션이 끝나면 VM 자체를 끈다. systemd 도 cloudflared 도 같이 사라진다. 판별법: `-Diagnose` 의 WSL 가동 시간이 매번 짧게 리셋돼 있거나, 저널에서 systemd 사용자 매니저 PID 가 **줄어들어** 있으면(한 부팅 안에서는 PID 가 줄 수 없다) VM 이 새로 뜬 것이다 → `claw-web-win-recover.ps1` 이 `wsl.exe --exec /bin/sleep infinity` 앵커를 띄워 VM 을 붙잡고, 로그온 작업 `claw-web WSL anchor` 로 재부팅 뒤에도 다시 세운다 |
| 터널 로그가 `Tunnel connection curve preferences` 에서 멈추고 그 다음 줄이 안 나옴 | 엣지와의 TLS 핸드셰이크가 오류도 없이 멈춘 것이다. 정상이면 이 줄 1~2초 뒤 `Registered tunnel connection` 이 나온다 → `claw-web-win-recover.ps1` 이 설정 조합을 하나씩 걸어보며 **실제로 등록되는지**를 저널로 확인한다 (기본 → `GODEBUG=tlsmlkem=0` → `+ --edge-ip-version 4` → `--protocol quic`, 조합당 최대 40초). 되는 조합을 찾으면 그대로 남기고 멈추고, 넷 다 실패하면 경로 MTU·`openssl s_client`·저널을 찍어준다 |
| systemd 로그에 `Unknown key '+ try { $out'` | 유닛 파일에 PowerShell 오류 텍스트가 박혔다. v1.17.52 이전 설치 스크립트가 WSL 로 넘긴 따옴표가 뭉개져 오류 메시지가 반환값에 섞였다 → `claw-web-win-recover.ps1` 이 유닛을 다시 쓴다 |
| `git pull` 이 `package-lock.json` 때문에 계속 막힘 | npm 이 다시 쓴 파일이라 작업물이 아니다 → `claw-web-win-recover.ps1` 이 `.bak` 으로 남기고 되돌린 뒤 fast-forward 한다 |
| (맥) 자동 업데이트가 조용히 안 돎 | 레포가 외장 볼륨이면 launchd 의 `/bin/bash` 가 TCC 에 막혀 로그도 없이 exit 78/126 으로 죽는다 → `bash scripts/self-update.sh --install-timer` 로 다시 깔면 node 를 한 겹 씌운 plist 로 교체된다 |
| 도메인이 **Cloudflare Error 1033** | 호스트명이 가리키는 터널에 붙어 있는 커넥터가 하나도 없다. v1.17.47 이전 자동 터널은 DNS 를 먼저 돌리고 상주 등록은 macOS 에서만 했어서, WSL 에서는 죽은 터널을 가리킨 채 끝났다 → 관리자 PowerShell 에서 `claw-web-win-recover.ps1` |
| 재부팅 뒤 **계속** 1033 (복구 스크립트를 돌리면 그때만 살아남) | 자동기동 작업이 `-AtLogOn` 이라 로그인 전에는 아무것도 뜨지 않고, 터널이 WSL 안에 있어 VM 과 함께 죽는다. 판별법: `claw-web-win-remote.ps1 -Diagnose` 의 작업 목록에 `AtLogOn` 이 보이면 그것이다 → `claw-web-win-remote.ps1` 로 전환한다 (터널을 윈도우 서비스로 옮기고 트리거를 `AtStartup` 으로 바꾼다) |
| 터널은 Running 인데 `win.example.com` 가 502 / 빈 응답 | 윈도우 서비스가 된 터널은 `127.0.0.1:3838` 로 붙는다. `netsh portproxy` 에 `0.0.0.0` 항목만 있으면 loopback 연결은 받지 않는다 → `claw-web-win-remote.ps1` 이 `0.0.0.0` 과 `127.0.0.1` 을 둘 다 등록한다 |
| 맥에서 `ssh win` 이 `Permission denied (publickey)` | `administrators_authorized_keys` 의 ACL 이 느슨하면 sshd 가 파일을 통째로 무시한다 → `claw-web-win-remote.ps1` 이 `icacls /inheritance:r` 로 SYSTEM+Administrators 만 남긴다. 다시 돌리면 고쳐진다 |
| `sc qc cloudflared` 의 binPath 가 어느새 `C:\Windows\System32\config\systemprofile\.cloudflared\config.yml` 을 가리킨다 | cloudflared 가 자동 업데이트를 마친 뒤 서비스를 자기 기준으로 **다시 등록**한 것이다(우리가 넣은 인자는 사라진다). 고장이 아니다 — `claw-web-win-remote.ps1` 이 그 경로에도 같은 config 를 복사해 두기 때문. 재등록 자체를 막으려면 `config.yml` 에 `no-autoupdate: true` 가 있어야 한다. 명령줄 `--no-autoupdate` 는 `tunnel` 하위 플래그라 `--config X --no-autoupdate tunnel run` 위치에서는 **먹지 않는다** |
| cloudflared 서비스가 Stopped(또는 5초마다 재시작) 인데 `cloudflared.log` 가 아예 없거나 0바이트 | binPath 에 인자가 하나도 안 들어갔다. `cloudflared service install` 이 `"...\cloudflared.exe"` 만 등록하는 경우가 있어서, 서비스가 뜨자마자 도움말만 찍고 죽는다 → `sc qc cloudflared` 로 확인. `claw-web-win-remote.ps1` 은 이제 `service install` 을 쓰지 않고 `New-Service` 로 `"...\cloudflared.exe" --config "C:\ProgramData\cloudflared\config.yml" --no-autoupdate tunnel run` 을 직접 등록한다 |
