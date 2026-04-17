import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, AlertTriangle } from 'lucide-react';
import { authEvents, setAuthToken, api } from '../../lib/api';
import { useT } from '../../lib/i18n';

/**
 * LoginDialog pops up whenever any API call returns 401. User pastes a token,
 * it's saved to localStorage, and we invalidate all queries to retry with the
 * new header.
 *
 * It ALSO auto-opens on mount if the server reports auth.enabled === true and
 * we have no token stored (so first-load doesn't require any failed request).
 */
export default function LoginDialog() {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Listen for 401s from api.ts
  useEffect(() => {
    const onUnauthorized = () => setOpen(true);
    authEvents.addEventListener('unauthorized', onUnauthorized);
    return () => authEvents.removeEventListener('unauthorized', onUnauthorized);
  }, []);

  // Probe settings on mount — if auth is required but we're not holding a token, open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await api.settings();
        if (!cancelled && s.auth?.enabled) {
          // If we have no token stored, open. If we have one, assume it's still valid
          // until a real request fails with 401.
          try {
            if (!localStorage.getItem('hivemind:auth-token')) setOpen(true);
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore — settings is always public, so this should only fail on network issues */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async () => {
    const trimmed = token.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    setAuthToken(trimmed);
    try {
      // Quick probe: hit /agents with the new token. If it returns 401, the token is wrong.
      await api.agents();
      setOpen(false);
      setToken('');
      // Force every query to re-run with the new Authorization header.
      qc.invalidateQueries();
    } catch (e) {
      setAuthToken(null);
      setError((e as Error).message || t('loginDialog.tokenInvalid'));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-[100] p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-md">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-zinc-800">
          <KeyRound size={16} className="text-amber-400" />
          <h3 className="text-base font-semibold">{t('loginDialog.title')}</h3>
        </div>
        <div className="p-5 space-y-3">
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
          {error && (
            <div className="flex items-start gap-1.5 text-[11px] text-red-300">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <div className="text-[11px] text-zinc-600 leading-snug">
            {t('loginDialog.lostHint')}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-zinc-800">
          <button
            disabled={!token.trim() || busy}
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
