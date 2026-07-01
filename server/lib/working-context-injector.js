/**
 * Working Context Injector — Phase 1
 *
 * Two types of auto-injected context:
 *   1. pinnedFiles: agent-defined file paths (relative to workingDir) whose
 *      contents are read and attached as an <attached-files> block.
 *      Injected on first turn only (cached via --resume).
 *   2. gitDiffAutoAttach: if enabled, runs `git diff` in workingDir and
 *      prepends the output to every user message. Per-turn (not cached).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { logger } from './logger.js';
import { recentDeployLog } from './deploy-log-store.js';

const MAX_FILE_BYTES = 64 * 1024;        // 64 KB per file
const MAX_TOTAL_BYTES = 256 * 1024;      // 256 KB across all pinned files
const MAX_DIFF_BYTES = 32 * 1024;        // 32 KB for git diff

/**
 * Build <attached-files> block from agent.pinnedFiles.
 * @param {string[]} pinnedFiles   paths relative to workingDir (or absolute)
 * @param {string}   workingDir    resolved cwd
 * @returns {string|null}
 */
export function buildPinnedFilesContext(pinnedFiles, workingDir) {
  if (!Array.isArray(pinnedFiles) || pinnedFiles.length === 0) return null;
  if (!workingDir) return null;

  const parts = [];
  let totalBytes = 0;
  let skipped = 0;

  for (const raw of pinnedFiles) {
    if (!raw || typeof raw !== 'string') continue;
    const rel = raw.trim();
    if (!rel) continue;

    const abs = path.isAbsolute(rel) ? rel : path.join(workingDir, rel);
    let stat;
    try { stat = fs.statSync(abs); } catch {
      parts.push(`\n### ${rel}\n_[file not found]_`);
      skipped++;
      continue;
    }
    if (!stat.isFile()) {
      parts.push(`\n### ${rel}\n_[not a regular file]_`);
      skipped++;
      continue;
    }

    if (totalBytes >= MAX_TOTAL_BYTES) {
      parts.push(`\n### ${rel}\n_[skipped: total pinned context limit reached]_`);
      skipped++;
      continue;
    }

    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      parts.push(`\n### ${rel}\n_[read error: ${err.message}]_`);
      skipped++;
      continue;
    }

    let truncatedNote = '';
    if (content.length > MAX_FILE_BYTES) {
      content = content.slice(0, MAX_FILE_BYTES);
      truncatedNote = `\n_[... truncated at ${MAX_FILE_BYTES} bytes]_`;
    }
    totalBytes += content.length;

    const ext = path.extname(rel).replace(/^\./, '') || '';
    parts.push(`\n### ${rel}\n\n\`\`\`${ext}\n${content}\n\`\`\`${truncatedNote}`);
  }

  if (parts.length === 0) return null;

  return `\n<attached-files>\n다음 파일들은 현재 세션에 고정(pin)된 작업 대상입니다. 수정 요청 시 이 파일들을 기준으로 작업하세요.\n${parts.join('\n')}\n</attached-files>`;
}

/**
 * Run `git diff` in workingDir and wrap output.
 * - Only when `HEAD` exists (git repo).
 * - Truncated to MAX_DIFF_BYTES.
 * @param {string} workingDir
 * @returns {string|null}
 */
export function buildGitDiffContext(workingDir) {
  if (!workingDir) return null;
  try {
    // fail-fast: is it even a git repo?
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: workingDir, stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    return null;
  }

  let diff = '';
  try {
    diff = execFileSync('git', ['diff', '--no-color'], {
      cwd: workingDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 4 * 1024 * 1024
    }).toString();
  } catch (err) {
    logger.warn({ workingDir, err: err.message }, 'working-context: git diff failed');
    return null;
  }

  if (!diff.trim()) {
    // also check staged changes
    try {
      diff = execFileSync('git', ['diff', '--cached', '--no-color'], {
        cwd: workingDir,
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 4 * 1024 * 1024
      }).toString();
    } catch { /* ignore */ }
  }

  if (!diff.trim()) return null;

  let truncatedNote = '';
  if (diff.length > MAX_DIFF_BYTES) {
    diff = diff.slice(0, MAX_DIFF_BYTES);
    truncatedNote = `\n... [truncated at ${MAX_DIFF_BYTES} bytes]`;
  }

  return `<git-diff>\n현재 워킹 디렉토리의 unstaged/staged 변경사항입니다:\n\n\`\`\`diff\n${diff}${truncatedNote}\n\`\`\`\n</git-diff>`;
}

