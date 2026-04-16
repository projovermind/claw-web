# Mac mini 부팅 자동 실행

두 개의 LaunchAgent가 로그인 시 자동 기동됨.

## 파일

| LaunchAgent plist | Wrapper script | Logs |
|---|---|---|
| `~/Library/LaunchAgents/com.hivemind.web.plist` | `~/bin/hivemind-web-start.sh` | `~/Library/Logs/hivemind-web.{out,err}.log` |
| `~/Library/LaunchAgents/com.hivemind.tailscaled.plist` | `~/bin/tailscaled-start.sh` | `~/Library/Logs/tailscaled.{out,err}.log` |

## 왜 shell wrapper?

- `/Volumes/Core`는 **exFAT 외장 디스크** — launchd가 exFAT 실행 권한을 제대로 신뢰 못 해서 `EX_CONFIG (78)`로 실패함.
- Wrapper는 login shell로 돌면서 (a) `/Volumes/Core` mount 대기, (b) `.zshrc` source (→ `ANTHROPIC_API_KEY` 등 상속), (c) node exec.

## Tailscale 상태

- 모드: userspace-networking (root 불필요)
- State 경로: `~/Library/Application Support/tailscaled-userspace/` (재부팅 시 재인증 불필요)
- 내 IP: `100.106.13.76` — 같은 tailnet 기기에서 `http://100.106.13.76:3838` 접속

## 운영 명령

```bash
# 상태 확인
launchctl list | grep hivemind
lsof -i :3838 -sTCP:LISTEN -P -n
tail ~/Library/Logs/hivemind-web.err.log

# 수동 재시작
launchctl unload ~/Library/LaunchAgents/com.hivemind.web.plist
launchctl load ~/Library/LaunchAgents/com.hivemind.web.plist

# Tailscale 상태
tailscale --socket=/tmp/tailscaled.sock status
```

## 접속 방법

| 위치 | URL |
|---|---|
| Mac mini 본체 | http://localhost:3838 |
| 같은 Wi-Fi LAN | http://172.30.1.26:3838 (또는 http://subinggraeui-Macmini.local:3838) |
| 외부(tailnet) | http://100.106.13.76:3838 |

모든 경우 로그인 비밀번호: `930214` (처음 접속 시 LoginDialog에 입력).

## 비밀번호 / 토큰 분실 시

`web-config.json`의 `auth.enabled`를 `false`로 바꾸거나 `auth.token`을 다른 값으로 재설정하고 LaunchAgent 재시작.
