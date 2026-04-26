import fssync from 'node:fs';
import path from 'node:path';

/**
 * Inspect a Claude CLI configDir for OAuth credentials.
 * Returns:
 *   { has: bool,
 *     source: 'credentials.json' | 'oauthAccount' | 'managed' | 'shell' | 'none',
 *     expiresAt?: ISO string,
 *     expiringSoon?: bool,    // < 7 days
 *     accountEmail?: string }
 *
 * Pass `managedOAuth: true` if the backend has a per-backend OAuth token in
 * secrets.json — that takes precedence over any configDir state.
 */
export function inspectCreds(configDir, { managedOAuth = false } = {}) {
  if (managedOAuth) {
    return { has: true, source: 'managed' };
  }
  if (!configDir) {
    return { has: false, source: 'none' };
  }
  try {
    const credsFile = path.join(configDir, '.credentials.json');
    if (fssync.existsSync(credsFile)) {
      try {
        const raw = fssync.readFileSync(credsFile, 'utf8');
        const data = JSON.parse(raw);
        const token = data?.claudeAiOauth ?? data;
        const expiresAt = token?.expiresAt
          ? new Date(token.expiresAt > 1e12 ? token.expiresAt : token.expiresAt * 1000).toISOString()
          : null;
        const expiringSoon = expiresAt && (new Date(expiresAt).getTime() - Date.now() < 7 * 86400_000);
        const out = { has: true, source: 'credentials.json' };
        if (expiresAt) out.expiresAt = expiresAt;
        if (expiringSoon) out.expiringSoon = true;
        return out;
      } catch {
        return { has: true, source: 'credentials.json' };
      }
    }
    const claudeJson = path.join(configDir, '.claude.json');
    if (fssync.existsSync(claudeJson)) {
      try {
        const raw = fssync.readFileSync(claudeJson, 'utf8');
        const data = JSON.parse(raw);
        if (data?.oauthAccount?.accountUuid) {
          return {
            has: true,
            source: 'oauthAccount',
            accountEmail: data.oauthAccount.emailAddress ?? null,
          };
        }
      } catch { /* ignore */ }
    }
    return { has: false, source: 'none' };
  } catch {
    return { has: false, source: 'none' };
  }
}