/**
 * Phase 5: Build <ide-context> block from VS Code bridge state.
 * @param {object|null} ctx   the context object stored by /api/bridge/context
 *   { workspaceFolders, activeFile, openFiles, selection, cursor, ideVersion }
 * @param {string} workingDir   used to present paths relative to the agent cwd
 * @returns {string|null}
 */
export function buildBridgeContext(ctx, workingDir) {
  if (!ctx || typeof ctx !== 'object') return null;

  const rel = (p) => {
    if (!p) return p;
    if (workingDir && p.startsWith(workingDir + '/')) return p.slice(workingDir.length + 1);
    return p;
  };

  const lines = [];
  if (ctx.activeFile?.path) {
    const dirty = ctx.activeFile.isDirty ? ' [unsaved]' : '';
    const lang = ctx.activeFile.languageId ? ` (${ctx.activeFile.languageId})` : '';
    lines.push(`active: ${rel(ctx.activeFile.path)}${lang}${dirty}`);
  }
  if (ctx.cursor?.path) {
    lines.push(`cursor: ${rel(ctx.cursor.path)}:${ctx.cursor.line + 1}:${ctx.cursor.column + 1}`);
  }
  if (ctx.selection?.path) {
    const s = ctx.selection;
    lines.push(`selection: ${rel(s.path)} [${s.startLine + 1}:${s.startColumn + 1}-${s.endLine + 1}:${s.endColumn + 1}]`);
  }
  if (Array.isArray(ctx.openFiles) && ctx.openFiles.length > 0) {
    const names = ctx.openFiles.slice(0, 30).map((f) => rel(f.path)).filter(Boolean);
    if (names.length > 0) {
      const more = ctx.openFiles.length > names.length ? ` (+${ctx.openFiles.length - names.length} more)` : '';
      lines.push(`open (${ctx.openFiles.length}): ${names.join(', ')}${more}`);
    }
  }

  let selBlock = '';
  if (ctx.selection?.text && typeof ctx.selection.text === 'string' && ctx.selection.text.trim()) {
    const ext = path.extname(ctx.selection.path || '').replace(/^\./, '') || '';
    selBlock = `\n\n선택된 텍스트:\n\`\`\`${ext}\n${ctx.selection.text}\n\`\`\``;
  }

  if (lines.length === 0 && !selBlock) return null;

  const ide = ctx.ideVersion ? ` [${ctx.ideVersion}]` : '';
  return `<ide-context${ide}>\n사용자가 현재 IDE에서 보고 있는 상태입니다:\n\n${lines.join('\n')}${selBlock}\n</ide-context>`;
}

/** Run a git command in workingDir, return trimmed stdout or null on any failure. */
function git(workingDir, args) {
  try {
    return execFileSync('git', args, {
      cwd: workingDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 2 * 1024 * 1024,
    }).toString().trim();
  } catch {
    return null;
  }
}

const MAX_LEDGER_LINES = 8;

/**
 * Deploy Guard — per-turn injection (NOT cached).
 *
 * Every session of a project shares one git working tree but has no idea what
 * OTHER sessions changed or deployed. That blind spot causes cross-session
 * rollbacks (session B's git redeploy drops session A's uncommitted WIP; a
 * local `vercel --prod` overwrites work that only lives in git). This block
 * gives every turn a live snapshot of the shared tree + the cross-session
 * deploy ledger, plus hard rules for destructive/deploy operations.
 *
 * Emits null when the tree is clean, in sync, and has no recent deploys —
 * nothing to collide with, so no tokens spent.
 *
 * @param {string} workingDir
 * @returns {string|null}
 */
