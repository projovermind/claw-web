# Windows 설치 (WSL2)

claw-web 은 파일 스토어 + Claude CLI 전제라 Windows 네이티브가 아니라 **WSL2 Ubuntu** 안에서 돌린다.
아래 스크립트들이 설치 이후의 모든 반복 작업(상주화·포트 노출·외부 공개·업데이트)을 대신한다.

| 스크립트 | 실행 위치 | 하는 일 |
|---|---|---|
| `scripts/claw-web-wsl-setup.ps1` | Windows **관리자** PowerShell | systemd 활성화, `claw-web.service` 등록, LAN 포트포워딩, 로그온 자동 실행 |
| `scripts/claw-web-cf-tunnel.sh` | WSL 셸 | cloudflared 설치·터널 생성·DNS 등록·서비스 상주 → 외부 도메인 공개 |
| `scripts/win-bootstrap.sh` | WSL 셸 | 설치 후 상시 사용 — pull·의존성·빌드·재시작·자동업데이트 타이머를 한 번에 |
| `scripts/omniroute-setup.sh` | WSL 셸 (맥도 동일) | 선택 — OmniRoute 게이트웨이 설치·상주·키 발급·백엔드 연결까지 한 번에 |

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

맥에서도 같은 명령이 먹는다 — systemd 대신 LaunchAgent `cc.subinggrae.claw-web-update` 를 걸고
재시작은 `launchctl kickstart -k cc.subinggrae.claw-web` 으로 한다.
해제는 `launchctl bootout gui/$(id -u)/cc.subinggrae.claw-web-update`.

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

알아둘 것:

- 기본 바인딩은 루프백이다. `--lan` 을 준 적이 있으면 재실행해도 그 선택을 되돌리지 않는다.
- 대시보드 초기 비밀번호는 `CHANGEME` 다. 스크립트가 이걸 감지하면 무작위 값으로 바꾸고 출력한다
  (**그때만 보여준다** — 적어둘 것). 이미 바꿔둔 게 있으면 건드리지 않는다.
- 키를 다시 만들려면 `--password` 로 알려줘야 한다. OmniRoute 는 발급된 키를 다시 보여주지 않는다.
- 모델은 `auto` 만 기본 동작한다. `claude/glm/...` 같은 값은 OmniRoute 가 앞부분을 **제공자 이름**으로
  읽어서 `No active credentials for provider: claude` 401 이 난다. GLM 등을 직접 쓰려면
  대시보드 → Providers 에서 그 제공자를 먼저 연결해야 한다(브라우저 인증).
- 무료 티어는 클로드가 아니라 GLM/Qwen 계열이고 프롬프트가 외부로 나간다. 운영 데이터 에이전트에는 붙이지 말 것.

---

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
