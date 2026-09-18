import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bashWriteTargets, resolveTargets, targetsFor, stripHeredocs, editTarget } from '../server/lib/lease-guard.js';

/** 실제 트리 하나를 만들어 둔다 — resolveTargets 는 존재 검사를 하므로 가짜 경로로는 못 본다. */
let root;
const rt = (raw, cwd = root) => resolveTargets([raw].flat(), { cwd, root });
const fromBash = (cmd, cwd = root) => resolveTargets(bashWriteTargets(cmd), { cwd, root });

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claw-guard-')));
  fs.mkdirSync(path.join(root, 'server', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'user'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server', 'lib', 'compact.js'), '//');
  fs.writeFileSync(path.join(root, 'node_modules', 'x', 'index.js'), '//');
  fs.writeFileSync(path.join(root, 'data', 'user', 'config.json'), '{}');
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('lease-guard — Bash 쓰기 대상 추출', () => {
  it('catches redirects, including the cat > form', () => {
    expect(fromBash('cat > server/lib/new.js')).toEqual(['server/lib/new.js']);
    expect(fromBash('echo hi >> server/lib/compact.js')).toEqual(['server/lib/compact.js']);
    expect(fromBash('printf "x" > "server/lib/new file.js"')).toEqual(['server/lib/new file.js']);
  });

  it('catches sed -i in both GNU and BSD spellings', () => {
    expect(fromBash("sed -i 's/a/b/' server/lib/compact.js")).toEqual(['server/lib/compact.js']);
    expect(fromBash("sed -i '' 's/a/b/' server/lib/compact.js")).toEqual(['server/lib/compact.js']);
    expect(fromBash("sed --in-place 's/a/b/' server/lib/compact.js")).toEqual(['server/lib/compact.js']);
    // 스크립트 자체는 파일이 아니다 — 부모 디렉터리가 없어 걸러진다.
    expect(fromBash("sed -i.bak 's|server/lib/x|y|' server/lib/compact.js")).toEqual(['server/lib/compact.js']);
  });

  it('leaves a read-only sed alone', () => {
    expect(fromBash("sed -n '1,20p' server/lib/compact.js")).toEqual([]);
  });

  it('catches tee, with or without -a', () => {
    expect(fromBash('echo hi | tee server/lib/compact.js')).toEqual(['server/lib/compact.js']);
    expect(fromBash('echo hi | tee -a server/lib/new.js')).toEqual(['server/lib/new.js']);
  });

  it('is not fooled by stderr redirection or comparison operators', () => {
    expect(fromBash('npm run build 2>&1 | grep error')).toEqual([]);
    expect(fromBash('node -e "if (a >= b) {}"')).toEqual([]);
  });

  it('ignores writes described inside a heredoc body', () => {
    const cmd = [
      "cat > server/lib/new.js <<'EOF'",
      '// 문서 예시: sed -i 로 server/lib/compact.js 를 고치고 tee data/x 로 남긴다',
      'EOF'
    ].join('\n');
    // 실제로 쓰이는 것은 히어독 바깥의 new.js 하나뿐이다.
    expect(fromBash(cmd)).toEqual(['server/lib/new.js']);
  });

  it('strips heredocs without eating the rest of the command', () => {
    expect(stripHeredocs("cat <<'EOF' > a.js\nbody\nEOF\n")).toContain('<<HEREDOC');
  });

  it('follows every segment of a compound command', () => {
    const got = fromBash("cat > server/lib/new.js && sed -i 's/a/b/' server/lib/compact.js");
    expect(got.sort()).toEqual(['server/lib/compact.js', 'server/lib/new.js']);
  });

  it('deduplicates the same file touched twice', () => {
    expect(fromBash('cat > server/lib/compact.js; echo x >> server/lib/compact.js'))
      .toEqual(['server/lib/compact.js']);
  });
});

describe('lease-guard — 임대 대상 좁히기', () => {
  it('ignores paths outside the working tree', () => {
    expect(rt('/tmp/out.txt')).toEqual([]);
    expect(rt('../escape.js')).toEqual([]);
  });

  it('ignores generated and vendored trees', () => {
    expect(rt('node_modules/x/index.js')).toEqual([]);
    expect(rt('data/user/config.json')).toEqual([]);
    expect(rt('.git/config')).toEqual([]);
  });

  it('ignores logs and lockfiles', () => {
    expect(rt('server/lib/debug.log')).toEqual([]);
    expect(rt('server/lib/a.lock')).toEqual([]);
  });

  it('allows a file that does not exist yet but whose directory does', () => {
    expect(rt('server/lib/brand-new.js')).toEqual(['server/lib/brand-new.js']);
    // 부모 디렉터리조차 없으면 경로가 아니라 명령 인자였을 가능성이 크다.
    expect(rt('no/such/dir/file.js')).toEqual([]);
  });

  it('resolves relative to the command cwd, not just the root', () => {
    expect(rt('compact.js', path.join(root, 'server', 'lib'))).toEqual(['server/lib/compact.js']);
  });

  it('accepts an absolute path inside the tree', () => {
    expect(rt(path.join(root, 'server/lib/compact.js'))).toEqual(['server/lib/compact.js']);
  });
});

describe('lease-guard — 도구별 대상', () => {
  const call = (tool_name, tool_input) => targetsFor({ tool_name, tool_input }, { cwd: root, root });

  it('reads the path out of every edit tool', () => {
    expect(call('Edit', { file_path: 'server/lib/compact.js' })).toEqual(['server/lib/compact.js']);
    expect(call('Write', { file_path: 'server/lib/new.js' })).toEqual(['server/lib/new.js']);
    expect(call('MultiEdit', { file_path: 'server/lib/compact.js' })).toEqual(['server/lib/compact.js']);
    expect(call('NotebookEdit', { notebook_path: 'server/lib/nb.ipynb' })).toEqual(['server/lib/nb.ipynb']);
    expect(editTarget({ path: 'x' })).toBe('x');
  });

  it('claims nothing for read-only tools', () => {
    expect(call('Read', { file_path: 'server/lib/compact.js' })).toEqual([]);
    expect(call('Grep', { pattern: 'x' })).toEqual([]);
    expect(call('Bash', { command: 'ls -la server/lib' })).toEqual([]);
  });

  it('claims a Bash write the same way as an Edit', () => {
    expect(call('Bash', { command: "sed -i 's/a/b/' server/lib/compact.js" }))
      .toEqual(['server/lib/compact.js']);
  });

  it('survives malformed tool input', () => {
    expect(call('Edit', {})).toEqual([]);
    expect(call('Bash', {})).toEqual([]);
    expect(targetsFor({}, { cwd: root, root })).toEqual([]);
    expect(bashWriteTargets(undefined)).toEqual([]);
  });
});

describe('lease-guard 훅 — 실제 프로세스', () => {
  const HOOK = path.resolve('server/hooks/lease-guard.js');
  let tree;
  let leaseDir;

  beforeAll(() => {
    tree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claw-hook-')));
    leaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-hook-leases-'));
    fs.mkdirSync(path.join(tree, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'src', 'app.js'), '//');
  });

  afterAll(() => {
    fs.rmSync(tree, { recursive: true, force: true });
    fs.rmSync(leaseDir, { recursive: true, force: true });
  });

  /** 훅을 한 번 돌린다. exit 0 = 허용, exit 2 = 차단. */
  function runHook(sessionId, input, args = []) {
    const res = spawnSync(process.execPath, [HOOK, ...args], {
      cwd: tree,
      input: JSON.stringify({ cwd: tree, ...input }),
      encoding: 'utf8',
      env: { ...process.env, CLAW_WEB_LEASE_DIR: leaseDir, CLAW_WEB_SESSION_ID: sessionId }
    });
    return { code: res.status, stderr: res.stderr, stdout: res.stdout };
  }

  it('allows the first session and blocks the second on the same file', () => {
    const first = runHook('sess-A', { tool_name: 'Edit', tool_input: { file_path: 'src/app.js' } });
    expect(first.code).toBe(0);

    const second = runHook('sess-B', { tool_name: 'Edit', tool_input: { file_path: 'src/app.js' } });
    expect(second.code).toBe(2);
    expect(second.stderr).toContain('다른 세션이 편집 중');
    expect(second.stderr).toContain('src/app.js');
    expect(second.stderr).toContain('sess-A');
  });

  it('blocks a Bash write that targets the leased file — Edit 만 막으면 그냥 우회된다', () => {
    const viaSed = runHook('sess-B', {
      tool_name: 'Bash',
      tool_input: { command: "sed -i '' 's/a/b/' src/app.js" }
    });
    expect(viaSed.code).toBe(2);

    const viaCat = runHook('sess-B', { tool_name: 'Bash', tool_input: { command: 'cat > src/app.js' } });
    expect(viaCat.code).toBe(2);

    const viaTee = runHook('sess-B', { tool_name: 'Bash', tool_input: { command: 'echo x | tee src/app.js' } });
    expect(viaTee.code).toBe(2);
  });

  it('lets the holder keep editing, and lets anyone read', () => {
    expect(runHook('sess-A', { tool_name: 'Edit', tool_input: { file_path: 'src/app.js' } }).code).toBe(0);
    expect(runHook('sess-B', { tool_name: 'Read', tool_input: { file_path: 'src/app.js' } }).code).toBe(0);
    expect(runHook('sess-B', { tool_name: 'Bash', tool_input: { command: 'grep -n x src/app.js' } }).code).toBe(0);
  });

  it('frees the file once the holder releases it', () => {
    const released = runHook('sess-A', {}, ['--release', 'sess-A']);
    expect(released.stdout).toContain('해제 1건');

    expect(runHook('sess-B', { tool_name: 'Edit', tool_input: { file_path: 'src/app.js' } }).code).toBe(0);
  });

  it('lists the live leases', () => {
    const ls = runHook('sess-B', {}, ['--ls']);
    expect(ls.code).toBe(0);
    expect(ls.stdout).toContain('src/app.js');
  });

  it('stays out of the way when it cannot tell who is asking', () => {
    const res = spawnSync(process.execPath, [HOOK], {
      cwd: tree,
      input: JSON.stringify({ cwd: tree, tool_name: 'Edit', tool_input: { file_path: 'src/app.js' } }),
      encoding: 'utf8',
      env: { ...process.env, CLAW_WEB_LEASE_DIR: leaseDir, CLAW_WEB_SESSION_ID: '' }
    });
    expect(res.status).toBe(0);
  });

  it('allows anything on garbage input rather than freezing every edit', () => {
    const res = spawnSync(process.execPath, [HOOK], {
      cwd: tree,
      input: 'not json at all',
      encoding: 'utf8',
      env: { ...process.env, CLAW_WEB_LEASE_DIR: leaseDir, CLAW_WEB_SESSION_ID: 'sess-C' }
    });
    expect(res.status).toBe(0);
  });
});
