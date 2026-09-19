/**
 * Lease Guard — PreToolUse 훅이 "이 도구 호출이 어떤 파일을 쓰는가" 를 판정하는 로직.
 *
 * 실행 껍데기(stdin/exit)는 server/hooks/lease-guard.js 에 있고, 여기는 전부 순수
 * 함수다 — 판정 규칙이 훅 프로세스 없이도 테스트되도록 갈라 두었다.
 *
 * Edit/Write 계열은 file_path 하나만 보면 되지만 Bash 는 그렇지 않다. claw-web
 * 세션은 `sed -i` · `cat > file` · `tee` 로 파일을 고치는 일이 일상이라, Edit 만
 * 막으면 임대가 그냥 우회된다. 그래서 Bash 명령에서도 쓰기 대상을 뽑아낸다.
 */
import fs from 'node:fs';
import path from 'node:path';

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * 임대에서 제외할 경로. 생성물·의존성·로그는 세션끼리 겹쳐도 사고가 아니고,
 * 오히려 임대를 걸면 빌드 한 번에 수십 건이 잡혀 원장이 쓸모없어진다.
 */
const IGNORED_REL = /^(node_modules|\.git|data|logs|dist|build|coverage|\.next|client\/node_modules|client\/dist)(\/|$)/;
const IGNORED_EXT = new Set(['.log', '.tmp', '.lock', '.pid']);

/**
 * 히어독 본문을 걷어낸다.
 *
 * 문서를 heredoc 으로 쓰는 명령이 본문에 `cat > x` 같은 낱말을 담았다고 그 x 를
 * 임대하면 안 된다. 실제로 실행되는 리다이렉션은 히어독 밖에 있으므로 뼈대만
 * 봐도 놓치지 않는다.
 */
export function stripHeredocs(cmd) {
  return cmd.replace(
    /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g,
    '<<HEREDOC'
  );
}

/**
 * 따옴표로 묶인 덩어리를 자리표(__Q0__)로 치환하고 되돌리는 함수를 같이 준다.
 *
 * 조각내기 전에 이걸 거쳐야 한다 — `sed -i 's|a|b|' f.js` 의 파이프는 명령 구분자가
 * 아니라 sed 스크립트의 구분자인데, 그냥 `|` 로 쪼개면 명령이 네 조각으로 부서져
 * 대상 파일을 통째로 놓친다(실측 오탐).
 */
function tokenizeQuotes(s) {
  const table = [];
  const out = s.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (q) => {
    table.push(q);
    return `__Q${table.length - 1}__`;
  });
  return { out, restore: (str) => str.replace(/__Q(\d+)__/g, (_, i) => table[Number(i)] ?? '') };
}

/**
 * `&&`, `||`, `;`, `|`, 줄바꿈으로 명령을 조각낸다 — 조각마다 쓰기 대상을 따로 본다.
 *
 * 조각마다 `masked`(따옴표 안이 `__Q0__` 자리표라 `>` 가 절대 안 남는 판) 와
 * `raw`(따옴표를 되돌린 원문) 를 같이 준다. REDIRECT_RE 는 반드시 masked 에만
 * 돌려야 한다 — raw 에 돌리면 `print(k,'->',x)` 같은 문자열 리터럴 속 `->` 를
 * 리다이렉션으로, 뒤따르는 따옴표를 파일명으로 오인한다(실측 오탐).
 */
function segments(cmd) {
  const { out, restore } = tokenizeQuotes(cmd);
  return out.split(/&&|\|\||[;|\n]/).map((masked) => ({ masked, raw: restore(masked), restore }));
}

