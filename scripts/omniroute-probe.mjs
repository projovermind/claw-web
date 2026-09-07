#!/usr/bin/env node
/**
 * OmniRoute 무료 모델 선별기.
 *
 * 무료 티어는 수시로 죽는다. 이 스크립트는 게이트웨이의 모델 목록을 훑어서
 * "키 없이 살아 있고, 실제로 tool_use 블록을 내보내는" 모델만 골라낸다.
 * 그 결과가 server/routes/backends.js 의 omniroute 프리셋 models 맵이 된다.
 *
 *   node scripts/omniroute-probe.mjs                 # 프리셋에 실린 모델만 재검증
 *   node scripts/omniroute-probe.mjs --all           # 무료로 붙을 만한 제공자 전체를 훑는다
 *   node scripts/omniroute-probe.mjs --provider oc   # 특정 제공자만
 *   node scripts/omniroute-probe.mjs --json          # 프리셋에 붙여넣을 models 맵 출력
 *
 * 토큰은 claw-web 에 등록된 OMNIROUTE_TOKEN 을 자동으로 읽는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.OMNIROUTE_URL || 'http://127.0.0.1:20128';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

/** 키 없이 붙는 게 확인된 제공자. 나머지는 대시보드에서 브라우저 인증이 필요하다. */
const FREE_PROVIDERS = ['oc', 'cfp', 'auto'];

function token() {
  if (process.env.OMNIROUTE_TOKEN) return process.env.OMNIROUTE_TOKEN;
  for (const f of ['data/private/secrets.json', 'data/user/secrets.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(REPO, f), 'utf8'));
      const found = Object.values(j).find((e) => e?.envKey === 'OMNIROUTE_TOKEN');
      if (found?.value) return found.value;
    } catch { /* 없으면 다음 후보 */ }
  }
  return null;
}

const KEY = token();
if (!KEY) {
  console.error('OMNIROUTE_TOKEN 을 찾지 못했다. scripts/omniroute-setup.sh 를 먼저 돌리거나');
  console.error('OMNIROUTE_TOKEN=... 으로 넘겨라.');
  process.exit(1);
}

const HEADERS = {
  'Content-Type': 'application/json',
  'x-api-key': KEY,
  authorization: `Bearer ${KEY}`,
  'anthropic-version': '2023-06-01',
};

/** OmniRoute 응답에는 날 제어문자가 섞여 나올 때가 있어서 JSON.parse 전에 털어낸다. */
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
function parse(raw) {
  try { return JSON.parse(raw); } catch { return JSON.parse(raw.replace(CTRL, ' ')); }
}

async function post(body, ms = 180_000) {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: 'POST', headers: HEADERS, body: JSON.stringify(body), signal: ac.signal,
    });
    const raw = await res.text();
    if (!res.ok) return { err: `HTTP ${res.status}`, ms: Date.now() - t0 };
    return { data: parse(raw), ms: Date.now() - t0 };
  } catch (e) {
    return { err: e.name === 'AbortError' ? '시간초과' : e.message.slice(0, 40), ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

const TOOLS = [{
  name: 'read_file',
  description: 'Read a file from disk',
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}];

async function probe(model) {
  const r = await post({
    model, max_tokens: 700, tools: TOOLS,
    messages: [{ role: 'user', content: 'Read the file /etc/hosts. Use the read_file tool.' }],
  });
  if (r.err) return { model, ok: false, why: r.err, ms: r.ms };

  const blocks = r.data?.content ?? [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (blocks.some((b) => b.type === 'tool_use')) return { model, ok: true, tool: 'call', ms: r.ms };
  // 모델이 툴을 부르려 했는데 게이트웨이가 tool_use 로 되돌리지 못한 경우 — 에이전트에는 못 쓴다.
  if (/jsonrpc|mcp_/i.test(text)) return { model, ok: true, tool: 'text', ms: r.ms };
  return { model, ok: true, tool: 'none', ms: r.ms };
}

async function listModels() {
  const res = await fetch(`${BASE}/v1/models`, { headers: HEADERS });
  return (parse(await res.text()).data ?? []).map((m) => m.id);
}

async function candidates() {
  const only = val('--provider');
  if (only) return (await listModels()).filter((id) => id.split('/')[0] === only);
  if (has('--all')) return (await listModels()).filter((id) => FREE_PROVIDERS.includes(id.split('/')[0]));

  // 기본: 프리셋에 실려 있는 모델만 재검증한다.
  const src = fs.readFileSync(path.join(REPO, 'server/routes/backends.js'), 'utf8');
  const block = src.slice(src.indexOf("id: 'omniroute'"));
  const open = block.indexOf('models: {');
  const models = block.slice(open, block.indexOf('}', open));
  return [...models.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
}

const LABEL = { call: '✅ 호출', text: '⚠️ 텍스트만', none: '❌ 안 부름' };

const models = await candidates();
console.error(`${models.length}개 후보를 ${BASE} 로 검증한다.\n`);
console.error(`${'모델'.padEnd(40)} ${'툴'.padEnd(12)} 속도`);
console.error('-'.repeat(64));

const good = [];
for (const m of models) {
  const r = await probe(m);
  if (!r.ok) { console.error(`${m.padEnd(40)} ${`💀 ${r.why}`.padEnd(12)}`); continue; }
  console.error(`${m.padEnd(40)} ${LABEL[r.tool].padEnd(12)} ${(r.ms / 1000).toFixed(1)}s`);
  if (r.tool === 'call') good.push({ id: m, ms: r.ms });
}

console.error(`\n에이전트에 쓸 수 있는 모델 ${good.length}개 (tool_use 를 실제로 내보냄).`);
if (has('--json')) {
  good.sort((a, b) => a.ms - b.ms);
  const map = {};
  for (const g of good) map[g.id.split('/').pop().replace(/-free$/, '')] = g.id;
  console.log(JSON.stringify(map, null, 2));
}
