# Hivemind Web

Discord 봇을 대체하는 웹 관리 콘솔. 기존 `/Volumes/Core/claude-discord-bot/`의 `config.json`을 공유하며 별도 프로세스로 실행됨.

## Requirements

- Node 20+
- 기존 `claude-discord-bot` 레포 (config.json 공유)

## Dev Setup (one command)

```bash
cd hivemind-web
npm install                   # 백엔드 deps
npm --prefix client install   # 프론트 deps
npm run dev                   # server :3838 + client :5273 동시 실행
```

Open http://localhost:5273 — 사이드바(Dashboard/Agents/Chat/Settings) + 다크 테마.

### 포트 참고
- 백엔드 API + WebSocket: `3838`
- Vite 개발 서버: `5273` (5173은 Chartflow가 점유 중이라 회피)

## Production

```bash
npm run build      # client/dist/ 생성
npm start          # 정적 파일 + API + WS 같은 포트 3838
```

## Testing

```bash
npm test           # vitest (백엔드)
```

## Architecture

[설계 문서](../claude-discord-bot/docs/superpowers/specs/2026-04-15-hivemind-web-design.md)

| 구성요소 | 역할 |
|---------|------|
| `server/index.js` | Express + WebSocket 엔트리 |
| `server/lib/config-store.js` | `/Volumes/Core/claude-discord-bot/config.json` 읽기 + chokidar watch |
| `server/lib/health-check.js` | 봇 프로세스 살아있는지 (`/tmp/claude-discord-bot.pid`) |
| `client/src/pages/` | React 라우팅 페이지 |
| `web-config.json` | 기능 토글·포트·경로 설정 |

## Phase Status

- ✅ **Phase 1** — Foundation + E2E slice (GET agents, dashboard, dark layout)
- 🚧 **Phase 2** — Drag-and-drop + Projects + WebSocket sync
- 🚧 **Phase 3** — Multi-session chat + streaming runner + tool-use UI
- 🚧 **Phase 4** — Backend/model manager + austerity sync
- 🚧 **Phase 5** — Mobile + PWA + LaunchAgent
