import { HttpError } from '../middleware/error-handler.js';

const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 1024 * 1024; // 1MB

/**
 * github.com blob URL → raw.githubusercontent.com URL.
 * 이미 raw 이거나 다른 호스트면 그대로 반환.
 */
export function toRawUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new HttpError(400, 'Invalid URL', 'INVALID_URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new HttpError(400, 'Only http(s) URLs are supported', 'INVALID_URL');
  }
  if (u.hostname === 'github.com') {
    // /owner/repo/blob/ref/path… → /owner/repo/ref/path…
    const parts = u.pathname.split('/').filter(Boolean);
    const blobAt = parts.indexOf('blob');
    if (blobAt >= 2) {
      const rest = [...parts.slice(0, blobAt), ...parts.slice(blobAt + 1)];
      return `https://raw.githubusercontent.com/${rest.join('/')}`;
    }
  }
  return u.toString();
}

/** SKILL.md 본문에서 frontmatter(name/description)와 본문을 분리 */
export function parseSkillMarkdown(text) {
  let body = text;
  let name = null;
  let description = '';
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (m) {
    const fm = m[1];
    body = text.slice(m[0].length);
    const nameMatch = /^name:\s*(.+)$/m.exec(fm);
    const descMatch = /^description:\s*(.+)$/m.exec(fm);
    if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, '');
    if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, '');
  }
  // 플러그인 네임스페이스 참조는 이 서버에서 의미가 없으므로 평문으로 치환
  body = body.replace(/superpowers:([a-z0-9-]+)/g, "'$1' 스킬");
  body = body.replace(/\$\{CLAUDE_PLUGIN_ROOT\}[^\s)]*/g, '(생략)');
  return { name, description: description.slice(0, 500), body: body.trim() };
}

/** raw URL 의 경로에서 스킬 이름 추정 (…/<skill-name>/SKILL.md) */
export function nameFromUrl(rawUrl) {
  const segments = new URL(rawUrl).pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  if (/^SKILL\.md$/i.test(last) && segments.length >= 2) return segments[segments.length - 2];
  return last.replace(/\.md$/i, '') || null;
}

/** URL 을 받아 스킬 생성 payload 로 변환. 네트워크 오류는 HttpError 로 정규화. */
export async function fetchSkillFromUrl(url, { fetchImpl = fetch } = {}) {
  const rawUrl = toRawUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(rawUrl, { signal: controller.signal, redirect: 'follow' });
  } catch (err) {
    throw new HttpError(
      err?.name === 'AbortError' ? 504 : 502,
      err?.name === 'AbortError' ? 'Fetch timed out (5s)' : `Fetch failed: ${err?.message ?? 'unknown'}`,
      'FETCH_FAILED'
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new HttpError(502, `Fetch failed with status ${res.status}`, 'FETCH_FAILED');
  }
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    throw new HttpError(413, 'Skill file exceeds 1MB', 'TOO_LARGE');
  }
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    throw new HttpError(413, 'Skill file exceeds 1MB', 'TOO_LARGE');
  }

  const { name, description, body } = parseSkillMarkdown(text);
  const resolvedName = name || nameFromUrl(rawUrl);
  if (!resolvedName) {
    throw new HttpError(422, 'Could not determine skill name', 'NO_SKILL_NAME');
  }
  if (!body) {
    throw new HttpError(422, 'Skill file has no content', 'EMPTY_SKILL');
  }
  return {
    name: resolvedName.slice(0, 80),
    description: (description || resolvedName).slice(0, 500),
    content: `<!-- source: ${url} -->\n${body}`,
    sourceUrl: url
  };
}
