#!/usr/bin/env node
/**
 * PreToolUse 훅 — 다른 세션이 편집 중인 파일을 이 세션이 덮어쓰는 것을 막는다.
 *
 *   등록: claw-web 설정 → Hooks 에 event=PreToolUse, matcher=* 로
 *         `node /Volumes/Core/claw-web/server/hooks/lease-guard.js`
 *   입력: stdin JSON { session_id, cwd, tool_name, tool_input }
 *   출력: exit 0 = 허용 / exit 2 = 차단 (stderr 가 모델에게 전달된다)
 *
 * 임대 소유자 키는 session_id 다 — claw-web 은 워크트리를 나누지 않고 모든 세션이
 * 같은 워킹트리를 그대로 쓰기 때문이다. (Sonamoo 는 워크트리가 갈리므로 워크트리가
 * 키였다. 여기서 워크트리를 키로 잡으면 모든 세션이 같은 소유자가 되어 아무것도
 * 못 막는다.)
 *
 * 훅 자신의 버그로 모든 편집을 막아 버리면 안 되므로, 차단 경로가 아닌 곳에서 난
 * 예외는 전부 허용(exit 0)으로 흘린다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { targetsFor } from '../lib/lease-guard.js';
import { acquire, release, list, fmtAge, TTL_MS } from '../lib/file-leases.js';

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function block(msg) {
  process.stderr.write(`⛔ [lease-guard] ${msg}\n`);
  process.exit(2);
}

/** 워킹트리 루트 = git toplevel. git 이 아니면 cwd 자체를 루트로 본다. */
function repoRoot(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (out) return path.resolve(out);
  } catch { /* git 아님 */ }
  return path.resolve(cwd);
}

function main() {
  let input;
  try { input = JSON.parse(readStdin() || '{}'); } catch { return; }

  // env 가 먼저다 — CLAW_WEB_SESSION_ID 는 러너가 내려준 claw-web 세션 id 이고,
  // stdin 의 session_id 는 Claude CLI 세션 id 라 압축/resume 때 갈린다.
  const sessionId = process.env.CLAW_WEB_SESSION_ID || input.session_id;
  const cwd = input.cwd || process.cwd();
  if (!sessionId) return; // 소유자를 모르면 임대 자체가 성립하지 않는다

  const root = repoRoot(cwd);
  const targets = targetsFor(input, { cwd, root });
  if (targets.length === 0) return;

  for (const rel of targets) {
    const other = acquire({
      root,
      rel,
      sessionId,
      agentId: process.env.CLAW_WEB_AGENT_ID || null,
      label: process.env.CLAW_WEB_SESSION_LABEL || null
    });
    if (!other) continue;

    const now = Date.now();
    const who = other.label || other.agentId || other.sessionId;
    block(
      `같은 파일을 다른 세션이 편집 중입니다 — 이 워킹트리는 세션끼리 공유되므로 지금 고치면 그쪽 편집이 조용히 사라집니다.\n` +
      `  파일: ${rel}\n` +
      `  누가: ${who} (session ${other.sessionId})\n` +
      `  언제: ${fmtAge(now - other.since)} 전부터 · 마지막 편집 ${fmtAge(now - other.touchedAt)} 전\n` +
      `  할 일: 그 세션이 끝난 뒤 다시 시도하거나, 이 수정을 그쪽 세션에 맡기세요. 다른 파일 작업은 그대로 진행해도 됩니다.\n` +
      `  임대는 마지막 편집 ${Math.round(TTL_MS / 60000)}분 뒤 자동 소멸합니다. 현황: node server/hooks/lease-guard.js --ls`
    );
  }
}

const releaseIdx = process.argv.indexOf('--release');

if (process.argv.includes('--ls')) {
  const root = repoRoot(process.cwd());
  const leases = list(root);
  if (leases.length === 0) {
    console.log('살아있는 임대 없음');
  } else {
    const now = Date.now();
    for (const l of leases) {
      console.log(`${l.rel}\n    ← ${l.label || l.agentId || l.sessionId} · ${fmtAge(now - l.since)} 전부터 · 만료까지 ${fmtAge(l.expiresAt - now)}`);
    }
  }
} else if (releaseIdx !== -1) {
  // 세션이 파일을 다 고쳤는데 TTL 90분이 남아 다른 세션을 막고 있을 때 쓴다.
  const sessionId = process.argv[releaseIdx + 1] || process.env.CLAW_WEB_SESSION_ID;
  if (!sessionId) {
    console.error('사용법: lease-guard.js --release <세션 id> [파일 상대경로]');
    process.exit(1);
  }
  console.log(`해제 ${release({ root: repoRoot(process.cwd()), sessionId, rel: process.argv[releaseIdx + 2] })}건`);
} else {
  try {
    main();
  } catch (err) {
    process.stderr.write(`[lease-guard] 내부 오류(허용으로 처리): ${err?.message}\n`);
  }
}
