import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Globe, Copy, RefreshCw, Check, AlertTriangle, Wifi } from 'lucide-react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';

function TunnelUrlCard() {
  const t = useT();
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['tunnel-url'],
    queryFn: api.tunnelUrl,
    refetchInterval: 15000
  });
  const [copied, setCopied] = useState(false);
  const url = data?.url ?? null;

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Globe size={14} className="text-emerald-400" />
        <div className="text-sm font-semibold text-zinc-300">{t('access.tunnelTitle')}</div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="ml-auto p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300"
          title={t('access.refresh')}
        >
          <RefreshCw size={12} className={isFetching ? 'animate-spin' : ''} />
        </button>
      </div>
      {url ? (
        <>
          <div className="flex gap-2">
            <code className="flex-1 text-xs font-mono bg-zinc-950 border border-zinc-800 rounded px-3 py-2 truncate select-all">
              {url}
            </code>
            <button
              onClick={copy}
              className="rounded bg-zinc-800 hover:bg-zinc-700 px-3 text-xs flex items-center gap-1.5 shrink-0"
            >
              {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
              {copied ? t('access.copied') : t('access.copy')}
            </button>
          </div>
          <p className="text-[11px] text-zinc-500 leading-snug">
            {t('access.tunnelHint')}
          </p>
        </>
      ) : (
        <div className="text-xs text-zinc-500 italic">
          {t('access.tunnelPreparing')}
        </div>
      )}
    </div>
  );
}

type TunnelType = 'ngrok' | 'cloudflare';

interface TunnelStatus {
  running: boolean;
  type?: TunnelType;
  url?: string;
}

function DomainConnectCard() {
  const qc = useQueryClient();
  const [type, setType] = useState<TunnelType>('ngrok');
  const [domain, setDomain] = useState('');
  const [copied, setCopied] = useState(false);

  const { data: status } = useQuery<TunnelStatus>({
    queryKey: ['tunnel-connect-status'],
    queryFn: () => fetch('/api/tunnel/status').then(r => r.json()),
    refetchInterval: 5000,
  });

  const startMutation = useMutation({
    mutationFn: () => fetch('/api/tunnel/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, ...(type === 'ngrok' && domain ? { domain } : {}) }),
    }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tunnel-connect-status'] }),
  });

  const stopMutation = useMutation({
    mutationFn: () => fetch('/api/tunnel/stop', { method: 'POST' }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tunnel-connect-status'] }),
  });

  const running = status?.running ?? false;
  const url = status?.url;

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Wifi size={14} className="text-blue-400" />
        <div className="text-sm font-semibold text-zinc-300">도메인 연결</div>
        <div className="ml-auto flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${running ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
          <span className="text-xs text-zinc-500">{running ? '연결됨' : '꺼짐'}</span>
        </div>
      </div>

      <div className="flex gap-1">
        {(['ngrok', 'cloudflare'] as TunnelType[]).map((t) => (
          <button
            key={t}
            disabled={running}
            onClick={() => setType(t)}
            className={`px-3 py-1.5 text-xs rounded transition-colors disabled:opacity-50 ${
              type === t ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t === 'ngrok' ? 'ngrok' : 'Cloudflare'}
          </button>
        ))}
      </div>

      {type === 'ngrok' && (
        <input
          disabled={running}
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="your-domain.ngrok-free.app"
          className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono disabled:opacity-50"
        />
      )}

      {running && url && (
        <div className="flex gap-2">
          <code className="flex-1 text-xs font-mono bg-zinc-950 border border-zinc-800 rounded px-3 py-2 truncate select-all">
            {url}
          </code>
          <button
            onClick={copy}
            className="rounded bg-zinc-800 hover:bg-zinc-700 px-3 text-xs flex items-center gap-1.5 shrink-0"
          >
            {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
            {copied ? '복사됨' : '복사'}
          </button>
        </div>
      )}

      <button
        onClick={() => running ? stopMutation.mutate() : startMutation.mutate()}
        disabled={startMutation.isPending || stopMutation.isPending}
        className={`rounded px-4 py-2 text-sm disabled:opacity-50 ${
          running
            ? 'bg-red-900/50 hover:bg-red-900 text-red-200'
            : 'bg-emerald-700 hover:bg-emerald-600 text-white'
        }`}
      >
        {startMutation.isPending || stopMutation.isPending
          ? '처리 중...'
          : running ? '연결 해제' : '연결'}
      </button>
    </div>
  );
}

export function AccessTab() {
  const qc = useQueryClient();
  const t = useT();
  const { data } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const [token, setToken] = useState('');

  const patch = useMutation({
    mutationFn: (body: { auth: { enabled?: boolean; token?: string | null } }) => api.patchSettings(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] })
  });

  if (!data) return <div className="text-zinc-500">{t('access.loading')}</div>;

  return (
    <div className="space-y-5 max-w-2xl">
      <TunnelUrlCard />
      <DomainConnectCard />
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
        <div className="text-sm font-semibold text-zinc-300">{t('access.authTitle')}</div>
        <p className="text-[11px] text-zinc-500">{t('access.authHint')}</p>
        <div className="flex items-center gap-3">
          <button
            onClick={() => patch.mutate({ auth: { enabled: !data.auth.enabled } })}
            className={`rounded px-4 py-2 text-sm ${
              data.auth.enabled
                ? 'bg-emerald-900/40 text-emerald-200'
                : 'bg-zinc-800 text-zinc-400'
            }`}
          >
            {data.auth.enabled ? t('access.authOn') : t('access.authOff')}
          </button>
          <span className="text-[11px] text-zinc-500">
            {data.auth.token ? t('access.tokenSet') : t('access.tokenUnset')}
          </span>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
        <div className="text-sm font-semibold text-zinc-300">{t('access.tokenChangeTitle')}</div>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={t('access.newTokenPlaceholder')}
          className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
        />
        <div className="flex gap-2">
          <button
            disabled={!token}
            onClick={() => {
              patch.mutate({ auth: { token } });
              setToken('');
            }}
            className="rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 px-3 py-1.5 text-xs"
          >
            {t('access.save')}
          </button>
          <button
            onClick={() => patch.mutate({ auth: { token: null } })}
            className="rounded bg-red-900/50 hover:bg-red-900 text-red-200 px-3 py-1.5 text-xs"
          >
            {t('access.remove')}
          </button>
        </div>
        <p className="text-[11px] text-amber-400 flex items-start gap-1.5">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          {t('access.warnApply')}
        </p>
      </div>
    </div>
  );
}
