# Windows 설치 (WSL2)

claw-web 은 파일 스토어 + Claude CLI 전제라 Windows 네이티브가 아니라 **WSL2 Ubuntu** 안에서 돌린다.
아래 두 스크립트가 설치 이후의 모든 반복 작업(상주화·포트 노출·외부 공개)을 대신한다.

| 스크립트 | 실행 위치 | 하는 일 |
|---|---|---|
| `scripts/claw-web-wsl-setup.ps1` | Windows **관리자** PowerShell | systemd 활성화, `claw-web.service` 등록, LAN 포트포워딩, 로그온 자동 실행 |
| `scripts/claw-web-cf-tunnel.sh` | WSL 셸 | cloudflared 설치·터널 생성·DNS 등록·서비스 상주 → 외부 도메인 공개 |

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

`origin/main` 을 따라가는 타이머를 건다 (30분 주기).

```bash
bash scripts/self-update.sh --install-timer
bash scripts/self-update.sh --check          # 지금 몇 커밋 뒤처졌는지만 확인
```

재시작이 대화를 끊기 때문에 **워커가 하나라도 돌고 있으면 그 판을 통째로 건너뛰고**
다음 주기에 다시 시도한다. 커밋 안 된 로컬 변경이 있어도 손대지 않는다.
`package-lock.json` 이 바뀐 경우에만 `npm install`, `client/` 가 바뀐 경우에만 재빌드한다.

로그: `data/user/logs/self-update.log`

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
| 서비스 상태 확인 | `systemctl --user status claw-web cloudflared` |
