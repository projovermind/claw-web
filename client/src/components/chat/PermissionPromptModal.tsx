import { useEffect, useState } from 'react';
import { ShieldAlert, Check, CheckCheck, History, X } from 'lucide-react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { useChatStore, type PermissionPrompt } from '../../store/chat-store';

type Scope = 'once' | 'session' | 'always';
type Busy = '' | 'allow' | 'allowSession' | 'allowAlways' | 'deny';

interface Props {
  sessionId: string;
  prompt: PermissionPrompt;
}

/**
 * Tool approval modal. Rendered by ChatPane when the session has a pending
 * permission-prompt (pushed via WS `chat.permission-prompt`).
 *
 * Allow (scope:'once') → POST behavior:"allow"
 * This session (scope:'session') → 같은 세션의 같은 도구는 모달 안 뜨고 자동 통과 (서버 메모리)
 * Allow+Always (scope:'always') → 영구 허용 (server adds tool to agent.allowedTools)
 * Deny → POST behavior:"deny"
 *
 * Closing the modal itself does not cancel the request; only user action or
 * server timeout does. Esc = deny.
 */
export default function PermissionPromptModal({ sessionId, prompt }: Props) {
  const t = useT();
  const [busy, setBusy] = useState<Busy>('');
  const clearPermissionPrompt = useChatStore((s) => s.clearPermissionPrompt);

  async function respond(behavior: 'allow' | 'deny', scope: Scope = 'once') {
    if (busy) return;
    const kind: Busy = behavior === 'deny'
      ? 'deny'
      : scope === 'always' ? 'allowAlways'
      : scope === 'session' ? 'allowSession'
      : 'allow';
    setBusy(kind);
    try {
      await api.approveTool(sessionId, prompt.reqId, { behavior, scope });
      clearPermissionPrompt(sessionId);
    } catch {
      // leave modal open — server may not have received it
      setBusy('');
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        respond('deny');
      } else if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) {
        e.preventDefault();
        respond('allow');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, prompt.reqId]);

  const inputPreview = safeStringify(prompt.input);

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-zinc-900 border border-amber-600/40 rounded-lg w-full max-w-xl shadow-2xl shadow-amber-900/20 flex flex-col">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-zinc-800">
          <ShieldAlert size={18} className="text-amber-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-zinc-100">{t('permission.title')}</div>
            <div className="text-[11px] text-zinc-500 mt-0.5">{t('permission.description')}</div>
          </div>
        </div>

        <div className="px-5 py-4 space-y-3 text-sm">
          <div className="flex items-baseline gap-3">
            <div className="text-[11px] uppercase tracking-wide text-zinc-500 w-14 shrink-0">
              {t('permission.tool')}
            </div>
            <div className="font-mono text-amber-300">{prompt.toolName}</div>
          </div>
          <div className="flex items-start gap-3">
            <div className="text-[11px] uppercase tracking-wide text-zinc-500 w-14 shrink-0 pt-1">
              {t('permission.input')}
            </div>
            <pre className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-[12px] text-zinc-300 font-mono overflow-auto max-h-60 whitespace-pre-wrap break-all">
              {inputPreview}
            </pre>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-zinc-800 flex items-center justify-between gap-3">
          <div className="text-[11px] text-zinc-500">{t('permission.hint')}</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => respond('deny')}
              disabled={!!busy}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              <X size={14} /> {t('permission.deny')}
            </button>
            <button
              type="button"
              onClick={() => respond('allow', 'always')}
              disabled={!!busy}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded border border-emerald-800/60 text-emerald-300 hover:bg-emerald-900/30 disabled:opacity-50"
            >
              <CheckCheck size={14} /> {t('permission.allowAlways')}
            </button>
            <button
              type="button"
              onClick={() => respond('allow', 'session')}
              disabled={!!busy}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded border border-emerald-700/60 text-emerald-200 hover:bg-emerald-900/30 disabled:opacity-50"
            >
              <History size={14} /> {t('permission.allowSession')}
            </button>
            <button
              type="button"
              onClick={() => respond('allow', 'once')}
              disabled={!!busy}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
            >
              <Check size={14} /> {t('permission.allow')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function safeStringify(obj: unknown): string {
  try {
    const s = JSON.stringify(obj, null, 2);
    if (!s) return '';
    return s.length > 4000 ? s.slice(0, 4000) + '\n… (truncated)' : s;
  } catch {
    return String(obj);
  }
}
