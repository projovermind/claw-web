import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Copy, Check, Lock, AlertTriangle } from 'lucide-react';
import { api } from '../../lib/api';

interface Props {
  backendId: string;
  backendLabel: string;
  onClose: () => void;
}

interface RevealResult {
  secret: { envKey: string; value: string } | null;
  oauthToken: string | null;
  claudeCreds: {
    source: 'credentials.json' | 'keychain';
    path?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: string;
    scopes?: string[];
    subscriptionType?: string;
  } | null;
  env: Record<string, string> | null;
}

/**
 * Reveal a backend's stored credentials after re-authenticating with the
 * server's auth token. Auto-hides values after 60s and closes after 2min
 * with no interaction, to avoid leaving keys on screen.
 */
export function RevealTokenModal({ backendId, backendLabel, onClose }: Props) {
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<RevealResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Auto-close after 2min once a secret is revealed
  useEffect(() => {
    if (!result) return;
    const t = setTimeout(onClose, 120_000);
    return () => clearTimeout(t);
  }, [result, onClose]);

  const submit = async () => {
    if (!password.trim() || pending) return;
    setPending(true);
    setErr(null);
    try {
      const r = await api.revealBackendSecret(backendId, password);
      setResult(r);
      setPassword(''); // clear the password from memory once used
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErr(msg.includes('403') ? '비밀번호가 일치하지 않습니다' : msg);
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-md max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Lock size={14} className="text-amber-400" />
            <div>
              <h3 className="text-sm font-semibold">토큰 보기</h3>
              <div className="text-[11px] text-zinc-500 font-mono">{backendLabel} · {backendId}</div>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-400">✕</button>
        </div>

        <div className="p-5 space-y-4">
          {!result ? (
            <>
              <div className="flex items-start gap-2 text-[11px] text-amber-200 bg-amber-950/30 border border-amber-900/40 rounded px-3 py-2">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                <span>
                  저장된 API 키를 화면에 표시합니다. 어깨너머/스크린 공유 환경에서는 주의하세요.
                  서버 인증 토큰(설정 &gt; 보안)으로 재확인합니다.
                </span>
              </div>
              <div>
                <label className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1 block">
                  서버 인증 토큰 (비밀번호)
                </label>
                <input
                  ref={inputRef}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submit()}
                  placeholder="••••••••"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
                />
              </div>
              {err && (
                <div className="text-[11px] text-red-300 bg-red-950/40 border border-red-900/40 rounded px-2 py-1">
                  {err}
                </div>
              )}
            </>
          ) : (
            <>
              {!result.secret &&
                !result.oauthToken &&
                !result.claudeCreds &&
                !result.env && (
                  <div className="text-[11px] text-zinc-400 bg-zinc-950 border border-zinc-800 rounded px-3 py-2">
                    이 백엔드에 저장된 토큰을 찾을 수 없습니다. (configDir 미설정 또는 외부 keychain 접근 실패)
                  </div>
                )}
              {result.secret && (
                <RevealedSecret
                  label={`저장된 API 키 (secrets.json · ${result.secret.envKey})`}
                  value={result.secret.value}
                />
              )}
              {result.oauthToken && (
                <RevealedSecret
                  label="Managed OAuth Token (CLAUDE_CODE_OAUTH_TOKEN)"
                  value={result.oauthToken}
                />
              )}
              {result.claudeCreds?.accessToken && (
                <RevealedSecret
                  label={`Claude OAuth Access Token (${result.claudeCreds.source})`}
                  value={result.claudeCreds.accessToken}
                  hint={
                    result.claudeCreds.expiresAt
                      ? `만료: ${new Date(result.claudeCreds.expiresAt).toLocaleString()}`
                      : undefined
                  }
                />
              )}
              {result.claudeCreds?.refreshToken && (
                <RevealedSecret
                  label={`Claude OAuth Refresh Token (${result.claudeCreds.source})`}
                  value={result.claudeCreds.refreshToken}
                />
              )}
              {result.env &&
                Object.entries(result.env).map(([k, v]) => (
                  <RevealedSecret key={k} label={`shell env · ${k}`} value={v} />
                ))}
              {result.claudeCreds?.subscriptionType && (
                <div className="text-[10px] text-zinc-500">
                  Subscription: <span className="font-mono">{result.claudeCreds.subscriptionType}</span>
                  {result.claudeCreds.scopes?.length
                    ? ` · scopes: ${result.claudeCreds.scopes.join(', ')}`
                    : ''}
                </div>
              )}
              <div className="text-[10px] text-zinc-600">
                * 2분 후 자동으로 닫힙니다. 직접 닫으려면 우측 상단 ✕ 또는 배경 클릭.
              </div>
            </>
          )}
        </div>

        {!result && (
          <div className="flex justify-end gap-2 px-5 py-3 border-t border-zinc-800">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-sm"
            >
              취소
            </button>
            <button
              onClick={submit}
              disabled={!password.trim() || pending}
              className="px-4 py-2 rounded bg-amber-700 hover:bg-amber-600 disabled:opacity-40 text-sm"
            >
              {pending ? '확인 중...' : '확인'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function RevealedSecret({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);

  // Auto-hide value after 60s for safety
  useEffect(() => {
    if (!show) return;
    const t = setTimeout(() => setShow(false), 60_000);
    return () => clearTimeout(t);
  }, [show]);

  const masked = value.length > 12
    ? `${value.slice(0, 8)}${'•'.repeat(Math.max(8, value.length - 12))}${value.slice(-4)}`
    : '•'.repeat(value.length);

  const copy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[11px] uppercase tracking-wider text-zinc-500 truncate">{label}</div>
        {hint && <div className="text-[10px] text-zinc-600 shrink-0">{hint}</div>}
      </div>
      <div className="flex items-center gap-1.5 bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5">
        <code className="text-[11px] text-emerald-300 font-mono flex-1 break-all">
          {show ? value : masked}
        </code>
        <button
          onClick={() => setShow((v) => !v)}
          title={show ? '숨기기' : '보기'}
          className="shrink-0 text-zinc-500 hover:text-zinc-200 p-1"
        >
          {show ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
        <button
          onClick={copy}
          title="복사"
          className="shrink-0 text-zinc-500 hover:text-zinc-200 p-1"
        >
          {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
        </button>
      </div>
    </div>
  );
}
