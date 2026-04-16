import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Globe, Copy, RefreshCw, Check, AlertTriangle } from 'lucide-react';
import { api } from '../../lib/api';

function TunnelUrlCard() {
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['tunnel-url'],
    queryFn: api.tunnelUrl,
    refetchInterval: 15000 // poll every 15s since URL may change on cloudflared restart
  });
  const [copied, setCopied] = useState(false);
  const url = data?.url ?? null;

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Globe size={14} className="text-emerald-400" />
        <div className="text-sm font-semibold text-zinc-300">외부 접속 URL (Cloudflare Tunnel)</div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="ml-auto p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300"
          title="새로 고침"
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
              {copied ? '복사됨' : '복사'}
            </button>
          </div>
          <p className="text-[11px] text-zinc-500 leading-snug">
            💡 폰/아이패드/친구 노트북 어디서든 이 URL로 접속 가능. 비밀번호 프롬프트가 뜨면 서버 토큰을 입력.
            Cloudflare quick tunnel은 영구 URL이 아니라서 <code>cloudflared</code> 재시작 시 URL이 바뀜. 안정적
            URL은 Cloudflare 계정 + 도메인 필요.
          </p>
        </>
      ) : (
        <div className="text-xs text-zinc-500 italic">
          터널 준비 중... cloudflared가 아직 URL을 발급 못 했거나 서비스가 내려간 상태.
        </div>
      )}
    </div>
  );
}

export function AccessTab() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const [token, setToken] = useState('');

  const patch = useMutation({
    mutationFn: (body: { auth: { enabled?: boolean; token?: string | null } }) => api.patchSettings(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] })
  });

  if (!data) return <div className="text-zinc-500">Loading...</div>;

  return (
    <div className="space-y-5 max-w-2xl">
      <TunnelUrlCard />
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
        <div className="text-sm font-semibold text-zinc-300">원격 접속 인증</div>
        <p className="text-[11px] text-zinc-500">
          Tailscale/Cloudflare Tunnel로 웹을 외부 노출할 때 ON. OFF면 인증 없이 바로 접근 가능(로컬 전용).
        </p>
        <div className="flex items-center gap-3">
          <button
            onClick={() => patch.mutate({ auth: { enabled: !data.auth.enabled } })}
            className={`rounded px-4 py-2 text-sm ${
              data.auth.enabled
                ? 'bg-emerald-900/40 text-emerald-200'
                : 'bg-zinc-800 text-zinc-400'
            }`}
          >
            Auth {data.auth.enabled ? 'ON' : 'OFF'}
          </button>
          <span className="text-[11px] text-zinc-500">
            Token: {data.auth.token ? '••• (설정됨)' : '미설정'}
          </span>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
        <div className="text-sm font-semibold text-zinc-300">Bearer Token 변경</div>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="새 토큰 (영문/숫자 16자 이상 권장)"
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
            저장
          </button>
          <button
            onClick={() => patch.mutate({ auth: { token: null } })}
            className="rounded bg-red-900/50 hover:bg-red-900 text-red-200 px-3 py-1.5 text-xs"
          >
            토큰 제거
          </button>
        </div>
        <p className="text-[11px] text-amber-400 flex items-start gap-1.5">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          Auth ON + 토큰 설정 시 즉시 적용. 잃어버리면 <code>web-config.json</code>에서 직접 수정.
        </p>
      </div>
    </div>
  );
}
