import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';

/**
 * Workspace layout sync store.
 *
 * 클라이언트(zustand)의 workspaces / activeWorkspaceId 를 서버에 단일 파일로 저장.
 * 단일 사용자 환경(v1.13.1 이후)이라 사용자별 분리는 불필요. 기기·브라우저 간
 * 같은 레이아웃을 공유하는 용도. atomic write (.tmp + rename) — proper-lockfile
 * 까진 불필요 (쓰기 빈도 ≪ 1Hz, 마지막 쓰기 승리).
 *
 * 저장 형태:
 *   { workspaces: Workspace[], activeWorkspaceId: string,
 *     updatedAt: ISO, updatedBy: clientId }
 */
export async function createWorkspaceLayoutStore(filePath) {
  let state = null;

  if (fssync.existsSync(filePath)) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.workspaces) && parsed.workspaces.length > 0) {
        state = parsed;
      }
    } catch {
      state = null;
    }
  }

  async function save() {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.rename(tmp, filePath);
  }

  return {
    /** Returns current layout (or null if never set). */
    get() {
      return state;
    },

    /**
     * Replace layout. Validates shape minimally — workspaces must be a non-empty
     * array of objects with id/name/panes. activeWorkspaceId must reference
     * one of them (or fall back to the first).
     */
    async set({ workspaces, activeWorkspaceId, clientId }) {
      if (!Array.isArray(workspaces) || workspaces.length === 0) {
        throw new Error('workspaces must be a non-empty array');
      }
      for (const w of workspaces) {
        if (!w || typeof w.id !== 'string' || !Array.isArray(w.panes)) {
          throw new Error('invalid workspace shape');
        }
      }
      const ids = new Set(workspaces.map((w) => w.id));
      const activeId = ids.has(activeWorkspaceId) ? activeWorkspaceId : workspaces[0].id;
      state = {
        workspaces,
        activeWorkspaceId: activeId,
        updatedAt: new Date().toISOString(),
        updatedBy: typeof clientId === 'string' ? clientId : null
      };
      await save();
      return state;
    }
  };
}
