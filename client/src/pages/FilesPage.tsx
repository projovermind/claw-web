import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FolderTree, Download, Pin, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '../lib/api';
import type { Agent } from '../lib/types';
import FileTree from '../components/files/FileTree';
import RunPanel from '../components/exec/RunPanel';

const ROOT_KEY = 'files:root:v1';
const TOKEN_KEY = 'hivemind:auth-token';

export default function FilesPage() {
  const rootsQ = useQuery({ queryKey: ['fs-roots'], queryFn: api.fsRoots });
  const agentsQ = useQuery({ queryKey: ['agents'], queryFn: api.agents });

  const roots = rootsQ.data?.roots ?? [];
  const agentRoots = useMemo(() => {
    const list = (agentsQ.data ?? []) as Agent[];
    const seen = new Set<string>();
    const out: { name: string; path: string }[] = [];
    for (const a of list) {
      if (!a.workingDir || seen.has(a.workingDir)) continue;
      seen.add(a.workingDir);
      out.push({ name: `${a.name || a.id} (에이전트)`, path: a.workingDir });
    }
    return out;
  }, [agentsQ.data]);

  const allRoots = useMemo(() => {
    const seen = new Set<string>();
    const out: { name: string; path: string }[] = [];
    for (const r of [...roots, ...agentRoots]) {
      if (seen.has(r.path)) continue;
      seen.add(r.path);
      out.push(r);
    }
    return out;
  }, [roots, agentRoots]);

  const [root, setRoot] = useState<string>(() => {
    try { return localStorage.getItem(ROOT_KEY) || ''; } catch { return ''; }
  });

  useEffect(() => {
    if (!root && allRoots.length > 0) setRoot(allRoots[0].path);
  }, [root, allRoots]);

  useEffect(() => {
    try { if (root) localStorage.setItem(ROOT_KEY, root); } catch { /* noop */ }
  }, [root]);

  const [selectedFile, setSelectedFile] = useState<{ path: string; name: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [runOpen, setRunOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('files:runOpen:v1') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('files:runOpen:v1', runOpen ? '1' : '0'); } catch { /* noop */ }
  }, [runOpen]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const fileUrl = (p: string, download = false) => {
    const token = (() => {
      try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
    })();
    const qs = new URLSearchParams({ path: p });
    if (download) qs.set('download', 'true');
    if (token) qs.set('token', token);
    return `/api/fs/file?${qs.toString()}`;
  };

  const pinToAgent = async (absPath: string) => {
    const agents = (agentsQ.data ?? []) as Agent[];
    if (agents.length === 0) {
      setToast('사용 가능한 에이전트가 없습니다');
      return;
    }
    // Pick the agent whose workingDir is longest prefix of absPath (most specific)
    let best: Agent | null = null;
    let bestLen = -1;
    for (const a of agents) {
      if (!a.workingDir) continue;
      if (absPath === a.workingDir || absPath.startsWith(a.workingDir + '/')) {
        if (a.workingDir.length > bestLen) {
          best = a;
          bestLen = a.workingDir.length;
        }
      }
    }
    const target = best ?? agents[0];
    try {
      const rel = target.workingDir && absPath.startsWith(target.workingDir + '/')
        ? absPath.slice(target.workingDir.length + 1)
        : absPath;
      const current = Array.isArray(target.pinnedFiles) ? target.pinnedFiles : [];
      if (current.includes(rel)) {
        setToast(`이미 ${target.name || target.id} 에 pin됨: ${rel}`);
        return;
      }
      if (current.length >= 20) {
        setToast('pin은 최대 20개까지 가능합니다');
        return;
      }
      const next = [...current, rel];
      await api.patchAgent(target.id, { pinnedFiles: next } as Partial<Agent>);
      setToast(`${target.name || target.id} 에 pin됨: ${rel}`);
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'pin 실패');
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-zinc-950 relative">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900/40">
        <FolderTree size={16} className="text-zinc-400" />
        <div className="text-sm font-semibold text-zinc-200">파일</div>
        <select
          value={root}
          onChange={(e) => setRoot(e.target.value)}
          className="ml-3 h-7 px-2 rounded bg-zinc-900 border border-zinc-800 text-xs text-zinc-300 hover:text-zinc-100 max-w-md"
        >
          {allRoots.length === 0 && <option value="">(허용된 경로 없음)</option>}
          {allRoots.map((r) => (
            <option key={r.path} value={r.path} title={r.path}>{r.name} — {r.path}</option>
          ))}
        </select>
        <div className="flex-1" />
        {toast && <div className="text-[11px] text-emerald-400">{toast}</div>}
      </div>

      <div className={`flex-1 min-h-0 grid grid-cols-[320px_1fr] ${runOpen ? 'grid-rows-[1fr_240px]' : 'grid-rows-[1fr]'}`} style={{ gridTemplateAreas: runOpen ? '"tree preview" "run run"' : '"tree preview"' }}>
        <div className="border-r border-zinc-800 min-h-0" style={{ gridArea: 'tree' }}>
          {root ? (
            <FileTree
              root={root}
              onFileClick={(p, name) => setSelectedFile({ path: p, name })}
              onFileDoubleClick={(p) => pinToAgent(p)}
            />
          ) : (
            <div className="p-4 text-xs text-zinc-500">왼쪽 상단에서 루트를 선택하세요</div>
          )}
        </div>
        <div className="min-h-0 flex flex-col" style={{ gridArea: 'preview' }}>
          {selectedFile ? (
            <>
              <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900/40">
                <span className="font-mono text-xs text-zinc-300 truncate flex-1" title={selectedFile.path}>
                  {selectedFile.path}
                </span>
                <button
                  onClick={() => pinToAgent(selectedFile.path)}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
                  title="관련 에이전트에 pin"
                >
                  <Pin size={11} /> pin
                </button>
                <a
                  href={fileUrl(selectedFile.path, true)}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
                  title="다운로드"
                >
                  <Download size={11} /> 다운로드
                </a>
                <a
                  href={fileUrl(selectedFile.path)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200"
                  title="새 탭에서 열기"
                >
                  <ExternalLink size={11} /> 열기
                </a>
              </div>
              <FilePreview path={selectedFile.path} name={selectedFile.name} />
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm">
              파일을 선택하세요 · 더블클릭하면 관련 에이전트에 pin
            </div>
          )}
        </div>
        {runOpen && root && (
          <div className="border-t border-zinc-800 min-h-0" style={{ gridArea: 'run' }}>
            <RunPanel cwd={root} />
          </div>
        )}
      </div>
      <button
        onClick={() => setRunOpen((v) => !v)}
        disabled={!root}
        className="absolute bottom-3 right-3 z-10 flex items-center gap-1 px-3 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs text-zinc-200 shadow-lg disabled:opacity-40"
        title={runOpen ? '실행 패널 닫기' : '실행 패널 열기'}
      >
        {runOpen ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
        Run
      </button>
    </div>
  );
}

function FilePreview({ path, name }: { path: string; name: string }) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const ext = useMemo(() => {
    const m = name.match(/\.([A-Za-z0-9]+)$/);
    return m ? m[1].toLowerCase() : '';
  }, [name]);
  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext);

  useEffect(() => {
    if (isImage) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setText(null);
    const token = (() => {
      try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
    })();
    const qs = new URLSearchParams({ path });
    if (token) qs.set('token', token);
    fetch(`/api/fs/file?${qs.toString()}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const len = Number(res.headers.get('content-length') || '0');
        if (len > 2 * 1024 * 1024) throw new Error('파일이 너무 큽니다 (미리보기 2MB 한도)');
        return res.text();
      })
      .then((t) => { if (!cancelled) { setText(t); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [path, isImage]);

  const imgSrc = useMemo(() => {
    const token = (() => {
      try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
    })();
    const qs = new URLSearchParams({ path });
    if (token) qs.set('token', token);
    return `/api/fs/file?${qs.toString()}`;
  }, [path]);

  if (isImage) {
    return (
      <div className="flex-1 min-h-0 overflow-auto p-4 flex items-start justify-center bg-zinc-900/20">
        <img src={imgSrc} alt={name} className="max-w-full max-h-full object-contain" />
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto bg-zinc-950">
      {loading && <div className="p-4 text-xs text-zinc-500">불러오는 중…</div>}
      {error && <div className="p-4 text-xs text-red-400">{error}</div>}
      {text !== null && (
        <pre className="text-[12px] font-mono text-zinc-200 whitespace-pre-wrap p-4 leading-relaxed">{text}</pre>
      )}
    </div>
  );
}
