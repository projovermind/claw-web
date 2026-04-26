import { useState } from 'react';
import { Download, FileDown, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { getAuthToken } from '../../lib/api';
import type { DownloadItem } from '../../lib/parse-downloads';

function basename(p: string): string {
  const segs = p.split(/[/\\]/);
  return segs[segs.length - 1] || p;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function DownloadCard({ item }: { item: DownloadItem }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const name = basename(item.path);

  async function handleDownload() {
    setState('loading');
    setError(null);
    try {
      const token = getAuthToken();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const url = `/api/fs/file?path=${encodeURIComponent(item.path)}&download=true`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        let msg = `${res.status} ${res.statusText}`;
        try {
          const body = await res.json();
          if (body?.error) msg = body.error;
        } catch { /* ignore */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      setSize(blob.size);
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Revoke a tick later — Safari needs the URL alive briefly
      setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
      setState('done');
    } catch (err) {
      setState('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const palette =
    state === 'error'
      ? { border: 'border-red-800/60', bg: 'bg-red-950/30', text: 'text-red-200' }
      : state === 'done'
        ? { border: 'border-emerald-800/60', bg: 'bg-emerald-950/30', text: 'text-emerald-200' }
        : { border: 'border-zinc-700', bg: 'bg-zinc-900/40', text: 'text-zinc-200' };

  const icon =
    state === 'loading' ? <Loader2 size={14} className="animate-spin text-sky-400" /> :
    state === 'done' ? <CheckCircle2 size={14} className="text-emerald-400" /> :
    state === 'error' ? <AlertTriangle size={14} className="text-red-400" /> :
    <FileDown size={14} className="text-sky-400" />;

  return (
    <div
      className={`mt-2 inline-flex max-w-full items-center gap-2 rounded-lg border ${palette.border} ${palette.bg} ${palette.text} px-3 py-2 text-xs`}
    >
      {icon}
      <div className="flex-1 min-w-0">
        <div className="font-mono truncate" title={item.path}>{name}</div>
        {(item.label || size !== null || error) && (
          <div className="text-[10px] opacity-70 truncate">
            {item.label && <span>{item.label}</span>}
            {item.label && size !== null && <span> · </span>}
            {size !== null && <span>{formatSize(size)}</span>}
            {error && <span className="text-red-300">{error}</span>}
          </div>
        )}
      </div>
      <button
        onClick={handleDownload}
        disabled={state === 'loading'}
        className="shrink-0 inline-flex items-center gap-1 rounded border border-sky-700/60 bg-sky-900/40 hover:bg-sky-800/50 disabled:opacity-50 disabled:cursor-not-allowed px-2 py-1 text-[11px] text-sky-200"
      >
        <Download size={11} />
        {state === 'loading' ? '받는 중…' : state === 'done' ? '다시 받기' : state === 'error' ? '다시 시도' : '다운로드'}
      </button>
    </div>
  );
}
