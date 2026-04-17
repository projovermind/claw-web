import type { Agent } from '../../../lib/types';
import { buildHierarchy } from '../../../lib/visibility';

// ── Drop target encoding ─────────────────────────────
export type DropTarget =
  | { kind: 'main' }
  | { kind: 'project-lead'; projectId: string }
  | { kind: 'project-addon'; projectId: string }
  | { kind: 'palette' };

export const DROP_MAIN = 'drop:main';
export const DROP_PALETTE = 'drop:palette';
export const encProjectLead = (pid: string) => `drop:proj:${pid}:lead`;
export const encProjectAddon = (pid: string) => `drop:proj:${pid}:addon`;

export function decodeDrop(id: string): DropTarget | null {
  if (id === DROP_MAIN) return { kind: 'main' };
  if (id === DROP_PALETTE) return { kind: 'palette' };
  const m = id.match(/^drop:proj:([^:]+):(lead|addon)$/);
  if (m) {
    return m[2] === 'lead'
      ? { kind: 'project-lead', projectId: m[1] }
      : { kind: 'project-addon', projectId: m[1] };
  }
  return null;
}

export function targetToPatch(
  target: DropTarget,
  hierarchy: ReturnType<typeof buildHierarchy>,
  movingAgentId?: string
): Partial<Agent> {
  if (target.kind === 'palette') return { tier: null, projectId: null, parentId: null };
  if (target.kind === 'main') return { tier: 'main', projectId: null, parentId: null };
  const mainId = hierarchy.main[0]?.id ?? null;
  if (target.kind === 'project-lead') {
    return { tier: 'project', projectId: target.projectId, parentId: mainId };
  }
  // project-addon: parentId = 프로젝트 lead. 단, 자기 자신이 lead면 main으로 대체
  const projBucket = hierarchy.projects.find((p) => p.project?.id === target.projectId);
  let leadId: string | null = projBucket?.lead?.id ?? mainId;
  if (leadId === movingAgentId) leadId = mainId;
  return { tier: 'addon', projectId: target.projectId, parentId: leadId };
}
