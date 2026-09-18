import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquire } from '../server/lib/file-leases.js';
import { buildDeployGuardContext } from '../server/lib/working-context-injector.js';

let repo;
let leaseDir;

function git(...args) {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

beforeEach(() => {
  leaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-dg-leases-'));
  process.env.CLAW_WEB_LEASE_DIR = leaseDir;

  // 깨끗하고 동기화된 트리 — deploy-guard 가 아무것도 내보내지 않는 기준 상태.
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claw-dg-repo-')));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'a.js'), '//');
  git('add', '.');
  git('commit', '-qm', 'init');
});

afterEach(() => {
  delete process.env.CLAW_WEB_LEASE_DIR;
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(leaseDir, { recursive: true, force: true });
});

describe('deploy-guard — 파일 임대 현황', () => {
  it('stays silent when nothing is leased', () => {
    // 임대가 없으면 섹션은커녕 블록 자체가 없다 — 토큰을 쓰지 않는다.
    expect(buildDeployGuardContext(repo)).toBeNull();
  });

  it('renders the block for leases alone, even on a clean tree', () => {
    acquire({ root: repo, rel: 'a.js', sessionId: 'sess_other', agentId: 'cw_planner' });

    const out = buildDeployGuardContext(repo, { sessionId: 'sess_me' });
    expect(out).toContain('현재 파일 임대');
    expect(out).toContain('`a.js` ← cw_planner');
    expect(out).toContain('PreToolUse 훅이 Edit/Write 와');
  });

  it('marks the caller\'s own leases so it does not warn a session off its own file', () => {
    acquire({ root: repo, rel: 'a.js', sessionId: 'sess_me' });
    acquire({ root: repo, rel: 'b.js', sessionId: 'sess_other', label: '세션B' });

    const out = buildDeployGuardContext(repo, { sessionId: 'sess_me' });
    expect(out).toMatch(/`a\.js` ← 나/);
    expect(out).toMatch(/`b\.js` ← 세션B/);
  });

  it('falls back to the session id when no label or agent is recorded', () => {
    acquire({ root: repo, rel: 'a.js', sessionId: 'sess_bare' });
    expect(buildDeployGuardContext(repo)).toContain('← sess_bare');
  });

  it('caps the list so a busy tree cannot flood every turn', () => {
    for (let i = 0; i < 14; i++) acquire({ root: repo, rel: `f${i}.js`, sessionId: `s${i}` });

    const out = buildDeployGuardContext(repo, { sessionId: 'sess_me' });
    const shown = out.split('\n').filter((l) => /^- `f\d+\.js`/.test(l));
    expect(shown).toHaveLength(10);
    expect(out).toContain('(+4건 더)');
  });

  it('ignores a lease ledger belonging to a different working tree', () => {
    acquire({ root: '/some/other/tree', rel: 'a.js', sessionId: 'sess_other' });
    expect(buildDeployGuardContext(repo)).toBeNull();
  });

  it('does not take the turn down if the ledger is unreadable', () => {
    fs.rmSync(leaseDir, { recursive: true, force: true });
    fs.writeFileSync(leaseDir, 'not a directory');
    expect(() => buildDeployGuardContext(repo)).not.toThrow();
  });
});
