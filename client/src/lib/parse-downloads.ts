// 에이전트 응답에서 <claw-download path="..." label="..." /> 마커를 추출.
// 마커는 본문에서 제거된 cleaned 문자열과 추출된 항목 배열을 함께 반환한다.

export interface DownloadItem {
  path: string;
  label?: string;
}

const TAG_RE = /<claw-download\b([^>]*?)\/?>/gi;
const ATTR_RE = /(\w+)\s*=\s*"([^"]*)"/g;

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

export function extractDownloads(text: string): { body: string; items: DownloadItem[] } {
  if (!text || !text.includes('<claw-download')) {
    return { body: text, items: [] };
  }
  const items: DownloadItem[] = [];
  const body = text.replace(TAG_RE, (_match, attrsRaw: string) => {
    const attrs = parseAttrs(attrsRaw);
    const p = attrs.path?.trim();
    if (!p) return '';
    items.push({ path: p, label: attrs.label?.trim() || undefined });
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { body, items };
}

// 스트리밍 중에는 부분 마커가 도착할 수 있어 일관된 카드 렌더가 어렵다.
// 완성된 마커는 추출해 숨기고, 미완성(<claw-download 만 있고 닫히지 않은) 부분도 잘라낸다.
export function stripDownloadsForStreaming(text: string): string {
  if (!text) return text;
  let cleaned = text.replace(TAG_RE, '');
  // 닫히지 않은 미완성 마커 잘라내기 (가장 마지막 <claw-download 부터 텍스트 끝까지 임시로 숨김)
  const openIdx = cleaned.lastIndexOf('<claw-download');
  if (openIdx !== -1) {
    const tail = cleaned.slice(openIdx);
    if (!/\/?>/.test(tail)) {
      cleaned = cleaned.slice(0, openIdx);
    }
  }
  return cleaned;
}
