#!/usr/bin/env node
// scripts/analyze-tokens.mjs
// 활성 세션의 토큰 사용 패턴 분석
//
// 사용법:
//   node scripts/analyze-tokens.mjs                      # 최근 7일 활성 세션 요약
//   node scripts/analyze-tokens.mjs --days=30            # 기간 변경
//   node scripts/analyze-tokens.mjs --top=20             # 상위 N개 세션
//   node scripts/analyze-tokens.mjs --all                # 보관됨 포함 전체
//   node scripts/analyze-tokens.mjs --session=sess_xxx   # 단일 세션 메시지별 ↑↓ + 누적
//   node scripts/analyze-tokens.mjs --cumulative         # 전체 시간대별 누적 추이
//   node scripts/analyze-tokens.mjs --json               # JSON 출력
//
// 정의:
//   ↑ inputTokens, ↓ outputTokens, ⟳ cacheReadTokens
//   "활성" = _archived !== true 이고 updatedAt 가 --days 이내
//   런타임 실행중 세션(runner.activeIds)과는 별개 — 영속 데이터만 본다

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const STORE_DIR = path.join(REPO_ROOT, 'data/private/sessions-store');

// ── arg parsing ─────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const args = { days: 7, top: 10 };
for (const a of argv) {
  if (a === '--all') args.all = true;
  else if (a === '--json') args.json = true;
  else if (a === '--cumulative') args.cumulative = true;
  else if (a.startsWith('--days=')) args.days = parseInt(a.slice(7), 10) || 7;
  else if (a.startsWith('--top=')) args.top = parseInt(a.slice(6), 10) || 10;
  else if (a.startsWith('--session=')) args.session = a.slice(10);
  else if (a === '-h' || a === '--help') {
    console.log(fs.readFileSync(url.fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 18).join('\n'));
    process.exit(0);
  }
}

// ── load index ──────────────────────────────────────────────────────────────
const indexPath = path.join(STORE_DIR, '_index.json');
if (!fs.existsSync(indexPath)) {
  console.error(`[analyze-tokens] index not found: ${indexPath}`);
  process.exit(1);
}
const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
const cutoff = Date.now() - args.days * 24 * 60 * 60 * 1000;

const candidates = Object.values(index.sessions ?? {}).filter((meta) => {
  if (!args.all && meta._archived) return false;
  if (args.session) return meta.id === args.session;
  if (args.all) return true;
  const t = new Date(meta.updatedAt ?? 0).getTime();
  return Number.isFinite(t) && t >= cutoff;
});

// ── analyze each session ────────────────────────────────────────────────────
function analyzeSession(meta) {
  const file = path.join(STORE_DIR, `${meta.id}.json`);
  if (!fs.existsSync(file)) return null;
  const session = JSON.parse(fs.readFileSync(file, 'utf8'));
  const msgs = Array.isArray(session.messages) ? session.messages : [];

  let cumIn = 0;
  let cumOut = 0;
  let cumCache = 0;
  let peakIn = 0;
  let peakOut = 0;
  const perMessage = [];
  for (const m of msgs) {
    const u = m?.usage ?? {};
    const inT = u.inputTokens ?? 0;
    const outT = u.outputTokens ?? 0;
    const cacheT = u.cacheReadTokens ?? 0;
    cumIn += inT;
    cumOut += outT;
    cumCache += cacheT;
    if (inT > peakIn) peakIn = inT;
    if (outT > peakOut) peakOut = outT;
    perMessage.push({
      ts: m?.ts ?? null,
      role: m?.role ?? '?',
      model: m?.model ?? null,
      inputTokens: inT,
      outputTokens: outT,
      cacheReadTokens: cacheT,
      sumIO: inT + outT,
      cumIn,
      cumOut,
      cumCache,
    });
  }

  return {
    id: meta.id,
    title: meta.title,
    agentId: meta.agentId,
    updatedAt: meta.updatedAt,
    messageCount: msgs.length,
    totalInput: cumIn,
    totalOutput: cumOut,
    totalCache: cumCache,
    totalIO: cumIn + cumOut,
    peakInput: peakIn,
    peakOutput: peakOut,
    avgIO: msgs.length ? Math.round((cumIn + cumOut) / msgs.length) : 0,
    perMessage,
  };
}

const analyses = [];
for (const meta of candidates) {
  const a = analyzeSession(meta);
  if (a) analyses.push(a);
}

// ── output ──────────────────────────────────────────────────────────────────
function fmt(n) {
  return n.toLocaleString('en-US');
}
function trunc(s, n) {
  if (!s) return '';
  return s.length <= n ? s.padEnd(n, ' ') : s.slice(0, n - 1) + '…';
}

