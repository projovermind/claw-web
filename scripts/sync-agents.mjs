#!/usr/bin/env node
/**
 * 에이전트 정의를 다른 claw-web 인스턴스에서 당겨온다 (기기 간 공유).
 *
 *   node scripts/sync-agents.mjs [--dry-run]
 *
 * 에이전트 정의는 name/systemPrompt/allowedTools 처럼 기계와 무관한 값이 대부분이고,
 * 딱 하나 workingDir 만 절대경로라 기계를 옮기면 깨진다. 그래서 이 스크립트는
 * pathMap 으로 workingDir 만 번역하고 나머지는 그대로 가져온다.
 *
 * 설정은 data/private/agent-sync.json (토큰이 들어가므로 private):
 *   {
 *     "source": "https://subinggrae.cc",
 *     "token": "...",
 *     "pathMap": {
 *       "/Volumes/Core/Vault/hivemind": "/home/user/vault",
 *       "/Volumes/Core/claw-web": "/home/user/claw-web"
 *     },
 *     "onUnmapped": "skip"
 *   }
 *
 * configPath 파일은 config-store 가 chokidar 로 감시하므로 재시작이 필요 없다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_CONFIG = path.join(REPO_ROOT, 'data/private/web-config.json');
const DRY_RUN = process.argv.includes('--dry-run');

const cfgFlag = process.argv.indexOf('--config');
const SYNC_CONFIG = cfgFlag !== -1 && process.argv[cfgFlag + 1]
  ? path.resolve(process.argv[cfgFlag + 1])
  : path.join(REPO_ROOT, 'data/private/agent-sync.json');

const c = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', d: '\x1b[2m', n: '\x1b[0m' };
const ok = (m) => console.log(`  ${c.g}✓${c.n} ${m}`);
const warn = (m) => console.log(`  ${c.y}⚠${c.n} ${m}`);
const die = (m) => { console.error(`  ${c.r}✗${c.n} ${m}`); process.exit(1); };

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// ── 설정 ────────────────────────────────────────────────
if (!fs.existsSync(SYNC_CONFIG)) {
  die(`설정이 없습니다: ${SYNC_CONFIG}\n     docs/agent-sync.md 의 예시를 참고해 만드세요.`);
}
const cfg = readJson(SYNC_CONFIG);
if (!cfg.source) die('agent-sync.json 에 source 가 없습니다.');
const pathMap = cfg.pathMap ?? {};
const onUnmapped = cfg.onUnmapped ?? 'skip';   // skip | clear | keep

const webConfig = readJson(WEB_CONFIG);
const targetPath = cfg.target ?? webConfig.configPath;
if (!targetPath) die('대상 경로를 못 찾았습니다 (web-config.json 의 configPath).');

// ── workingDir 번역 ─────────────────────────────────────
// 긴 접두사부터 검사한다 — /Volumes/Core 와 /Volumes/Core/claw-web 이 같이 있으면
// 더 구체적인 쪽이 이겨야 한다.
const rules = Object.entries(pathMap)
  .map(([from, to]) => [from.replace(/\/+$/, ''), to.replace(/\/+$/, '')])
  .sort((a, b) => b[0].length - a[0].length);

function remap(dir) {
  if (!dir) return { value: dir, mapped: true };
  const norm = dir.replace(/\/+$/, '');
  for (const [from, to] of rules) {
    // 접두사가 경로 경계에서 끊겨야 한다 — /Volumes/Core 가 /Volumes/Core2 를 먹으면 안 된다
    if (norm === from) return { value: to, mapped: true };
    if (norm.startsWith(from + '/')) return { value: to + norm.slice(from.length), mapped: true };
  }
  return { value: dir, mapped: false };
}

// ── 원본에서 가져오기 ───────────────────────────────────
const url = `${cfg.source.replace(/\/+$/, '')}/api/agents`;
console.log(`\n${c.d}  ← ${url}${c.n}`);

const res = await fetch(url, {
  headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {},
  signal: AbortSignal.timeout(30_000)
}).catch((err) => die(`가져오기 실패: ${err.message}`));

if (!res.ok) die(`가져오기 실패: HTTP ${res.status}`);
const remote = (await res.json()).agents;
if (!Array.isArray(remote)) die('응답에 agents 배열이 없습니다.');
ok(`원본 에이전트 ${remote.length}개`);

// ── 병합 ────────────────────────────────────────────────
// 기존 파일의 다른 최상위 키(channels 등)와, 원본에 없는 로컬 전용 에이전트는 보존한다.
const existing = fs.existsSync(targetPath) ? readJson(targetPath) : { agents: {} };
const localAgents = existing.agents ?? {};
const merged = { ...localAgents };

const skipped = [];
let synced = 0;
let cleared = 0;

for (const agent of remote) {
  const { id, ...rest } = agent;
  if (!id) continue;
  const { value, mapped } = remap(rest.workingDir);

  if (!mapped) {
    if (onUnmapped === 'skip') { skipped.push(`${rest.name ?? id} (${rest.workingDir})`); continue; }
    // clear: workingDir 를 지워 서버 cwd 로 떨어지지 않게 null 로 둔다
    if (onUnmapped === 'clear') { rest.workingDir = null; cleared++; }
  } else {
    rest.workingDir = value;
  }

  merged[id] = rest;
  synced++;
}

const remoteIds = new Set(remote.map((a) => a.id));
const localOnly = Object.keys(localAgents).filter((id) => !remoteIds.has(id));

ok(`반영 ${synced}개` + (cleared ? ` (workingDir 비움 ${cleared}개)` : ''));
if (localOnly.length) ok(`로컬 전용 유지 ${localOnly.length}개: ${localOnly.join(', ')}`);
if (skipped.length) {
  warn(`pathMap 에 없는 경로라 건너뜀 ${skipped.length}개:`);
  for (const s of skipped.slice(0, 10)) console.log(`      ${c.d}${s}${c.n}`);
  if (skipped.length > 10) console.log(`      ${c.d}... 외 ${skipped.length - 10}개${c.n}`);
}

if (DRY_RUN) {
  console.log(`\n${c.d}  --dry-run — 아무것도 쓰지 않았습니다.${c.n}\n`);
  process.exit(0);
}

// ── 쓰기 ────────────────────────────────────────────────
// 임시 파일에 쓰고 rename — 반쯤 쓰인 JSON 을 chokidar 가 물어 config 가 날아가는 걸 막는다.
if (fs.existsSync(targetPath)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.copyFileSync(targetPath, `${targetPath}.bak-sync-${stamp}`);
}
const out = { ...existing, agents: merged };
const tmp = `${targetPath}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
fs.renameSync(tmp, targetPath);

ok(`${targetPath} (총 ${Object.keys(merged).length}개)`);
console.log(`\n${c.d}  config-store 가 파일 변경을 감시하므로 재시작 없이 반영됩니다.${c.n}\n`);
