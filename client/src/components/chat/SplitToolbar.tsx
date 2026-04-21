import { useState, useEffect, useRef } from 'react';
import { Plus, X } from 'lucide-react';
import { useChatStore, type PaneCount, type Workspace } from '../../store/chat-store';

/**
 * 실제 레이아웃 배치 그대로를 그려주는 미니 SVG 아이콘.
 *   1: 단일 박스
 *   2: 세로 2분할 (좌우)
 *   3: 세로 3분할 (좌/중/우)
 *   4: 2×2 그리드
 *   5: 상단 3칸 + 하단 2칸
 *   6: 2×3 (상 3 + 하 3)
 */
function LayoutIcon({ count, size = 14 }: { count: PaneCount; size?: number }) {
  const stroke = 'currentColor';
  const sw = 1.5;
  const pad = 1.5;
  const W = 20;
  const H = 20;
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  if (count === 1) {
    rects.push({ x: pad, y: pad, w: W - 2 * pad, h: H - 2 * pad });
  } else if (count === 2) {
    const cw = (W - 2 * pad - sw) / 2;
    rects.push({ x: pad, y: pad, w: cw, h: H - 2 * pad });
    rects.push({ x: pad + cw + sw, y: pad, w: cw, h: H - 2 * pad });
  } else if (count === 3) {
    const cw = (W - 2 * pad - 2 * sw) / 3;
    for (let i = 0; i < 3; i++) {
      rects.push({ x: pad + i * (cw + sw), y: pad, w: cw, h: H - 2 * pad });
    }
  } else if (count === 4) {
    const cw = (W - 2 * pad - sw) / 2;
    const rh = (H - 2 * pad - sw) / 2;
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 2; c++) {
        rects.push({ x: pad + c * (cw + sw), y: pad + r * (rh + sw), w: cw, h: rh });
      }
    }
  } else if (count === 5) {
    const rh = (H - 2 * pad - sw) / 2;
    const topW = (W - 2 * pad - 2 * sw) / 3;
    for (let c = 0; c < 3; c++) {
      rects.push({ x: pad + c * (topW + sw), y: pad, w: topW, h: rh });
    }
    const botW = (W - 2 * pad - sw) / 2;
    for (let c = 0; c < 2; c++) {
      rects.push({ x: pad + c * (botW + sw), y: pad + rh + sw, w: botW, h: rh });
    }
  } else {
    // 6: 2×3
    const cw = (W - 2 * pad - 2 * sw) / 3;
    const rh = (H - 2 * pad - sw) / 2;
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 3; c++) {
        rects.push({ x: pad + c * (cw + sw), y: pad + r * (rh + sw), w: cw, h: rh });
      }
    }
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${W} ${H}`} fill="none" aria-hidden>
      {rects.map((r, i) => (
        <rect
          key={i}
          x={r.x}
          y={r.y}
          width={r.w}
          height={r.h}
          rx={1.5}
          stroke={stroke}
          strokeWidth={sw}
        />
      ))}
    </svg>
  );
}

const LAYOUT_OPTIONS: { value: PaneCount; label: string }[] = [
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
  { value: 4, label: '4' },
  { value: 5, label: '5' },
  { value: 6, label: '6' }
];

export default function SplitToolbar() {
  const workspaces = useChatStore((s) => s.workspaces);
  const activeWorkspaceId = useChatStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useChatStore((s) => s.setActiveWorkspace);
  const addWorkspace = useChatStore((s) => s.addWorkspace);
  const removeWorkspace = useChatStore((s) => s.removeWorkspace);
  const renameWorkspace = useChatStore((s) => s.renameWorkspace);
  const setWorkspaceCount = useChatStore((s) => s.setWorkspaceCount);

  const activeWs = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0];

  return (
    <div className="hidden lg:flex items-center gap-1 px-2 py-1 border-b border-zinc-800 bg-zinc-950/60">
      {/* Workspace tabs */}
      <div className="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto">
        {workspaces.map((ws) => (
          <WorkspaceTab
            key={ws.id}
            ws={ws}
            active={ws.id === activeWorkspaceId}
            canClose={workspaces.length > 1}
            onSelect={() => setActiveWorkspace(ws.id)}
            onRename={(name) => renameWorkspace(ws.id, name)}
            onClose={() => removeWorkspace(ws.id)}
          />
        ))}
        <button
          onClick={() => addWorkspace()}
          className="shrink-0 p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
          title="새 워크스페이스"
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Layout picker */}
      {activeWs && (
        <div className="flex items-center gap-0.5 shrink-0 ml-2 pl-2 border-l border-zinc-800">
          {LAYOUT_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setWorkspaceCount(activeWs.id, value)}
              className={`p-1.5 rounded text-[11px] flex items-center gap-1 transition-colors ${
                activeWs.count === value
                  ? 'bg-sky-900/40 text-sky-300 border border-sky-800'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 border border-transparent'
              }`}
              title={`1/${value} 분할`}
            >
              <LayoutIcon count={value} size={14} />
              <span className="font-mono">{label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function WorkspaceTab({
  ws,
  active,
  canClose,
  onSelect,
  onRename,
  onClose
}: {
  ws: Workspace;
  active: boolean;
  canClose: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(ws.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== ws.name) onRename(trimmed);
    else setValue(ws.name);
    setEditing(false);
  };

  return (
    <div
      onClick={onSelect}
      onDoubleClick={() => !editing && setEditing(true)}
      className={`group shrink-0 flex items-center gap-1 px-2 py-1 rounded cursor-pointer transition-colors ${
        active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900'
      }`}
      title={`${ws.name} (더블클릭 이름 변경)`}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') { setValue(ws.name); setEditing(false); }
          }}
          className="bg-transparent border-b border-sky-500 outline-none text-xs w-24"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="text-xs max-w-[140px] truncate">{ws.name}</span>
      )}
      <span className="text-[10px] text-zinc-500 font-mono shrink-0">1/{ws.count}</span>
      {canClose && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`"${ws.name}" 워크스페이스를 닫을까요?`)) onClose();
          }}
          className="shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-100"
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
}
