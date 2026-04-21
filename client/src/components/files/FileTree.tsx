import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, Folder, FolderOpen, File as FileIcon, Loader2, RefreshCcw } from 'lucide-react';
import { api } from '../../lib/api';

const TOKEN_KEY = 'hivemind:auth-token';

interface Entry {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  size?: number;
  mtime?: string;
}

interface NodeState {
  entries?: Entry[];
  loading?: boolean;
  error?: string | null;
  expanded?: boolean;
}

interface Props {
  /** Absolute root path (must be inside allowedRoots). */
  root: string;
  /** Called when a file is clicked. */
  onFileClick?: (absPath: string, name: string) => void;
  /** Called when a file is double-clicked (eg. pin to agent). */
  onFileDoubleClick?: (absPath: string, name: string) => void;
  className?: string;
}

export default function FileTree({ root, onFileClick, onFileDoubleClick, className }: Props) {
  const [nodes, setNodes] = useState<Record<string, NodeState>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const loadDir = useCallback(async (p: string) => {
    setNodes((n) => ({ ...n, [p]: { ...(n[p] ?? {}), loading: true, error: null } }));
    try {
      const res = await api.fsTree(p);
      setNodes((n) => ({
        ...n,
        [p]: { entries: res.entries, loading: false, error: null, expanded: n[p]?.expanded ?? true }
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'load failed';
      setNodes((n) => ({ ...n, [p]: { ...(n[p] ?? {}), loading: false, error: msg } }));
    }
  }, []);

  // Initial root load + reload on root change
  useEffect(() => {
    setNodes({ [root]: { expanded: true } });
    loadDir(root);
  }, [root, loadDir]);

  // Live watch via /ws/fs-watch — invalidate parent dir of every event
  useEffect(() => {
    if (!root) return;
    let token = '';
    try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch { /* noop */ }
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const qs = new URLSearchParams({ root });
    if (token) qs.set('token', token);
    const url = `${proto}://${window.location.host}/ws/fs-watch?${qs.toString()}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return;
    }
    wsRef.current = ws;

    // Debounce: collect dir paths to refresh within a 200ms window
    let pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      const dirs = Array.from(pending);
      pending = new Set();
      timer = null;
      setNodes((n) => {
        // Only refresh dirs that are expanded and currently loaded
        for (const d of dirs) {
          if (n[d]?.expanded && n[d]?.entries) {
            // Async refetch outside of state update
            loadDir(d);
          }
        }
        return n;
      });
    };

    ws.onmessage = (ev) => {
      let msg: { type: string; event?: string; path?: string };
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type !== 'event' || !msg.path) return;
      // For unlink/unlinkDir the path may have disappeared; refresh its parent.
      // For add/change the parent dir is what shows the new/changed entry.
      const isDirEvt = msg.event === 'addDir' || msg.event === 'unlinkDir';
      const parent = msg.path.replace(/\/[^/]+$/, '') || '/';
      pending.add(parent);
      if (isDirEvt) pending.add(msg.path);
      if (!timer) timer = setTimeout(flush, 200);
    };

    return () => {
      if (timer) clearTimeout(timer);
      try { ws.close(); } catch { /* noop */ }
      wsRef.current = null;
    };
  }, [root, loadDir]);

  const toggleDir = (p: string) => {
    setNodes((n) => {
      const cur = n[p] ?? {};
      const nextExpanded = !cur.expanded;
      return { ...n, [p]: { ...cur, expanded: nextExpanded } };
    });
    const state = nodes[p];
    if (!state?.entries && !state?.loading) loadDir(p);
  };

  const refreshAll = () => {
    const expanded = Object.keys(nodes).filter((k) => nodes[k]?.expanded);
    for (const p of expanded) loadDir(p);
  };

  return (
    <div className={`flex flex-col h-full min-h-0 bg-zinc-950 text-zinc-200 text-xs ${className ?? ''}`}>
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-zinc-800 bg-zinc-900/40">
        <div className="flex-1 font-mono truncate text-[11px] text-zinc-500" title={root}>
          {root}
        </div>
        <button
          onClick={refreshAll}
          className="p-1 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800"
          title="새로고침"
        >
          <RefreshCcw size={12} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto py-1">
        <TreeNode
          path={root}
          name={root.split('/').filter(Boolean).pop() || root}
          depth={0}
          nodes={nodes}
          selected={selected}
          onToggle={toggleDir}
          onSelect={(p, kind, name) => {
            setSelected(p);
            if (kind === 'file') onFileClick?.(p, name);
          }}
          onDblClick={(p, kind, name) => {
            if (kind === 'file') onFileDoubleClick?.(p, name);
          }}
        />
      </div>
    </div>
  );
}

interface TreeNodeProps {
  path: string;
  name: string;
  depth: number;
  nodes: Record<string, NodeState>;
  selected: string | null;
  onToggle: (p: string) => void;
  onSelect: (p: string, kind: 'dir' | 'file', name: string) => void;
  onDblClick: (p: string, kind: 'dir' | 'file', name: string) => void;
  kind?: 'dir' | 'file';
}

function TreeNode({ path, name, depth, nodes, selected, onToggle, onSelect, onDblClick, kind = 'dir' }: TreeNodeProps) {
  const state = nodes[path];
  const expanded = kind === 'dir' && !!state?.expanded;
  const isSelected = selected === path;

  const indent = useMemo(() => ({ paddingLeft: `${depth * 12 + 6}px` }), [depth]);

  return (
    <div>
      <div
        style={indent}
        onClick={() => {
          if (kind === 'dir') onToggle(path);
          onSelect(path, kind, name);
        }}
        onDoubleClick={() => onDblClick(path, kind, name)}
        className={`flex items-center gap-1 pr-2 py-0.5 cursor-pointer select-none ${
          isSelected ? 'bg-zinc-800 text-zinc-100' : 'hover:bg-zinc-900 text-zinc-300'
        }`}
        title={path}
      >
        {kind === 'dir' ? (
          expanded ? <ChevronDown size={12} className="text-zinc-500 shrink-0" /> : <ChevronRight size={12} className="text-zinc-500 shrink-0" />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        {kind === 'dir'
          ? (expanded ? <FolderOpen size={13} className="text-amber-500/80 shrink-0" /> : <Folder size={13} className="text-amber-500/80 shrink-0" />)
          : <FileIcon size={13} className="text-zinc-500 shrink-0" />}
        <span className="truncate font-mono">{name}</span>
        {state?.loading && <Loader2 size={10} className="ml-1 animate-spin text-zinc-500" />}
      </div>
      {expanded && state?.error && (
        <div style={{ paddingLeft: `${(depth + 1) * 12 + 6}px` }} className="text-red-400 text-[10px] py-0.5">
          {state.error}
        </div>
      )}
      {expanded && state?.entries && state.entries.map((e) => (
        <TreeNode
          key={e.path}
          path={e.path}
          name={e.name}
          depth={depth + 1}
          nodes={nodes}
          selected={selected}
          onToggle={onToggle}
          onSelect={onSelect}
          onDblClick={onDblClick}
          kind={e.kind}
        />
      ))}
    </div>
  );
}
