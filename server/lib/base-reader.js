/**
 * BASE Reader — workspace.json + state.json 읽기
 * 워크스페이스 건강 상태를 시스템 프롬프트에 자동 주입
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

const BASE_FOLDER = '.base';

function findBaseDir(workingDir) {
  if (!workingDir) return null;
  let dir = workingDir;
  for (let i = 0; i < 10; i++) {
    const p = path.join(dir, BASE_FOLDER);
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const globalPath = path.join(process.env.HOME || '', BASE_FOLDER);
  if (fs.existsSync(globalPath)) return globalPath;
  return null;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return null; }
}

function daysSince(dateStr) {
  if (!dateStr) return 999;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

export function buildBaseContext(workingDir) {
  try {
    const baseDir = findBaseDir(workingDir);
    if (!baseDir) return null;

    const workspace = readJson(path.join(baseDir, 'workspace.json'));
    const state = readJson(path.join(baseDir, 'data', 'state.json'));
    const projects = readJson(path.join(baseDir, 'data', 'projects.json'));

    if (!workspace && !state && !projects) return null;

    const parts = ['<base-workspace>'];

    // 워크스페이스 기본 정보
    if (workspace) {
      const lastGroom = workspace.lastGroom || workspace.last_groom;
      const groomDays = daysSince(lastGroom);
      parts.push(`Last groom: ${groomDays === 999 ? 'never' : groomDays + 'd ago'}${groomDays > 7 ? ' ⚠️ OVERDUE' : ''}`);

      // 등록된 surfaces
      const surfaces = workspace.surfaces || workspace.registered_surfaces || [];
      if (surfaces.length > 0) {
        parts.push(`Surfaces: ${surfaces.map(s => s.name || s).join(', ')}`);
      }
    }

    // 프로젝트 상태 요약
    if (projects) {
      const items = projects.initiatives || projects.projects || projects.items || [];
      if (Array.isArray(items) && items.length > 0) {
        const active = items.filter(p => p.status === 'active' || p.status === 'in_progress');
        const blocked = items.filter(p => p.status === 'blocked');
        parts.push(`Projects: ${items.length} total, ${active.length} active${blocked.length ? ', ' + blocked.length + ' blocked ⚠️' : ''}`);
      }
    }

    // 상태 요약
    if (state) {
      const areas = state.areas || [];
      const overdue = areas.filter(a => {
        const groomDue = a.groom_due || a.groomDue;
        return groomDue && new Date(groomDue) < new Date();
      });
      if (overdue.length > 0) {
        parts.push(`Overdue grooms: ${overdue.map(a => a.name || a.id).join(', ')}`);
      }
    }

    parts.push('</base-workspace>');

    if (parts.length <= 2) return null; // 태그만 있으면 스킵

    logger.debug('base: workspace context injected');
    return parts.join('\n');
  } catch (err) {
    logger.debug({ err: err.message }, 'base: read failed (non-fatal)');
    return null;
  }
}