function unquote(tok) {
  const m = /^(['"])([\s\S]*)\1$/.exec(tok);
  return m ? m[2] : tok;
}

/** 공백으로 쪼개되 따옴표로 묶인 덩어리는 하나로 유지한다. */
function tokenize(seg) {
  return (seg.match(/'[^']*'|"(?:[^"\\]|\\.)*"|\S+/g) ?? []).map(unquote);
}

// `2>&1` 과 비교 연산자 `>=` 는 리다이렉션이 아니다 — 둘 다 실측 오탐이었다.
const REDIRECT_RE = /(?:^|[^0-9&>])\d?>>?\s*(?![&=])(?:'([^']+)'|"([^"]+)"|([^\s;|&'"<>]+))/g;

/**
 * Bash 명령이 쓰는 파일 후보를 뽑는다 — 경로 해석 전의 raw 토큰.
 *
 * 세 갈래만 본다:
 *   리다이렉션 `> file` / `>> file`  (`cat > x`, `printf ... > x` 가 전부 여기에 걸린다)
 *   `sed -i` / `--in-place` 의 대상 파일
 *   `tee` / `tee -a` 의 대상 파일
 */
export function bashWriteTargets(command) {
  const out = [];
  if (!command) return out;

  for (const seg of segments(stripHeredocs(command))) {
    for (const m of seg.masked.matchAll(REDIRECT_RE)) {
      const target = m[1] ?? m[2] ?? m[3];
      if (target) out.push(unquote(seg.restore(target)));
    }

    const toks = tokenize(seg.raw);
    const cmdIdx = toks.findIndex((t) => t && !t.includes('='));
    const head = cmdIdx >= 0 ? path.basename(toks[cmdIdx]) : '';

    // `-i` · `-Ei` · `-i.bak` · `--in-place` · `--in-place=.bak` 을 모두 본다.
    const inPlace = (t) => /^-[a-zA-Z]*i(\.[^\s]*)?$/.test(t) || /^--in-place(=|$)/.test(t);
    if (head === 'sed' && toks.some(inPlace)) {
      // sed 인자 중 파일처럼 생긴 것만. 스크립트(`s/a/b/`)는 부모 디렉터리가 없어
      // 아래 resolveTargets 의 존재 검사에서 떨어진다.
      out.push(...toks.slice(cmdIdx + 1).filter((t) => !t.startsWith('-')));
    }

    if (head === 'tee') {
      out.push(...toks.slice(cmdIdx + 1).filter((t) => !t.startsWith('-')));
    }
  }
  return out.filter(Boolean);
}

/** 도구 입력에서 편집 대상 경로를 꺼낸다 (Edit/Write/MultiEdit/NotebookEdit). */
export function editTarget(toolInput) {
  const ti = toolInput ?? {};
  return ti.file_path || ti.notebook_path || ti.path || null;
}

/**
 * 후보 토큰들을 실제 임대 대상(root 기준 상대경로)으로 좁힌다.
 *
 * 남기는 조건: root 안이고, 제외 목록에 없고, **파일로 존재하거나 부모 디렉터리가
 * 존재**할 것. 마지막 조건이 sed 스크립트(`s/foo/bar/`)나 명령 인자 같은 가짜
 * 경로를 걸러 내면서, 아직 없는 파일을 `cat >` 로 만드는 정상 케이스는 살린다.
 */
export function resolveTargets(rawTargets, { cwd, root }) {
  const seen = new Set();
  const out = [];
  for (const raw of rawTargets) {
    if (!raw || typeof raw !== 'string') continue;
    const expanded = raw.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
    const abs = path.resolve(cwd || root, expanded);
    if (abs !== root && !abs.startsWith(root + path.sep)) continue;

    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..')) continue;
    if (IGNORED_REL.test(rel)) continue;
    if (IGNORED_EXT.has(path.extname(rel))) continue;

    let ok = false;
    try { ok = fs.statSync(abs).isFile(); } catch { /* 아직 없는 파일일 수 있다 */ }
    if (!ok) {
      try { ok = fs.statSync(path.dirname(abs)).isDirectory(); } catch { ok = false; }
    }
    if (!ok) continue;

    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

/** 훅 입력 하나가 건드리는 파일들 (root 기준 상대경로). 없으면 빈 배열. */
export function targetsFor(input, { cwd, root }) {
  const tool = input?.tool_name;
  if (EDIT_TOOLS.has(tool)) {
    const t = editTarget(input.tool_input);
    return t ? resolveTargets([t], { cwd, root }) : [];
  }
  if (tool === 'Bash') {
    return resolveTargets(bashWriteTargets(input.tool_input?.command), { cwd, root });
  }
  return [];
}
