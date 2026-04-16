import type { Agent, Project } from '../../../lib/types';
import { buildHierarchy } from '../../../lib/visibility';

export interface ContextMenuState {
  x: number;
  y: number;
  agent: Agent;
}

export function AgentContextMenu({
  state,
  projects,
  hierarchy,
  onClose,
  onMove
}: {
  state: ContextMenuState;
  projects: Project[];
  hierarchy: ReturnType<typeof buildHierarchy>;
  onClose: () => void;
  onMove: (patch: Partial<Agent>) => void;
}) {
  const { agent, x, y } = state;
  const mainId = hierarchy.main[0]?.id ?? null;

  // Position: clamp within viewport so menu doesn't go offscreen
  const maxX = typeof window !== 'undefined' ? window.innerWidth - 260 : x;
  const maxY = typeof window !== 'undefined' ? window.innerHeight - 400 : y;
  const left = Math.min(x, maxX);
  const top = Math.min(y, maxY);

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className="fixed z-50 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl py-1 min-w-[240px] max-h-[440px] overflow-y-auto"
        style={{ left, top }}
      >
        <div className="px-3 py-2 border-b border-zinc-800">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500">Move</div>
          <div className="text-sm font-semibold flex items-center gap-2 mt-0.5">
            <span>{agent.avatar ?? '🤖'}</span>
            <span className="truncate">{agent.name}</span>
          </div>
        </div>
        <MenuItem
          disabled={agent.tier === 'main'}
          onClick={() => onMove({ tier: 'main', projectId: null, parentId: null })}
        >
          🟡 Main
        </MenuItem>
        <div className="border-t border-zinc-800 my-1" />
        <div className="px-3 py-1 text-[11px] uppercase tracking-wider text-zinc-500">Projects</div>
        {projects.map((p) => {
          const isLead = agent.tier === 'project' && agent.projectId === p.id;
          const isAddon = agent.tier === 'addon' && agent.projectId === p.id;
          return (
            <div key={p.id}>
              <MenuItem
                disabled={isLead}
                onClick={() =>
                  onMove({ tier: 'project', projectId: p.id, parentId: mainId })
                }
              >
                <span className="inline-block w-1.5 h-1.5 rounded-full mr-2" style={{ background: p.color ?? '#666' }} />
                {p.name} <span className="text-zinc-500 text-[11px] ml-1">&middot; Lead</span>
              </MenuItem>
              <MenuItem
                disabled={isAddon}
                onClick={() => {
                  const bucket = hierarchy.projects.find((b) => b.project?.id === p.id);
                  const leadId = bucket?.lead?.id ?? mainId;
                  onMove({ tier: 'addon', projectId: p.id, parentId: leadId });
                }}
              >
                <span className="inline-block w-1.5 h-1.5 rounded-full mr-2 opacity-40" style={{ background: p.color ?? '#666' }} />
                {p.name} <span className="text-zinc-500 text-[11px] ml-1">&middot; Addon</span>
              </MenuItem>
            </div>
          );
        })}
        <div className="border-t border-zinc-800 my-1" />
        <MenuItem
          disabled={!agent.tier}
          onClick={() => onMove({ tier: null, projectId: null, parentId: null })}
        >
          ⚪ Unassigned
        </MenuItem>
      </div>
    </>
  );
}

export function MenuItem({
  children,
  disabled,
  onClick
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 text-sm flex items-center ${
        disabled ? 'text-zinc-600 cursor-default' : 'text-zinc-300 hover:bg-zinc-800'
      }`}
    >
      {children}
    </button>
  );
}
