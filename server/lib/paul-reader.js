/**
 * PAUL Reader — .paul/ 디렉토리에서 프로젝트 상태 읽기
 * Phase/Loop 상태를 시스템 프롬프트에 자동 주입
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

const PAUL_FOLDER = '.paul';

function findPaulDir(workingDir) {
  if (!workingDir) return null;
  const p = path.join(workingDir, PAUL_FOLDER);
  if (fs.existsSync(p)) return p;
  return null;
}

function readFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

function extractField(md, field) {
  const re = new RegExp(`^\\*\\*${field}\\*\\*:\\s*(.+)$`, 'im');
  const m = md?.match(re);
  return m ? m[1].trim() : null;
}

function countTasks(md) {
  if (!md) return { total: 0, done: 0 };
  const tasks = md.match(/<task[\s\S]*?<\/task>/g) || [];
  const done = tasks.filter(t => /status="(DONE|DONE_WITH_CONCERNS)"/i.test(t)).length;
  return { total: tasks.length, done };
}

export function buildPaulContext(workingDir) {
  try {
    const paulDir = findPaulDir(workingDir);
    if (!paulDir) return null;

    const projectMd = readFile(path.join(paulDir, 'PROJECT.md'));
    const stateMd = readFile(path.join(paulDir, 'STATE.md'));
    const roadmapMd = readFile(path.join(paulDir, 'ROADMAP.md'));

    if (!projectMd && !stateMd) return null;

    const parts = ['<paul-state>'];

    // 프로젝트 이름
    const projectName = extractField(projectMd, 'Project') || extractField(projectMd, 'Name');
    if (projectName) parts.push(`Project: ${projectName}`);

    // 현재 Phase
    const phase = extractField(stateMd, 'Current Phase') || extractField(stateMd, 'Phase');
    if (phase) parts.push(`Phase: ${phase}`);

    // Loop 위치
    const loop = extractField(stateMd, 'Loop Position') || extractField(stateMd, 'Position');
    if (loop) parts.push(`Loop: ${loop}`);

    // 블로커
    const blockers = extractField(stateMd, 'Blockers');
    if (blockers && blockers.toLowerCase() !== 'none') {
      parts.push(`Blockers: ${blockers} ⚠️`);
    }

    // 태스크 진행률
    const tasks = countTasks(roadmapMd || stateMd);
    if (tasks.total > 0) {
      const pct = Math.round((tasks.done / tasks.total) * 100);
      parts.push(`Tasks: ${tasks.done}/${tasks.total} (${pct}%)`);
    }

    // .paul/ 내 파일 목록 (현재 플랜)
    const planFiles = fs.readdirSync(paulDir).filter(f => f.endsWith('.md') && f.startsWith('PLAN'));
    if (planFiles.length > 0) {
      parts.push(`Plans: ${planFiles.join(', ')}`);
    }

    parts.push('</paul-state>');

    if (parts.length <= 2) return null;

    logger.debug('paul: state context injected');
    return parts.join('\n');
  } catch (err) {
    logger.debug({ err: err.message }, 'paul: read failed (non-fatal)');
    return null;
  }
}
