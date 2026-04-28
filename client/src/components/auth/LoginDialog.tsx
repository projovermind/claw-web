import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, AlertTriangle, User } from 'lucide-react';
import { authEvents, setAuthToken, api } from '../../lib/api';
import { useT } from '../../lib/i18n';

type Mode = 'user' | 'token';

/**
 * LoginDialog supports two auth modes:
 *  - 'user'  — username/password (admin-users-store backed; default once at least
 *              one admin user exists, e.g. the seeded admin/1234).
 *  - 'token' — single bearer token (legacy webConfig.auth.token).
 *
 * On mount we probe /api/auth/info to decide the default mode. The dialog also
 * pops up whenever any API call returns 401 (via authEvents).
 */
export default function LoginDialog() {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('token');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Listen for 401s from api.ts
  useEffect(() => {
    const onUnauthorized = () => setOpen(true);
    authEvents.addEventListener('unauthorized', onUnauthorized);
    return () => authEvents.removeEventListener('unauthorized', onUnauthorized);
  }, []);

  // On mount: figure out auth mode + auto-open if a token is required but missing.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [settings, info] = await Promise.all([
          api.settings().catch(() => null),
          api.authInfo().catch(() => ({ hasUsers: false, userMode: false })),
        ]);
        if (cancelled) return;
        const userMode = !!info?.userMode;
        setMode(userMode ? 'user' : 'token');
        const required = userMode || !!settings?.auth?.enabled;
        if (required) {
          try {
            if (!localStorage.getItem('hivemind:auth-token')) setOpen(true);
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore network errors */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submitToken = async () => {
    const trimmed = token.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    setAuthToken(trimmed);
    try {
      await api.agents();
      setOpen(false);
      setToken('');
      qc.invalidateQueries();
    } catch (e) {
      setAuthToken(null);
      setError((e as Error).message || t('loginDialog.tokenInvalid'));
    } finally {
      setBusy(false);
    }
  };

  const submitUserPass = async () => {
    const u = username.trim();
    const p = password;
    if (!u || !p) return;
    setBusy(true);
    setError(null);
    try {
      const { token: sessionToken } = await api.authLogin(u, p);
      setAuthToken(sessionToken);
      setOpen(false);
      setUsername('');
      setPassword('');
      qc.invalidateQueries();
    } catch (e) {
      setAuthToken(null);
      setError((e as Error).message || '로그인 실패');
    } finally {
      setBusy(false);
    }
  };

  const submit = mode === 'user' ? submitUserPass : submitToken;

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-[100] p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-md">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-zinc-800">
          <KeyRound size={16} className="text-amber-400" />
          <h3 className="text-base font-semibold">
            {mode === 'user' ? '로그인' : t('loginDialog.title')}
          </h3>
        </div>
        <div className="p-5 space-y-3">
          {mode === 'user' ? (
            <>
              <p className="text-xs text-zinc-400 leading-relaxed">
                관리자 계정으로 로그인하세요.
              </p>
              <div className="relative">
                <User size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  autoFocus
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submit();
                  }}
                  placeholder="사용자명"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-zinc-600"
                />
              </div>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit();
                }}
                placeholder="비밀번호"
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm focus:outline-none focus:border-zinc-600"
              />
            </>
          ) : (
            <>
              <p className="text-xs text-zinc-400 leading-relaxed">
                {t('loginDialog.desc')}
              </p>
              <input
                autoFocus
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit();
                }}
                placeholder="Bearer token"
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-zinc-600"
              />
            </>
          )}
          {error && (
            <div className="flex items-start gap-1.5 text-[11px] text-red-300">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <div className="text-[11px] text-zinc-600 leading-snug">
            {mode === 'user'
              ? '비밀번호 분실 시 서버 측에서 data/private/admin-users.json을 직접 수정하거나 삭제 후 재시작하세요.'
              : t('loginDialog.lostHint')}
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-zinc-800">
          <button
            type="button"
            onClick={() => setMode(mode === 'user' ? 'token' : 'user')}
            className="text-[11px] text-zinc-500 hover:text-zinc-300"
          >
            {mode === 'user' ? '토큰으로 로그인' : '사용자명/비밀번호로 로그인'}
          </button>
          <button
            disabled={busy || (mode === 'user' ? !username.trim() || !password : !token.trim())}
            onClick={submit}
            className="px-4 py-2 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-sm"
          >
            {busy ? t('loginDialog.checking') : t('loginDialog.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}
