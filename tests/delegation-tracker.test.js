import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDelegationTracker } from '../server/lib/delegation-tracker.js';
import { extractDelegationSummary } from '../server/routes/chat/message-sender.js';

let dir;
const opts = () => ({
  filePath: path.join(dir, 'delegations.json'),
  reportsDir: path.join(dir, 'reports')
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-del-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('delegation tracker persistence', () => {
  it('survives a restart and reclaims interrupted delegations', async () => {
    const first = createDelegationTracker(opts());
    first.create({
      originSessionId: 'lead', targetSessionId: 'w1', targetAgentId: 'cw_server', task: 'A'
    });
    expect(first.isAgentBusy('cw_server')).toBe(true);
    await new Promise((r) => setTimeout(r, 400));

    const second = createDelegationTracker(opts());
    // The worker's process died with the server, so the agent must not stay busy
    // forever — otherwise every later delegation to it queues indefinitely.
    expect(second.isAgentBusy('cw_server')).toBe(false);
    expect(second.activeCount()).toBe(0);
    expect(second.listRecent()[0]).toMatchObject({ targetAgentId: 'cw_server', status: 'orphaned' });
  });

  it('keeps completed delegations in history across a restart', async () => {
    const first = createDelegationTracker(opts());
    first.create({ originSessionId: 'lead', targetSessionId: 'w1', targetAgentId: 'cw_ui', task: 'B' });
    first.complete('w1', 'done', '/tmp/r.md');
    await new Promise((r) => setTimeout(r, 400));

    const second = createDelegationTracker(opts());
    expect(second.listRecent()[0]).toMatchObject({ status: 'completed', result: 'done', reportPath: '/tmp/r.md' });
    expect(second.isAgentBusy('cw_ui')).toBe(false);
  });

  it('releases the agent slot on failure', () => {
    const t = createDelegationTracker(opts());
    t.create({ originSessionId: 'lead', targetSessionId: 'w1', targetAgentId: 'cw_server', task: 'C' });
    t.fail('w1', 'boom');
    expect(t.isAgentBusy('cw_server')).toBe(false);
  });

  it('saves the full worker response to disk', () => {
    const t = createDelegationTracker(opts());
    const p = t.saveFullReport('w1', 'the whole thing');
    expect(fs.readFileSync(p, 'utf8')).toBe('the whole thing');
  });
});

describe('delegation chain depth', () => {
  it('counts hops from the root planner', () => {
    const t = createDelegationTracker(opts());
    t.create({ originSessionId: 'lead', targetSessionId: 'w1', targetAgentId: 'a', task: 'x', depth: 1 });
    t.create({ originSessionId: 'w1', targetSessionId: 'w2', targetAgentId: 'b', task: 'y', depth: 2 });

    expect(t.getChainDepth('lead')).toBe(0);
    expect(t.getChainDepth('w1')).toBe(1);
    expect(t.getChainDepth('w2')).toBe(2);
  });

  it('still resolves depth after a parent delegation finishes', () => {
    const t = createDelegationTracker(opts());
    t.create({ originSessionId: 'lead', targetSessionId: 'w1', targetAgentId: 'a', task: 'x' });
    t.create({ originSessionId: 'w1', targetSessionId: 'w2', targetAgentId: 'b', task: 'y' });
    t.complete('w1', 'done');
    expect(t.getChainDepth('w2')).toBe(2);
  });
});

describe('extractDelegationSummary', () => {
  it('prefers the structured report block over truncation', () => {
    const text = `${'x'.repeat(5000)}
<report>
{"status":"blocked","summary":"DB 마이그레이션 실패","artifacts":["/a/b.sql"],"unresolved":["롤백 필요"],"nextAction":"리드 확인"}
</report>`;
    const { summary, structured } = extractDelegationSummary(text);
    expect(structured).toBe(true);
    expect(summary).toContain('blocked');
    expect(summary).toContain('DB 마이그레이션 실패');
    expect(summary).toContain('/a/b.sql');
    expect(summary).toContain('롤백 필요');
  });

  it('accepts a fenced json block inside the report tag', () => {
    const text = '<report>\n```json\n{"status":"completed","summary":"ok"}\n```\n</report>';
    const { summary, structured } = extractDelegationSummary(text);
    expect(structured).toBe(true);
    expect(summary).toContain('completed');
  });

  it('falls back to head+tail and flags it when no report block exists', () => {
    const text = `HEAD${'m'.repeat(5000)}TAIL`;
    const { summary, structured } = extractDelegationSummary(text);
    expect(structured).toBe(false);
    expect(summary).toContain('HEAD');
    expect(summary).toContain('TAIL');
  });

  it('treats malformed report json as unstructured rather than throwing', () => {
    const text = 'HEAD <report>{not json}</report> TAIL';
    const { summary, structured } = extractDelegationSummary(text);
    expect(structured).toBe(false);
    expect(summary).toContain('HEAD');
  });
});
