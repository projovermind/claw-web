import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Globe, Copy, RefreshCw, Check, AlertTriangle, Wifi, ShoppingCart, Search, Link, Power, ExternalLink, Loader2, Download } from 'lucide-react';
import { api, getAuthToken } from '../../lib/api';
import { useT } from '../../lib/i18n';

// ═══════════════════════════════════════════════════════════════
// QuickUrlCard — 유동 URL (Quick Tunnel, trycloudflare.com)
// ═══════════════════════════════════════════════════════════════
function QuickUrlCard() {
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
        <Globe size={14} className="text-sky-400" />
        <div className="text-sm font-semibold text-zinc-300">유동 URL (Quick Tunnel)</div>
        <span className="text-[10px] px-2 py-0.5 rounded bg-sky-900/40 text-sky-300">임시</span>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="ml-auto p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300"
          title="새로고침"
        >
          <RefreshCw size={12} className={isFetching ? 'animate-spin' : ''} />
        </button>
      </div>
      <p className="text-[11px] text-zinc-500 leading-snug">
        서버 기동 시 자동 구축되는 <code className="text-sky-300">*.trycloudflare.com</code> 주소. 재시작하면 URL 이 바뀝니다.
      </p>
      {url ? (
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
      ) : (
        <div className="text-xs text-zinc-500 italic">유동 URL 준비 중... (cloudflared 가 설치되어 있어야 자동 구축됨)</div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// FixedUrlCard — 고정 URL (Cloudflare Named Tunnel hostname)
// ═══════════════════════════════════════════════════════════════
function FixedUrlCard() {
  const { data, refetch, isFetching } = useQuery<TunnelCfStatus>({
    queryKey: ['cf-tunnel-status'],
    queryFn: () => fetch('/api/admin/tunnel/cf/status', { headers: authHeaders() }).then((r) => r.json()),
    refetchInterval: 15000
  });
  const [copied, setCopied] = useState(false);
  const url = data?.hostname ? `https://${data.hostname}` : null;
  const configured = !!(data?.tunnelId && data?.hostname && data?.plistInstalled);

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
        <Link size={14} className="text-emerald-400" />
        <div className="text-sm font-semibold text-zinc-300">고정 URL (Named Tunnel)</div>
        <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-900/40 text-emerald-300">영구</span>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="ml-auto p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300"
          title="새로고침"
        >
          <RefreshCw size={12} className={isFetching ? 'animate-spin' : ''} />
        </button>
      </div>
      <p className="text-[11px] text-zinc-500 leading-snug">
        자신의 도메인(<code className="text-emerald-300">claw.mydomain.com</code>)으로 연결되는 영구 URL. 재부팅해도 고정.
      </p>
      {configured && url ? (
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
      ) : (
        <div className="text-xs text-zinc-500 italic">고정 URL 미설정 — 아래 "고정 URL 구축" 카드에서 도메인 연결하세요.</div>
      )}
    </div>
  );
}

type TunnelType = 'ngrok' | 'cloudflared';

interface TunnelStatus {
  running: boolean;
  type?: TunnelType;
  url?: string;
}

function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token
    ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    : { 'Content-Type': 'application/json' };
}

function DomainConnectCard() {
  const qc = useQueryClient();
  const [type, setType] = useState<TunnelType>('ngrok');
  const [domain, setDomain] = useState('');
  const [copied, setCopied] = useState(false);

  const { data: status } = useQuery<TunnelStatus>({
    queryKey: ['tunnel-connect-status'],
    queryFn: () => fetch('/api/tunnel/status', { headers: authHeaders() }).then(r => r.json()),
    refetchInterval: 5000,
  });

  const startMutation = useMutation({
    mutationFn: () => fetch('/api/tunnel/start', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ type, ...(type === 'ngrok' && domain ? { domain } : {}) }),
    }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tunnel-connect-status'] }),
  });

  const stopMutation = useMutation({
    mutationFn: () => fetch('/api/tunnel/stop', { method: 'POST', headers: authHeaders() }).then(r => r.json()),
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
        {(['ngrok', 'cloudflared'] as TunnelType[]).map((t) => (
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

interface DomainCredentials {
  accountId: string;
  apiToken: string;
  saved: boolean;
}

interface DomainSearchResult {
  name: string;
  price: number;
  available: boolean;
}

interface OwnedDomain {
  id: string;
  name: string;
  zone_id: string;
}

function DomainManagerCard() {
  const qc = useQueryClient();
  const [accountId, setAccountId] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<DomainSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [purchasingDomain, setPurchasingDomain] = useState<string | null>(null);
  const [connectingDomain, setConnectingDomain] = useState<string | null>(null);

  const { data: credentials } = useQuery<DomainCredentials>({
    queryKey: ['domain-credentials'],
    queryFn: () => fetch('/api/domain/credentials', { headers: authHeaders() }).then(r => r.json()),
  });

  const { data: tunnelStatus } = useQuery<{ url?: string }>({
    queryKey: ['tunnel-connect-status'],
  });

  const { data: ownedDomains, refetch: refetchDomains } = useQuery<OwnedDomain[]>({
    queryKey: ['domain-list'],
    queryFn: () => fetch('/api/domain/list', { headers: authHeaders() }).then(r => r.json()),
    enabled: credentials?.saved === true,
  });

  const saveMutation = useMutation({
    mutationFn: () => fetch('/api/domain/credentials', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ accountId, apiToken }),
    }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['domain-credentials'] });
      qc.invalidateQueries({ queryKey: ['domain-list'] });
    },
  });

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setSearchResults([]);
    try {
      const res = await fetch(`/api/domain/search?q=${encodeURIComponent(searchQuery.trim())}`, { headers: authHeaders() });
      const data = await res.json();
      setSearchResults(Array.isArray(data) ? data : []);
    } finally {
      setIsSearching(false);
    }
  };

  const handlePurchase = async (name: string) => {
    setPurchasingDomain(name);
    try {
      await fetch('/api/domain/purchase', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name }),
      });
      refetchDomains();
      setSearchResults(prev => prev.filter(d => d.name !== name));
    } finally {
      setPurchasingDomain(null);
    }
  };

  const handleConnect = async (domain: OwnedDomain) => {
    const target = tunnelStatus?.url;
    if (!target) return;
    setConnectingDomain(domain.id);
    try {
      await fetch('/api/domain/dns-connect', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ zone_id: domain.zone_id, name: domain.name, target }),
      });
    } finally {
      setConnectingDomain(null);
    }
  };

  const isSaved = credentials?.saved === true;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-4">
      <div className="flex items-center gap-2">
        <ShoppingCart size={14} className="text-violet-400" />
        <div className="text-sm font-semibold text-zinc-300">도메인 구매</div>
        {isSaved && (
          <span className="ml-auto text-[11px] text-emerald-400 flex items-center gap-1">
            <Check size={10} />
            자격증명 저장됨
          </span>
        )}
      </div>

      {/* CF Credentials */}
      <div className="space-y-2">
        <p className="text-[11px] text-zinc-500">Cloudflare Account ID와 API Token을 입력하세요.</p>
        <input
          value={accountId}
          onChange={e => setAccountId(e.target.value)}
          placeholder={isSaved ? '••••••••••••••••••••' : 'Account ID'}
          className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
        />
        <input
          type="password"
          value={apiToken}
          onChange={e => setApiToken(e.target.value)}
          placeholder={isSaved ? '••••••••••••••••••••' : 'API Token'}
          className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
        />
        <button
          disabled={(!accountId && !apiToken) || saveMutation.isPending}
          onClick={() => saveMutation.mutate()}
          className="rounded bg-violet-700 hover:bg-violet-600 disabled:opacity-40 px-3 py-1.5 text-xs"
        >
          {saveMutation.isPending ? '저장 중...' : '저장'}
        </button>
      </div>

      {isSaved && (
        <>
          {/* Domain Search */}
          <div className="space-y-2 border-t border-zinc-800 pt-3">
            <div className="text-xs font-medium text-zinc-400">도메인 검색</div>
            <div className="flex gap-2">
              <input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                placeholder="example.com"
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
              />
              <button
                onClick={handleSearch}
                disabled={isSearching || !searchQuery.trim()}
                className="rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 px-3 py-2 text-xs flex items-center gap-1.5 shrink-0"
              >
                <Search size={12} className={isSearching ? 'animate-pulse' : ''} />
                검색
              </button>
            </div>
            {searchResults.length > 0 && (
              <div className="space-y-1">
                {searchResults.map(domain => (
                  <div key={domain.name} className="flex items-center justify-between bg-zinc-950 border border-zinc-800 rounded px-3 py-2">
                    <div>
                      <span className="text-sm font-mono text-zinc-200">{domain.name}</span>
                      {domain.price > 0 && (
                        <span className="ml-2 text-[11px] text-zinc-500">${domain.price}/yr</span>
                      )}
                    </div>
                    <button
                      disabled={!domain.available || purchasingDomain === domain.name}
                      onClick={() => handlePurchase(domain.name)}
                      className="rounded bg-violet-700 hover:bg-violet-600 disabled:opacity-40 px-2.5 py-1 text-xs"
                    >
                      {purchasingDomain === domain.name ? '구매 중...' : domain.available ? '구매' : '불가'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Owned Domains */}
          <div className="space-y-2 border-t border-zinc-800 pt-3">
            <div className="text-xs font-medium text-zinc-400">보유 도메인</div>
            {!ownedDomains || ownedDomains.length === 0 ? (
              <p className="text-[11px] text-zinc-600 italic">보유 도메인 없음</p>
            ) : (
              <div className="space-y-1">
                {ownedDomains.map(domain => (
                  <div key={domain.id} className="flex items-center justify-between bg-zinc-950 border border-zinc-800 rounded px-3 py-2">
                    <span className="text-sm font-mono text-zinc-200">{domain.name}</span>
                    <button
                      disabled={!tunnelStatus?.url || connectingDomain === domain.id}
                      onClick={() => handleConnect(domain)}
                      className="rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 px-2.5 py-1 text-xs flex items-center gap-1.5"
                      title={!tunnelStatus?.url ? '터널 URL이 없습니다' : '현재 터널에 연결'}
                    >
                      <Link size={10} />
                      {connectingDomain === domain.id ? '연결 중...' : '연결'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ServerControlCard — 서버 재시작 (Soft/Force)
// ═══════════════════════════════════════════════════════════════
function ServerControlCard() {
  const [confirming, setConfirming] = useState<'soft' | 'force' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const restart = useMutation({
    mutationFn: (force: boolean) =>
      fetch('/api/admin/restart', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ force })
      }).then((r) => r.json()),
    onSuccess: (data) => {
      setResult({ ok: true, msg: data.msg || '재시작 진행 중' });
      setConfirming(null);
      // 5초 후 상태 초기화 + 재연결 대기
      setTimeout(() => setResult(null), 6000);
    },
    onError: (err: Error) => {
      setResult({ ok: false, msg: err.message || '실패' });
      setConfirming(null);
    }
  });

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Power size={14} className="text-amber-400" />
        <div className="text-sm font-semibold text-zinc-300">서버 관리</div>
      </div>
      <p className="text-[11px] text-zinc-500 leading-snug">
        문제 발생 시 서버를 재시작할 수 있습니다. <b className="text-zinc-300">소프트</b>는 진행 중 작업을
        저장 후 재기동해 자동으로 이어갑니다. <b className="text-zinc-300">강제</b>는 모든 에이전트를
        즉시 종료하고 깨끗한 상태로 재시작합니다.
      </p>

      {result && (
        <div className={`text-xs rounded px-3 py-2 ${result.ok ? 'bg-emerald-900/30 text-emerald-300' : 'bg-red-900/30 text-red-300'}`}>
          {result.msg}
          {result.ok && <span className="ml-2 text-zinc-400">— 잠시 후 페이지가 다시 응답합니다</span>}
        </div>
      )}

      {confirming ? (
        <div className="rounded bg-amber-900/20 border border-amber-800/50 p-3 space-y-2">
          <div className="text-xs text-amber-200 flex items-start gap-1.5">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            {confirming === 'force'
              ? '⚠️ 강제 재시작 — 진행 중인 모든 에이전트 작업이 즉시 중단됩니다. 계속할까요?'
              : '🔄 소프트 재시작 — 진행 중 작업은 저장 후 자동으로 이어갑니다. 계속할까요?'}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => restart.mutate(confirming === 'force')}
              disabled={restart.isPending}
              className="rounded bg-red-700 hover:bg-red-600 px-3 py-1.5 text-xs disabled:opacity-50"
            >
              {restart.isPending ? '재시작 중...' : '확인 — 재시작'}
            </button>
            <button
              onClick={() => setConfirming(null)}
              disabled={restart.isPending}
              className="rounded bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 text-xs"
            >
              취소
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            onClick={() => setConfirming('soft')}
            className="rounded bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 text-xs flex items-center gap-1.5"
          >
            <RefreshCw size={12} /> 소프트 재시작
          </button>
          <button
            onClick={() => setConfirming('force')}
            className="rounded bg-red-900/50 hover:bg-red-900 text-red-200 px-3 py-1.5 text-xs flex items-center gap-1.5"
          >
            <AlertTriangle size={12} /> 강제 재시작
          </button>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// NamedTunnelCard — Cloudflare 고정 URL 자동 구축
// ═══════════════════════════════════════════════════════════════
interface TunnelCfStatus {
  binInstalled: boolean;
  authed: boolean;
  tunnelId: string | null;
  hostname: string | null;
  plistInstalled: boolean;
  setupState: { phase: string; loginUrl: string | null; error: string | null };
}

function NamedTunnelCard() {
  const qc = useQueryClient();
  const [hostname, setHostname] = useState('');
  const [step, setStep] = useState<'idle' | 'awaiting-auth' | 'creating' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const { data: status } = useQuery<TunnelCfStatus>({
    queryKey: ['cf-tunnel-status'],
    queryFn: () => fetch('/api/admin/tunnel/cf/status', { headers: authHeaders() }).then((r) => r.json()),
    refetchInterval: step === 'awaiting-auth' ? 2000 : 10000
  });

  // awaiting-auth 상태에서 cert.pem 생기면 자동 setup 트리거
  useEffect(() => {
    if (step === 'awaiting-auth' && status?.authed && hostname) {
      setStep('creating');
      fetch('/api/admin/tunnel/cf/setup', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ hostname })
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.error) {
            setError(data.error);
            setStep('error');
          } else {
            setStep('ready');
            qc.invalidateQueries({ queryKey: ['cf-tunnel-status'] });
            qc.invalidateQueries({ queryKey: ['tunnel-url'] });
          }
        })
        .catch((err) => {
          setError(err.message);
          setStep('error');
        });
    }
  }, [step, status?.authed, hostname, qc]);

  const startLogin = useMutation({
    mutationFn: () =>
      fetch('/api/admin/tunnel/cf/login', { method: 'POST', headers: authHeaders() }).then((r) => r.json()),
    onSuccess: (data) => {
      if (data.loginUrl) {
        window.open(data.loginUrl, '_blank');
        setStep('awaiting-auth');
      } else if (data.alreadyAuthed) {
        // 이미 인증된 경우 바로 setup
        setStep('awaiting-auth'); // useEffect 가 setup 트리거
      } else {
        setError(data.message || 'login URL 캡처 실패');
        setStep('error');
      }
    }
  });

  const teardown = useMutation({
    mutationFn: () =>
      fetch('/api/admin/tunnel/cf/teardown', { method: 'POST', headers: authHeaders() }).then((r) => r.json()),
    onSuccess: () => {
      setStep('idle');
      setHostname('');
      qc.invalidateQueries({ queryKey: ['cf-tunnel-status'] });
      qc.invalidateQueries({ queryKey: ['tunnel-url'] });
    }
  });

  // 이미 설정된 상태
  const isConfigured = status?.tunnelId && status?.hostname && status?.plistInstalled;

  return (
    <div className="rounded-lg border border-emerald-900/40 bg-emerald-950/10 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Link size={14} className="text-emerald-400" />
        <div className="text-sm font-semibold text-zinc-300">고정 URL (Cloudflare Named Tunnel)</div>
        <span className="ml-auto text-[10px] px-2 py-0.5 rounded bg-emerald-900/40 text-emerald-300">⭐ 추천</span>
      </div>
      <p className="text-[11px] text-zinc-500 leading-snug">
        도메인 하나만 있으면 <code className="text-emerald-300">claw.내도메인.com</code> 같은 영구 URL 을
        자동 구축합니다. 재부팅해도 URL 고정. 대역폭 무제한. 도메인 연 $3~13.
      </p>

      {!status?.binInstalled && (
        <div className="text-xs rounded px-3 py-2 bg-amber-900/30 text-amber-300">
          ⚠️ cloudflared 가 설치되어 있지 않습니다. 터미널에서 <code className="bg-black/30 px-1">brew install cloudflared</code> 먼저 실행하세요.
        </div>
      )}

      {isConfigured && step !== 'error' ? (
        // ─── 이미 구성됨 ───
        <div className="space-y-2">
          <div className="text-xs text-emerald-300 flex items-center gap-1.5">
            <Check size={12} /> 구성 완료
          </div>
          <div className="flex gap-2">
            <code className="flex-1 text-xs font-mono bg-zinc-950 border border-zinc-800 rounded px-3 py-2 truncate select-all">
              https://{status.hostname}
            </code>
            <a
              href={`https://${status.hostname}`}
              target="_blank"
              rel="noreferrer"
              className="rounded bg-zinc-800 hover:bg-zinc-700 px-3 text-xs flex items-center gap-1.5 shrink-0"
            >
              <ExternalLink size={12} /> 열기
            </a>
          </div>
          <button
            onClick={() => teardown.mutate()}
            disabled={teardown.isPending}
            className="rounded bg-red-900/50 hover:bg-red-900 text-red-200 px-3 py-1.5 text-xs"
          >
            {teardown.isPending ? '제거 중...' : '제거 (터널 + DNS 삭제)'}
          </button>
        </div>
      ) : step === 'idle' || step === 'error' ? (
        // ─── 초기/에러 ───
        <div className="space-y-2">
          <input
            type="text"
            value={hostname}
            onChange={(e) => setHostname(e.target.value.trim())}
            placeholder="claw.mydomain.com"
            disabled={!status?.binInstalled}
            className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono disabled:opacity-50"
          />
          {hostname && hostname.includes('.') && hostname.split('.').length === 2 && (
            <div className="text-[11px] rounded px-3 py-2 bg-amber-900/20 text-amber-200 flex items-start gap-1.5">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>
                루트(apex) 도메인은 DNS 충돌/라우팅 문제로 404 가 자주 발생합니다.
                <b className="text-amber-100"> claw.{hostname}</b> 같은 서브도메인 사용을 권장합니다.
              </span>
            </div>
          )}
          <p className="text-[11px] text-zinc-500">
            💡 도메인이 없으면? <a href="https://dash.cloudflare.com/?to=/:account/domains/register" target="_blank" rel="noreferrer" className="text-emerald-400 underline">Cloudflare Registrar</a> 에서 먼저 구매하세요. <code>.cc</code> 는 연 $8 수준.
          </p>
          <button
            onClick={() => {
              setError(null);
              startLogin.mutate();
            }}
            disabled={!hostname || !hostname.includes('.') || !status?.binInstalled || startLogin.isPending}
            className="rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 px-4 py-2 text-sm w-full flex items-center justify-center gap-2"
          >
            {startLogin.isPending ? <Loader2 size={14} className="animate-spin" /> : <Link size={14} />}
            {status?.authed ? '자동 구축 시작' : 'Cloudflare 로그인 → 자동 구축'}
          </button>
          {error && <div className="text-xs text-red-300 bg-red-900/20 rounded px-3 py-2">{error}</div>}
        </div>
      ) : step === 'awaiting-auth' ? (
        <div className="space-y-2">
          <div className="text-xs bg-blue-900/30 text-blue-200 rounded px-3 py-2 flex items-start gap-1.5">
            <Loader2 size={12} className="mt-0.5 animate-spin shrink-0" />
            <div>
              브라우저에서 Cloudflare 로그인 → 도메인 선택 → <b>권한 부여</b> 버튼 클릭<br />
              <span className="text-zinc-400">인증되면 자동으로 다음 단계 진행</span>
            </div>
          </div>
          <button
            onClick={() => {
              setStep('idle');
              setError(null);
            }}
            className="text-xs text-zinc-400 hover:text-zinc-200 underline"
          >
            취소
          </button>
        </div>
      ) : step === 'creating' ? (
        <div className="text-xs bg-zinc-800/50 text-zinc-300 rounded px-3 py-2 flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" />
          터널 생성 → DNS 설정 → config 작성 → LaunchAgent 등록 중...
        </div>
      ) : null}
    </div>
  );
}

interface UpdateInfo {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  downloadUrl?: string;
  pkgUrl?: string | null;
  pkgName?: string | null;
  releaseUrl?: string;
  publishedAt?: string;
  notes?: string;
  error?: string;
}

function UpdateCheckCard() {
  const { data, refetch, isFetching } = useQuery<UpdateInfo>({
    queryKey: ['update-check'],
    queryFn: () => fetch('/api/admin/update/check', { headers: authHeaders() }).then((r) => r.json()),
    staleTime: 60000
  });
  const [installMsg, setInstallMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const install = useMutation({
    mutationFn: async (pkgUrl: string) => {
      const r = await fetch('/api/admin/update/install', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ pkgUrl })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || '설치 요청 실패');
      return j;
    },
    onSuccess: (j) => setInstallMsg({ ok: true, text: j.message || 'Installer.app 이 열렸습니다.' }),
    onError: (e: Error) => setInstallMsg({ ok: false, text: e.message })
  });

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Download size={14} className="text-cyan-400" />
        <div className="text-sm font-semibold text-zinc-300">업데이트 확인</div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="ml-auto p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300"
          title="다시 확인"
        >
          <RefreshCw size={12} className={isFetching ? 'animate-spin' : ''} />
        </button>
      </div>

      {!data ? (
        <div className="text-xs text-zinc-500 italic">확인 중...</div>
      ) : data.error ? (
        <div className="text-xs text-red-300 bg-red-900/20 rounded px-3 py-2">
          {data.error} (현재 v{data.current})
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-3 text-xs">
            <span className="text-zinc-500">현재</span>
            <code className="font-mono text-zinc-200">v{data.current}</code>
            <span className="text-zinc-600">→</span>
            <span className="text-zinc-500">최신</span>
            <code className={`font-mono ${data.hasUpdate ? 'text-emerald-300' : 'text-zinc-200'}`}>
              v{data.latest || '?'}
            </code>
            {data.hasUpdate ? (
              <span className="ml-auto text-[10px] px-2 py-0.5 rounded bg-emerald-900/40 text-emerald-300">
                업데이트 있음
              </span>
            ) : (
              <span className="ml-auto text-[10px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-400">
                최신 버전
              </span>
            )}
          </div>

          {data.hasUpdate && data.pkgUrl && (
            <>
              <button
                onClick={() => {
                  setInstallMsg(null);
                  install.mutate(data.pkgUrl!);
                }}
                disabled={install.isPending}
                className="w-full rounded bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 px-4 py-2 text-sm flex items-center justify-center gap-2"
              >
                {install.isPending ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                {install.isPending ? 'pkg 다운로드 중...' : `v${data.latest} 로 지금 업데이트`}
              </button>
              <p className="text-[11px] text-zinc-500 leading-snug">
                자동으로 pkg 다운로드 + macOS Installer 실행. Installer 에서 계속 버튼만 누르면 기존 설치 자동 정리 후 업데이트됨.
              </p>
              {installMsg && (
                <div className={`text-xs rounded px-3 py-2 ${installMsg.ok ? 'bg-emerald-900/30 text-emerald-300' : 'bg-red-900/30 text-red-300'}`}>
                  {installMsg.text}
                </div>
              )}
              <div className="flex items-center gap-2 text-[11px] text-zinc-600">
                <a href={data.pkgUrl} target="_blank" rel="noreferrer" className="hover:text-zinc-300 underline inline-flex items-center gap-1">
                  <ExternalLink size={10} /> 수동 다운로드
                </a>
                {data.releaseUrl && (
                  <>
                    <span>·</span>
                    <a href={data.releaseUrl} target="_blank" rel="noreferrer" className="hover:text-zinc-300 underline inline-flex items-center gap-1">
                      <ExternalLink size={10} /> 릴리즈 페이지
                    </a>
                  </>
                )}
              </div>
              {data.notes && (
                <details className="text-[11px] text-zinc-500">
                  <summary className="cursor-pointer hover:text-zinc-300">릴리즈 노트</summary>
                  <pre className="mt-2 whitespace-pre-wrap bg-zinc-950 border border-zinc-800 rounded p-2 font-mono text-[10px] max-h-40 overflow-y-auto">
                    {data.notes}
                  </pre>
                </details>
              )}
            </>
          )}
          {!data.hasUpdate && (
            <>
              <div className="text-xs rounded px-3 py-2 bg-emerald-900/20 text-emerald-300 flex items-center gap-2">
                <Check size={12} />
                <span>최신 버전입니다. 업데이트가 필요하지 않습니다.</span>
              </div>
              {data.releaseUrl && (
                <a
                  href={data.releaseUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-zinc-500 hover:text-zinc-300 underline inline-flex items-center gap-1"
                >
                  <ExternalLink size={10} /> GitHub 릴리즈 페이지
                </a>
              )}
            </>
          )}
        </div>
      )}
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
      <UpdateCheckCard />
      <FixedUrlCard />
      <QuickUrlCard />
      <NamedTunnelCard />
      <DomainConnectCard />
      <DomainManagerCard />
      <ServerControlCard />
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