export function buildDeployGuardContext(workingDir) {
  if (!workingDir) return null;
  // fail-fast: is it a git repo?
  if (git(workingDir, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null;

  const porcelain = git(workingDir, ['status', '--porcelain']);
  const dirtyLines = porcelain ? porcelain.split('\n').filter(Boolean) : [];
  const dirtyCount = dirtyLines.length;

  const branch = git(workingDir, ['rev-parse', '--abbrev-ref', 'HEAD']) || '(detached)';

  // Unpushed commits (only meaningful when an upstream is configured).
  let unpushed = [];
  const hasUpstream = git(workingDir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) !== null;
  if (hasUpstream) {
    const out = git(workingDir, ['log', '@{u}..HEAD', '--oneline', '--no-color', '-n', '10']);
    unpushed = out ? out.split('\n').filter(Boolean) : [];
  }

  const ledger = recentDeployLog(workingDir);

  // Nothing to warn about → skip (clean, synced, no recent deploys).
  if (dirtyCount === 0 && unpushed.length === 0 && ledger.length === 0) return null;

  const recentCommits = git(workingDir, ['log', '--oneline', '--no-color', '-n', '5']) || '(none)';

  const parts = [];
  parts.push('<deploy-guard>');
  parts.push('⚠️ 이 프로젝트는 여러 세션이 같은 워킹트리를 공유합니다. 아래는 매 턴 갱신되는 실시간 상태입니다.');
  parts.push('다른 세션이 작업/배포한 내용을 덮어쓰지 않도록 배포·git 파괴적 작업 전에 반드시 확인하세요.\n');

  parts.push(`- 브랜치: ${branch}`);
  parts.push(`- 커밋 안 된 변경: ${dirtyCount}개 파일`);
  if (dirtyCount > 0) {
    const shown = dirtyLines.slice(0, 12).join('\n');
    parts.push('```\n' + shown + (dirtyCount > 12 ? `\n... (+${dirtyCount - 12}개 더)` : '') + '\n```');
  }
  if (hasUpstream) {
    parts.push(`- 미푸시 커밋: ${unpushed.length}개`);
    if (unpushed.length > 0) parts.push('```\n' + unpushed.join('\n') + '\n```');
  } else {
    parts.push('- 미푸시 커밋: (upstream 미설정 — 원격 대비 상태 불명)');
  }
  parts.push('- 최근 커밋:\n```\n' + recentCommits + '\n```');

  if (ledger.length > 0) {
    const lines = ledger.slice(0, MAX_LEDGER_LINES).map((e) => {
      const when = e.ts?.replace('T', ' ').slice(0, 16) || '?';
      const who = e.session ? ` [${e.session}]` : '';
      const tgt = e.target ? ` → ${e.target}` : '';
      const cm = e.commit ? ` (${e.commit})` : '';
      const note = e.note ? ` — ${e.note}` : '';
      return `- ${when}${who}${tgt}${cm}${note}`;
    });
    parts.push('\n최근 배포 이력 (모든 세션 공유):\n' + lines.join('\n'));
  }

  parts.push('\n[배포/파괴적 작업 규칙]');
  parts.push('- 커밋 안 된 변경은 다른 세션의 진행 중 작업(WIP)일 수 있습니다. 임의로 stash/reset/checkout/삭제하지 마세요.');
  parts.push('- 배포 전 반드시 `git status`·`git log`로 현재 트리가 의도한 모든 작업을 포함하는지 확인하세요.');
  parts.push('- 로컬 워킹트리를 직접 프로덕션에 올리지 말고(`vercel --prod` 등), 커밋·푸시 후 git 연동 배포를 우선하세요.');
  parts.push('- force-push/reset --hard/이전 커밋으로의 redeploy 전에는 다른 세션 작업 유실 여부를 반드시 검토하세요.');
  parts.push('- 배포를 완료하면 아래 명령으로 배포 이력을 기록해 다른 세션이 알 수 있게 하세요:');
  parts.push('  curl -s -X POST http://localhost:3838/api/projects/PROJECT_ID/deploy-logAUTH_HEADER -H "Content-Type: application/json" -d \'{"target":"배포대상 URL","note":"무엇을 배포했는지"}\'');
  parts.push('</deploy-guard>');

  return parts.join('\n');
}
