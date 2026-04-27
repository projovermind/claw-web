import fssync from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Inspect a Claude CLI configDir for OAuth credentials.
 * Returns:
 *   { has: bool,
 *     source: 'credentials.json' | 'oauthAccount' | 'keychain' | 'managed' | 'shell' | 'none',
 *     expiresAt?: ISO string,
 *     expiringSoon?: bool,    // < 7 days
 *     accountEmail?: string,
 *     keychainShared?: bool }  // macOS keychain 은 시스템 전역 — 멀티 계정 충돌 경고용
 *
 * Pass `managedOAuth: true` if the backend has a per-backend OAuth token in
 * secrets.json — that takes precedence over any configDir state.
 *
 * Resolution order:
 *  1. managedOAuth (가장 신뢰 가능 — backend 별 격리)
 *  2. configDir/.credentials.json   (Linux / 구버전 macOS)
 *  3. configDir/.claude.json oauthAccount (Claude CLI 가 메타만 찍어둔 경우 — 토큰은 keychain)
 *  4. macOS Keychain "Claude Code-credentials" (현재 macOS 기본 저장소)
 */
export function inspectCreds(configDir, { managedOAuth = false, replaced = false } = {}) {
  const result = _inspectCreds(configDir, { managedOAuth });
  return replaced ? { ...result, replaced: true } : result;
}

function _inspectCreds(configDir, { managedOAuth = false } = {}) {
  if (managedOAuth) {
    return { has: true, source: 'managed' };
  }
  if (configDir) {
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
            // 메타데이터는 있음 → 토큰은 보통 macOS Keychain 에 존재.
            // Keychain 토큰 조회는 추가로 시도 (있어도 없어도 oauthAccount 결과는 반환).
            const kc = inspectKeychain();
            const out = {
              has: true,
              source: 'oauthAccount',
              accountEmail: data.oauthAccount.emailAddress ?? null,
            };
            if (kc.has) {
              if (kc.expiresAt) out.expiresAt = kc.expiresAt;
              if (kc.expiringSoon) out.expiringSoon = true;
              out.keychainShared = true; // 멀티 계정 시 충돌 경고용
            }
            return out;
          }
        } catch { /* ignore */ }
      }
    } catch { /* fall through to keychain */ }
  }
  // 마지막: macOS Keychain 직접 조회 (configDir 가 비어있거나 파일이 없을 때)
  const kc = inspectKeychain();
  if (kc.has) {
    return { ...kc, source: 'keychain', keychainShared: true };
  }
  return { has: false, source: 'none' };
}

/**
 * macOS Keychain 의 "Claude Code-credentials" generic password 항목을 조회.
 * 시스템 전역 1개만 존재하므로 멀티 계정 불가 — UI 에서 keychainShared 플래그로 경고.
 */
function inspectKeychain() {
  if (process.platform !== 'darwin') return { has: false };
  try {
    const out = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500 }
    ).trim();
    if (!out) return { has: false };
    let expiresAt = null;
    try {
      const parsed = JSON.parse(out);
      const token = parsed?.claudeAiOauth ?? parsed;
      if (token?.expiresAt) {
        const ms = token.expiresAt > 1e12 ? token.expiresAt : token.expiresAt * 1000;
        expiresAt = new Date(ms).toISOString();
      }
    } catch { /* opaque token — 만료시각 미상 */ }
    const result = { has: true };
    if (expiresAt) {
      result.expiresAt = expiresAt;
      if (new Date(expiresAt).getTime() - Date.now() < 7 * 86400_000) {
        result.expiringSoon = true;
      }
    }
    return result;
  } catch {
    return { has: false };
  }
}
