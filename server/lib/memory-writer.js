/**
 * Memory Writer — 분석 결과를 ~/.claude/projects/[workingDir hash]/memory/ 에 저장
 *
 * 파일 구조:
 *   ~/.claude/projects/<hash>/memory/feedback_YYYYMMDD.md  — 메모리 본문
 *   ~/.claude/projects/<hash>/MEMORY.md                    — 인덱스 (포인터 목록)
 */
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from './logger.js';

const HOME = process.env.HOME || '/tmp';
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');

/**
 * workingDir 경로를 16자 hex 해시로 변환
 * ~/.claude/projects/<hash>/ 디렉토리명으로 사용
 */
function hashWorkingDir(workingDir) {
  return crypto.createHash('sha256').update(workingDir).digest('hex').slice(0, 16);
}

/**
 * YYYYMMDD 형식 날짜 문자열 반환
 */
function today() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * 메모리 파일 frontmatter + 본문 생성
 */
function buildMemoryFileContent(memories) {
  const lines = [];
  for (const mem of memories) {
    const type = mem.type || 'feedback';
    const name = (mem.name || 'auto-learned').replace(/[^a-zA-Z0-9가-힣_\- ]/g, '').trim();
    const description = (mem.description || '').trim();
    const content = (mem.content || '').trim();

    lines.push('---');
    lines.push(`name: ${name}`);
    lines.push(`description: ${description}`);
    lines.push(`type: ${type}`);
    lines.push('---');
    lines.push('');
    lines.push(content);
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * MEMORY.md 인덱스에 새 항목을 추가 (중복 방지)
 * 200줄 초과 시 오래된 항목 자동 제거
 */
async function updateMemoryIndex(memoryDir, fileName, memories) {
  const indexPath = path.join(memoryDir, '..', 'MEMORY.md');

  let existing = '';
  try {
    existing = await fs.readFile(indexPath, 'utf8');
  } catch { /* 신규 파일이면 빈 문자열 */ }

  const relPath = `memory/${fileName}`;

  // 이미 이 파일이 인덱스에 있으면 업데이트 안 함 (날짜별 1회)
  if (existing.includes(relPath)) return;

  const newEntries = memories.map((mem) => {
    const name = (mem.name || 'auto-learned').trim();
    const description = (mem.description || '').trim();
    return `- [${name}](${relPath}) — ${description}`;
  });

  const lines = existing.split('\n');
  lines.push(...newEntries);

  // 200줄 초과 시 앞에서 잘라냄 (최신 항목 보존)
  const trimmed = lines.length > 200 ? lines.slice(lines.length - 200) : lines;

  await fs.writeFile(indexPath, trimmed.join('\n'), 'utf8');
}

/**
 * @param {string} workingDir - 에이전트 작업 디렉토리
 * @param {Array<{type: string, name: string, description: string, content: string}>} memories
 */
export async function writeMemories(workingDir, memories) {
  if (!memories || memories.length === 0) return;

  try {
    const hash = hashWorkingDir(workingDir);
    const projectDir = path.join(CLAUDE_PROJECTS, hash);
    const memoryDir = path.join(projectDir, 'memory');

    await fs.mkdir(memoryDir, { recursive: true });

    const fileName = `feedback_${today()}.md`;
    const filePath = path.join(memoryDir, fileName);

    // 이미 오늘 파일이 있으면 append, 없으면 새로 생성
    const newContent = buildMemoryFileContent(memories);
    if (fssync.existsSync(filePath)) {
      await fs.appendFile(filePath, '\n' + newContent, 'utf8');
    } else {
      await fs.writeFile(filePath, newContent, 'utf8');
    }

    await updateMemoryIndex(memoryDir, fileName, memories);

    logger.info(
      { workingDir, hash, file: fileName, count: memories.length },
      'memory-writer: memories saved'
    );
  } catch (err) {
    logger.debug({ err: err.message, workingDir }, 'memory-writer: failed (non-fatal)');
  }
}
