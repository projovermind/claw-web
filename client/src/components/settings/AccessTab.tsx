import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Globe, Copy, RefreshCw, Check, AlertTriangle, Link } from 'lucide-react';
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

const DOMAIN_TABS = ['ngrok', 'Cloudflare Tunnel', '리버스프록시'] as const;
type DomainTab = typeof DOMAIN_TABS[number];

const DOMAIN_COMMANDS: Record<DomainTab, string> = {
  ngrok: 'ngrok http 3838 --url=YOUR_DOMAIN',
  'Cloudflare Tunnel': 'cloudflared tunnel --url http://localhost:3838',
  '리버스프록시': `server {
  listen 80;
  server_name your.domain.com;

  location / {
    proxy_pass http://localhost:3838;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
  }
}`
};

const DOMAIN_HINTS: Record<DomainTab, string> = {
  ngrok: 'YOUR_DOMAIN을 실제 ngrok 정적 도메인으로 교체하세요. ngrok 대시보드(dashboard.ngrok.com)에서 도메인을 등록할 수 있습니다.',
  'Cloudflare Tunnel': 'Cloudflare Zero Trust 터널을 사용하면 별도 포트 개방 없이 안전하게 외부 접속할 수 있습니다. cloudflared 설치 후 실행하세요.',
  '리버스프록시': 'nginx 설정 파일(/etc/nginx/sites-available/your-site)에 추가하고 sudo nginx -s reload로 적용하세요.'
};

function DomainGuideCard() {
  const [activeTab, setActiveTab] = useState<DomainTab>('ngrok');
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(DOMAIN_COMMANDS[activeTab]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Link size={14} className="text-blue-400" />
        <div className="text-sm font-semibold text-zinc-300">도메인 연결</div>
      </div>
      <div className="flex gap-1 border-b border-zinc-800 pb-0">
        {DOMAIN_TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => { setActiveTab(tab); setCopied(false); }}
            className={`px-3 py-1.5 text-xs rounded-t transition-colors ${
              activeTab === tab
                ? 'bg-zinc-800 text-zinc-200'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>
      <div className="relative">
        <pre className="text-xs font-mono bg-zinc-950 border border-zinc-800 rounded px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed text-zinc-300">
          {DOMAIN_COMMANDS[activeTab]}
        </pre>
        <button
          onClick={copy}
          className="absolute top-2 right-2 rounded bg-zinc-800 hover:bg-zinc-700 px-2 py-1 text-xs flex items-center gap-1"
        >
          {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
          {copied ? '복사됨' : '복사'}
        </button>
      </div>
      <p className="text-[11px] text-zinc-500 leading-snug">
        {DOMAIN_HINTS[activeTab]}
      </p>
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
      <DomainGuideCard />
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
