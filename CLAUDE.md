# Claw Web

## 개요
Claude 에이전트 관리 웹 플랫폼. 프로젝트/에이전트를 웹 UI에서 관리하고 Claude CLI로 실시간 대화. 스킬 상속, 도구 권한 제어, 세션 관리를 제공.

## 빌드 & 실행
```bash
# 설치
./install.sh

# 또는 수동
npm install && npm --prefix client install
npm run build
npm start
```

## 기술 스택
- Server: Node.js + Express + WebSocket
- Client: React + TypeScript + Vite + TailwindCSS
- Data: JSON 파일 스토어
- Runner: Claude CLI (child_process.spawn)
