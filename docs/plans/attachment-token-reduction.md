# 첨부 이미지/파일 토큰 절감

## 배경
`scripts/analyze-tokens.mjs` 실측: `sess_aO2e5MloI-xv` (cf_drawing) 8 메시지에 입력 2.86M 토큰.
원인은 누적된 이미지 첨부. 클라이언트에서 base64 로 업로드하고, 메시지에는 `위 경로의 파일들을 Read 도구로 확인해주세요` 형태로 path 가 전달되어 매 턴 Read → 컨텍스트 폭발.

## 현재 흐름
1. 클라이언트: paste/drop → POST `/api/uploads` (base64) → `data/user/uploads/<id>-<filename>` 저장
2. `uploadsDir` 제한: 20MB/파일, 리사이즈/압축 없음 (`server/routes/uploads.js:15`)
3. 메시지에 절대 경로 포함 → Claude CLI 가 매 턴 Read → 누적

## 개선 대상

### A. 업로드 시 이미지 자동 리사이즈
**위치**: `server/routes/uploads.js:33-58`
- `contentType.startsWith('image/')` 인 경우 **sharp** 으로 max 1280px(longest edge), JPEG q=82 변환
- PNG → 투명도 보존 시 PNG 유지, 아니면 JPEG 변환
- 변환 전/후 byte 수 로그
- `sharp` 의존성 추가 필요 (이미 native 빌드 — 무거우면 `--ignore-scripts` 환경 호환성 검토)

### B. 컨텍스트 placeholder 치환 (N턴 경과)
**위치**: `server/routes/chat/utils.js` 의 `buildConversationSummary` 또는 메시지 페이로드 빌더
- 5턴 이전의 이미지 첨부 라인을 `[이전 첨부: <filename> — 필요 시 명시적으로 다시 첨부]` 로 치환
- 메시지에서 `/uploads/` 경로 패턴 매칭으로 식별
- 원본 파일은 유지(접근 가능) — 컨텍스트만 가벼워짐
- ⚠️ **적용 범위 한정**: 이 단계는 **fresh-start 경로에만** 적용된다 (`message-sender.js` 의 silent_fallback / context_length 재시도 / `claudeSessionId === null` 진입). 일반 턴은 `--resume` 으로 CLI 가 자체 히스토리를 들고 있어 서버가 placeholder 로 압축할 자리가 없음. 일반 턴 토큰 절감의 본 약발은 단계 A(서버 리사이즈).

### C. 첨부 메타데이터 명시
**위치**: 클라이언트 메시지 composer + 서버 메시지 저장 스키마
- 메시지에 `attachments: [{id, filename, path, type, sizeBytes, dimensions}]` 필드 추가
- 본문 텍스트에 path 박는 대신 메타필드 사용 → A/B 처리 시 정확한 식별

### D. 클라이언트 사전 압축 (옵션)
**위치**: `client/src/...` paste/drop 핸들러
- 업로드 전 `<canvas>` 로 클라이언트 측 리사이즈 (모바일 데이터 절감)
- A 와 중복이지만 네트워크 비용 큰 모바일에 유용

## 구현 단계
1. **C** 첨부 메타데이터 — 후속 작업의 기반
2. **A** 서버 측 리사이즈 — sharp 통합, 즉효
3. **B** placeholder 치환 — A 후 안전하게 진행
4. **D** 클라이언트 사전 압축 — 마지막, 선택

## 검증
- 1280×720 스크린샷 업로드 → 디스크 용량 < 200KB, 토큰 < 700 추정
- N=10턴 후 placeholder 치환 동작 확인 (수동)
- `analyze-tokens.mjs --session=<id>` before/after

## 위험
- sharp native 모듈 — `./install.sh` 에 빌드 의존성 추가 필요
- 메시지 placeholder 치환이 사용자가 "그 이미지 다시 봐줘" 요청 시 부자연스러움 → "다시 첨부해주세요" 안내 메시지로 보완
- 기존 첨부된 데이터 마이그레이션은 불필요 (점진 적용)
