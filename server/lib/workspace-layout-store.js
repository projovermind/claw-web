import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';

/**
 * Workspace layout sync store (v2 — 창 단위).
 *
 * 클라이언트(zustand)의 workspaces / activeWorkspaceId 를 **창(view) 단위**로
 * 저장한다. 브라우저 탭마다 sessionStorage 에 심어 둔 viewId 가 키다.
 * 처음 보는 viewId 는 가장 최근에 갱신된 뷰를 seeded:true 로 복제해 내려주고,
 * 클라이언트가 곧바로 자기 viewId 로 PUT 한다 → 새 창은 익숙한 레이아웃으로
 * 시작하되 그 뒤론 창끼리 서로를 덮어쓰지 않는다.
 *
 * atomic write (.tmp + rename) — proper-lockfile 까진 불필요
 * (쓰기 빈도 ≪ 1Hz, 마지막 쓰기 승리).
 *
 * 저장 형태:
 *   { version: 2, views: { [viewId]: { workspaces, activeWorkspaceId, updatedAt, updatedBy } } }
 */

export const DEFAULT_VIEW_ID = 'default';

/** 빈/비문자열 viewId 는 기본 뷰로 취급 (구버전 클라이언트 호환). */
export function normalizeViewId(viewId) {
  return typeof viewId === 'string' && viewId ? viewId : DEFAULT_VIEW_ID;
}
/** 창은 계속 새로 열리므로 오래된 뷰부터 정리 (파일 무한 증식 방지). */
const MAX_VIEWS = 24;

export async function createWorkspaceLayoutStore(filePath) {
  /** viewId → entry. 삽입 순서 = 오래된 것 → 최신 (갱신 시 재삽입). */
  const views = new Map();

  function ingest(id, v) {
    if (!v || !Array.isArray(v.workspaces) || v.workspaces.length === 0) return;
    views.delete(id);
    views.set(id, v);
  }

  if (fssync.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (parsed && parsed.views && typeof parsed.views === 'object') {
        Object.entries(parsed.views)
          .sort((a, b) => String(a[1]?.updatedAt ?? '').localeCompare(String(b[1]?.updatedAt ?? '')))
          .forEach(([id, v]) => ingest(id, v));
      } else if (parsed && Array.isArray(parsed.workspaces)) {
        // 레거시(창 구분 없는 단일 레이아웃) → 기본 뷰로 이관.
        ingest(DEFAULT_VIEW_ID, parsed);
      }
    } catch {
      views.clear();
    }
  }

  async function save() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    const body = { version: 2, views: Object.fromEntries(views) };
    await fs.writeFile(tmp, JSON.stringify(body, null, 2));
    await fs.rename(tmp, filePath);
  }

  /** 가장 최근에 갱신된 뷰 (자기 자신 제외). */
  function newest(exceptId) {
    let found = null;
    for (const [id, v] of views) if (id !== exceptId) found = v;
    return found;
  }

  function prune() {
    while (views.size > MAX_VIEWS) {
      const oldest = views.keys().next().value;
      views.delete(oldest);
    }
  }

  return {
    /**
     * 해당 창의 레이아웃. 처음 보는 창이면 가장 최근 창의 레이아웃을
     * seeded:true 로 복제해 돌려준다 (저장은 클라이언트의 PUT 시점에).
     * 저장된 레이아웃이 하나도 없으면 null.
     */
    get(viewId) {
      const id = normalizeViewId(viewId);
      const own = views.get(id);
      if (own) return { ...own, viewId: id, seeded: false };
      const seed = newest(id);
      if (seed) return { ...seed, viewId: id, seeded: true };
      return null;
    },

    /** 최신 갱신 순(내림차순) viewId 목록. */
    listViewIds() {
      return [...views.keys()].reverse();
    },

    /**
     * Replace one view's layout. Validates shape minimally — workspaces must be
     * a non-empty array of objects with id/panes. activeWorkspaceId must
     * reference one of them (or fall back to the first).
     */
    async set({ viewId, workspaces, activeWorkspaceId, clientId }) {
      if (!Array.isArray(workspaces) || workspaces.length === 0) {
        throw new Error('workspaces must be a non-empty array');
      }
      for (const w of workspaces) {
        if (!w || typeof w.id !== 'string' || !Array.isArray(w.panes)) {
          throw new Error('invalid workspace shape');
        }
      }
      const id = normalizeViewId(viewId);
      const ids = new Set(workspaces.map((w) => w.id));
      const activeId = ids.has(activeWorkspaceId) ? activeWorkspaceId : workspaces[0].id;
      const entry = {
        workspaces,
        activeWorkspaceId: activeId,
        updatedAt: new Date().toISOString(),
        updatedBy: typeof clientId === 'string' ? clientId : null
      };
      views.delete(id);
      views.set(id, entry);
      prune();
      await save();
      return { ...entry, viewId: id };
    }
  };
}
