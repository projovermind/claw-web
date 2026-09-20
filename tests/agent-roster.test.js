import { describe, it, expect } from 'vitest';
import { describeAgent, buildRoster } from '../server/lib/agent-roster.js';

describe('describeAgent', () => {
  it('역할이 있으면 역할 줄을 붙인다', () => {
    const agent = { systemPrompt: '> **역할**: cw server 엔지니어\n' };
    expect(describeAgent('cw_server', agent)).toBe('- cw_server — cw server 엔지니어');
  });

  it('역할이 없으면 name 을 붙인다', () => {
    const agent = { name: '서버' };
    expect(describeAgent('cw_server', agent)).toBe('- cw_server — 서버');
  });

  it('역할도 name 도 없으면 ID 만', () => {
    expect(describeAgent('cw_server', {})).toBe('- cw_server');
  });

  it('host 가 있으면 줄 끝에 [원격: <host>] 를 붙인다', () => {
    const agent = { systemPrompt: '> **역할**: cw server 엔지니어\n', host: 'win.subinggrae.cc' };
    expect(describeAgent('cw_server', agent)).toBe(
      '- cw_server — cw server 엔지니어 [원격: win.subinggrae.cc]'
    );
  });

  it('host 가 있고 역할/name 이 없으면 ID 뒤에 붙인다', () => {
    expect(describeAgent('cw_server', { host: 'win.subinggrae.cc' })).toBe(
      '- cw_server [원격: win.subinggrae.cc]'
    );
  });
});

describe('buildRoster', () => {
  it('ID 가 없으면 emptyText 를 반환한다', () => {
    expect(buildRoster([], {}, '없음')).toBe('없음');
  });

  it('원격 에이전트가 없으면 안내 줄을 붙이지 않는다', () => {
    const agents = { a: { name: 'A' }, b: { name: 'B' } };
    const roster = buildRoster(['a', 'b'], agents);
    expect(roster).toBe('- a — A\n- b — B');
  });

  it('원격 에이전트가 하나라도 있으면 명단 아래 안내 줄을 붙인다', () => {
    const agents = { a: { name: 'A' }, b: { name: 'B', host: 'win.subinggrae.cc' } };
    const roster = buildRoster(['a', 'b'], agents);
    expect(roster).toBe(
      '- a — A\n- b — B [원격: win.subinggrae.cc]\n원격 에이전트와는 파일이 공유되지 않습니다 — 결과는 커밋·푸시로 받습니다.'
    );
  });
});