// JSON 출력 모드
if (args.json) {
  const payload = args.session
    ? analyses[0] ?? null
    : {
        scope: args.all ? 'all' : `last_${args.days}d`,
        sessionCount: analyses.length,
        totals: analyses.reduce(
          (acc, a) => {
            acc.input += a.totalInput;
            acc.output += a.totalOutput;
            acc.cache += a.totalCache;
            acc.messages += a.messageCount;
            return acc;
          },
          { input: 0, output: 0, cache: 0, messages: 0 }
        ),
        sessions: analyses.map(({ perMessage, ...rest }) => rest),
      };
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

// 단일 세션 상세
if (args.session) {
  const a = analyses[0];
  if (!a) {
    console.error(`[analyze-tokens] session not found or filtered out: ${args.session}`);
    process.exit(1);
  }
  console.log(`# Session ${a.id}`);
  console.log(`title:    ${a.title}`);
  console.log(`agent:    ${a.agentId}`);
  console.log(`updated:  ${a.updatedAt}`);
  console.log(`messages: ${a.messageCount}   total ↑${fmt(a.totalInput)}  ↓${fmt(a.totalOutput)}  ⟳${fmt(a.totalCache)}`);
  console.log('');
  console.log('  #  ts                        role       ↑ in        ↓ out      ⟳ cache    Σ↑↓        cumΣ↑↓');
  console.log('  ─  ────────────────────────  ─────────  ─────────  ─────────  ─────────  ─────────  ──────────');
  let cumIO = 0;
  a.perMessage.forEach((m, i) => {
    cumIO += m.sumIO;
    const ts = (m.ts ?? '').slice(0, 19).replace('T', ' ').padEnd(24, ' ');
    console.log(
      `  ${String(i + 1).padStart(2, ' ')}  ${ts}  ${m.role.padEnd(9, ' ')}  ${fmt(m.inputTokens).padStart(9)}  ${fmt(m.outputTokens).padStart(9)}  ${fmt(m.cacheReadTokens).padStart(9)}  ${fmt(m.sumIO).padStart(9)}  ${fmt(cumIO).padStart(10)}`
    );
  });
  process.exit(0);
}

// 누적 시간대별 추이 (전체 활성 메시지 합산)
if (args.cumulative) {
  const all = analyses.flatMap((a) =>
    a.perMessage.map((m) => ({ ...m, sessionId: a.id }))
  );
  all.sort((x, y) => (x.ts ?? '').localeCompare(y.ts ?? ''));

  // 일자별 버킷
  const buckets = new Map();
  for (const m of all) {
    const day = (m.ts ?? '').slice(0, 10);
    if (!day) continue;
    const b = buckets.get(day) ?? { input: 0, output: 0, cache: 0, msgs: 0 };
    b.input += m.inputTokens;
    b.output += m.outputTokens;
    b.cache += m.cacheReadTokens;
    b.msgs += 1;
    buckets.set(day, b);
  }
  const days = [...buckets.keys()].sort();
  console.log(`# 시간대별 토큰 추이 (활성 ${analyses.length}개 세션, 최근 ${args.all ? 'ALL' : args.days + 'd'})`);
  console.log('');
  console.log('  date        msgs      ↑ input       ↓ output      ⟳ cache       cum Σ↑↓');
  console.log('  ──────────  ────  ───────────  ───────────  ────────────  ────────────');
  let cum = 0;
  for (const d of days) {
    const b = buckets.get(d);
    cum += b.input + b.output;
    console.log(
      `  ${d}  ${String(b.msgs).padStart(4)}  ${fmt(b.input).padStart(11)}  ${fmt(b.output).padStart(11)}  ${fmt(b.cache).padStart(12)}  ${fmt(cum).padStart(12)}`
    );
  }
  process.exit(0);
}

// 기본: 세션별 요약 (Top N)
analyses.sort((a, b) => b.totalIO - a.totalIO);
const totals = analyses.reduce(
  (acc, a) => {
    acc.input += a.totalInput;
    acc.output += a.totalOutput;
    acc.cache += a.totalCache;
    acc.messages += a.messageCount;
    return acc;
  },
  { input: 0, output: 0, cache: 0, messages: 0 }
);

console.log(
  `# 활성 세션 토큰 사용 요약 (scope=${args.all ? 'all' : `last_${args.days}d`}, sessions=${analyses.length})`
);
console.log(
  `  TOTAL: ↑${fmt(totals.input)}  ↓${fmt(totals.output)}  ⟳cache ${fmt(totals.cache)}  msgs ${fmt(totals.messages)}`
);
console.log('');
console.log(
  '  rank  session_id          agent              msgs   ↑ input       ↓ output      Σ↑↓           avg/msg   updated'
);
console.log(
  '  ────  ──────────────────  ─────────────────  ────  ───────────  ───────────  ────────────  ────────  ───────────────────'
);
const top = analyses.slice(0, args.top);
top.forEach((a, i) => {
  console.log(
    `  ${String(i + 1).padStart(4)}  ${trunc(a.id, 18)}  ${trunc(a.agentId ?? '?', 17)}  ${String(a.messageCount).padStart(4)}  ${fmt(a.totalInput).padStart(11)}  ${fmt(a.totalOutput).padStart(11)}  ${fmt(a.totalIO).padStart(12)}  ${fmt(a.avgIO).padStart(8)}  ${(a.updatedAt ?? '').slice(0, 19).replace('T', ' ')}`
  );
});

if (analyses.length > args.top) {
  console.log(`  … (+${analyses.length - args.top} more, --top=N 으로 확장)`);
}
console.log('');
console.log('힌트:');
console.log('  - 단일 세션 메시지별 ↑↓+누적:  node scripts/analyze-tokens.mjs --session=' + (top[0]?.id ?? 'sess_xxx'));
console.log('  - 일자별 누적 추이:           node scripts/analyze-tokens.mjs --cumulative');
console.log('  - JSON 출력:                  node scripts/analyze-tokens.mjs --json');
