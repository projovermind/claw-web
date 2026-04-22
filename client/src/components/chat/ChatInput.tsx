import { useState, useEffect, useRef, useCallback, KeyboardEvent } from 'react';
import { Send, Square, X, Paperclip, Loader2, AlertTriangle, FileText } from 'lucide-react';
import { useUploadsStore } from '../../store/uploads-store';
import { getAuthToken, api } from '../../lib/api';
import { useCommands, expandCommand, type SlashCommand } from '../../lib/commands';
import { useT } from '../../lib/i18n';
import SlashPopover from './SlashPopover';
import AtFilePopover from './AtFilePopover';

interface Props {
  disabled?: boolean;
  running: boolean;
  workingDir?: string | null;
  sessionId?: string | null;
  onSend: (message: string, attachmentPaths: string[]) => void;
  onAbort: () => void;
  /** System command callbacks — called by /clear, /new, /export etc. */
  onSystemCommand?: (cmd: string, arg?: string) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isImage(contentType: string): boolean {
  return contentType.startsWith('image/');
}

type PopoverMode = 'none' | 'slash' | 'atfile';

export default function ChatInput({ disabled, running, workingDir, sessionId, onSend, onAbort, onSystemCommand }: Props) {
  const t = useT();
  const COMMANDS = useCommands();
  const [value, setValue] = useState('');

  // 드래프트 복원: 세션 전환 시 저장된 내용 불러오기
  useEffect(() => {
    if (!sessionId) { setValue(''); return; }
    const saved = localStorage.getItem(`draft:${sessionId}`);
    setValue(saved ?? '');
  }, [sessionId]);

  // 세션이 "실제로 사용 가능해진 시점"에 자동 포커스.
  // - sessionId 가 바뀔 때뿐 아니라 disabled → enabled 전환 시에도 트리거.
  // - textarea 의 disabled 상태를 DOM 레벨에서 확인하고, 아직 disabled 면
  //   rAF 로 한번 더 시도(상태 반영 타이밍 어긋남 방지).
  // - 모바일에서는 프로그래매틱 focus 로 키보드가 올라오지 않을 수 있지만
  //   최소한 커서 위치는 잡아둬서, 사용자가 탭 한 번으로 바로 입력 가능.
  useEffect(() => {
    if (!sessionId || disabled) return;
    let cancelled = false;
    let tries = 0;
    const tryFocus = () => {
      if (cancelled) return;
      const ta = textareaRef.current;
      if (!ta) return;
      // 비활성 textarea 는 focus 불가 — 다음 프레임에 재시도
      if (ta.disabled) {
        if (tries++ < 5) requestAnimationFrame(tryFocus);
        return;
      }
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
      try { ta.focus({ preventScroll: true }); } catch { ta.focus(); }
      const len = ta.value.length;
      try { ta.setSelectionRange(len, len); } catch { /* noop */ }
    };
    const raf = requestAnimationFrame(tryFocus);
    return () => { cancelled = true; cancelAnimationFrame(raf); };
  }, [sessionId, disabled]);

  // 드래프트 저장: 타이핑 500ms 후 localStorage에 저장
  useEffect(() => {
    if (!sessionId) return;
    if (!value) { localStorage.removeItem(`draft:${sessionId}`); return; }
    const timer = setTimeout(() => {
      localStorage.setItem(`draft:${sessionId}`, value);
    }, 500);
    return () => clearTimeout(timer);
  }, [value, sessionId]);
  const staged = useUploadsStore((s) => s.staged);
  const removeStaged = useUploadsStore((s) => s.remove);
  const clearStaged = useUploadsStore((s) => s.clear);
  const uploading = useUploadsStore((s) => s.uploading);
  const lastError = useUploadsStore((s) => s.lastError);
  const clearError = useUploadsStore((s) => s.setError);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Popover state
  const [popover, setPopover] = useState<PopoverMode>('none');
  const [popoverQuery, setPopoverQuery] = useState('');
  const [popoverCursor, setPopoverCursor] = useState(0);
  // Start position of the trigger character in the input (/ or @)
  const [triggerStart, setTriggerStart] = useState(0);

  // Detect popover triggers as user types
  const handleInput = useCallback((newVal: string) => {
    setValue(newVal);

    // Slash commands: `/` at position 0
    if (newVal.startsWith('/')) {
      setPopover('slash');
      setPopoverQuery(newVal.slice(1).split(' ')[0]); // text between / and first space
      setPopoverCursor(0);
      setTriggerStart(0);
      return;
    }

    // @file: find the last `@` that's preceded by a space or is at position 0
    const lastAt = newVal.lastIndexOf('@');
    if (lastAt >= 0 && (lastAt === 0 || newVal[lastAt - 1] === ' ')) {
      const afterAt = newVal.slice(lastAt + 1);
      // Only activate if there's no space after @ yet (still typing the reference)
      if (!afterAt.includes(' ') || afterAt.length < 30) {
        setPopover('atfile');
        setPopoverQuery(afterAt.split(' ')[0]); // text until space
        setPopoverCursor(0);
        setTriggerStart(lastAt);
        return;
      }
    }

    // No trigger
    setPopover('none');
  }, []);

  const closePopover = useCallback(() => {
    setPopover('none');
    setPopoverQuery('');
    setPopoverCursor(0);
  }, []);

  // Slash: user picked a command
  const onSlashSelect = useCallback((cmd: SlashCommand) => {
    const afterSlash = value.slice(1);
    const spaceIdx = afterSlash.indexOf(' ');
    const userInput = spaceIdx >= 0 ? afterSlash.slice(spaceIdx + 1) : '';
    const expanded = expandCommand(cmd, userInput);

    // System commands — UI actions, not chat messages
    if (cmd.system) {
      setValue('');
      closePopover();
      onSystemCommand?.(cmd.name, userInput.trim() || undefined);
      return;
    }

    // Special: /run starts a background task instead of a chat message
    if (cmd.name === 'run' && userInput.trim()) {
      (async () => {
        try {
          await api.startTask(userInput.trim(), sessionId || undefined);
          setValue('');
          closePopover();
        } catch (err) {
          alert(`${t('chat.input.taskFailed')}: ${(err as Error).message}`);
        }
      })();
      return;
    }

    // Special: /loop starts a Ralph Loop instead of a normal message
    if (cmd.name === 'loop' && sessionId && userInput.trim()) {
      (async () => {
        try {
          await api.startLoop(sessionId, expanded, 10, 'DONE');
          // Send the first iteration as a regular message
          onSend(expanded, []);
          setValue('');
          closePopover();
        } catch (err) {
          alert(`${t('chat.input.loopFailed')}: ${(err as Error).message}`);
        }
      })();
      return;
    }

    setValue(expanded);
    closePopover();
    setTimeout(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(expanded.length, expanded.length);
      }
    }, 0);
  }, [value, closePopover, sessionId, onSend]);

  // @file: user picked a file path
  const onAtFileSelect = useCallback((filePath: string) => {
    // Replace @query with the full path
    const before = value.slice(0, triggerStart);
    const afterAt = value.slice(triggerStart + 1);
    const spaceIdx = afterAt.indexOf(' ');
    const after = spaceIdx >= 0 ? afterAt.slice(spaceIdx) : '';
    const newVal = `${before}${filePath}${after} `;
    setValue(newVal);
    closePopover();
    setTimeout(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(newVal.length, newVal.length);
      }
    }, 0);
  }, [value, triggerStart, closePopover]);

  const submit = () => {
    const trimmed = value.trim();
    if (disabled) return;
    if (!trimmed && staged.length === 0) return;
    closePopover();
    const paths = staged.map((u) => u.path);
    onSend(trimmed || t('chat.input.attachOnly'), paths);
    setValue('');
    clearStaged();
    if (sessionId) localStorage.removeItem(`draft:${sessionId}`);
    // Reset textarea height after send
    setTimeout(() => { if (textareaRef.current) textareaRef.current.style.height = 'auto'; }, 0);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // When a popover is open, arrow keys and Enter control the popover
    if (popover !== 'none') {
      const maxLen = popover === 'slash'
        ? COMMANDS.filter((c) => !popoverQuery || c.name.includes(popoverQuery.toLowerCase())).length
        : 15; // @file max results
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setPopoverCursor((c) => Math.min(c + 1, maxLen - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setPopoverCursor((c) => Math.max(c - 1, 0));
        return;
      }
      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
        e.preventDefault();
        // Delegate to the popover's current selection
        if (popover === 'slash') {
          const filtered = COMMANDS.filter((c) =>
            !popoverQuery || c.name.includes(popoverQuery.toLowerCase()) || c.desc.toLowerCase().includes(popoverQuery.toLowerCase())
          );
          if (filtered[popoverCursor]) onSlashSelect(filtered[popoverCursor]);
        }
        // @file: popover handles via onSelect callback from the component
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closePopover();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        // Tab = accept current selection (same as Enter)
        if (popover === 'slash') {
          const filtered = COMMANDS.filter((c) =>
            !popoverQuery || c.name.includes(popoverQuery.toLowerCase())
          );
          if (filtered[popoverCursor]) onSlashSelect(filtered[popoverCursor]);
        }
        return;
      }
    }

    // Desktop: Enter → send, Shift+Enter → newline
    // Mobile: Enter → newline (virtual keyboard), send button only
    const isMobile = window.innerWidth < 1024;
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      if (isMobile) {
        // Mobile: Enter always inserts newline (don't intercept)
        return;
      }
      if (!e.shiftKey) {
        e.preventDefault();
        submit();
      }
    }
  };

  // Auto-resize textarea to fit content (min 1 row, max ~6 rows)
  const autoResize = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  };

  return (
    <div className="border-t border-zinc-800 bg-zinc-950/80">
      {/* Error banner */}
      {lastError && (
        <div className="mx-3 mt-2 flex items-start gap-2 rounded border border-red-900/60 bg-red-900/20 p-2 text-[11px] text-red-200">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          <span className="flex-1 break-all">{lastError}</span>
          <button onClick={() => clearError(null)} className="shrink-0 text-red-300 hover:text-red-100" title={t('common.close')}>
            <X size={11} />
          </button>
        </div>
      )}

      {/* Upload in progress */}
      {uploading > 0 && (
        <div className="px-3 pt-2 flex items-center gap-1.5 text-[11px] text-sky-300">
          <Loader2 size={12} className="animate-spin" />
          <span>{t('chat.input.uploading')} ({uploading})</span>
        </div>
      )}

      {/* Staged attachments */}
      {staged.length > 0 && (
        <div className="px-3 pt-2">
          <div className="flex items-center gap-1.5 mb-1.5">
            <Paperclip size={12} className="text-emerald-400" />
            <span className="text-[11px] uppercase tracking-wider text-emerald-300 font-semibold">
              {t('chat.input.attached', { count: staged.length })}
            </span>
            <button onClick={clearStaged} className="ml-auto text-[11px] text-zinc-500 hover:text-zinc-300">
              {t('common.removeAll')}
            </button>
          </div>
          <div className="flex items-start gap-2 flex-wrap">
            {staged.map((u) => (
              <StagedChip key={u.id} u={u} onRemove={() => removeStaged(u.id)} />
            ))}
          </div>
        </div>
      )}

      {/* Input box — textarea with buttons INSIDE the border */}
      <div className="p-2 lg:p-3 relative">
        {/* Popovers (above the input box) */}
        {popover === 'slash' && (
          <SlashPopover query={popoverQuery} cursor={popoverCursor}
            onSelect={onSlashSelect} onCursorChange={setPopoverCursor} onClose={closePopover} />
        )}
        {popover === 'atfile' && (
          <AtFilePopover query={popoverQuery} workingDir={workingDir ?? null}
            cursor={popoverCursor} onSelect={onAtFileSelect} onCursorChange={setPopoverCursor} onClose={closePopover} />
        )}

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg focus-within:border-zinc-600 transition-colors">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => { handleInput(e.target.value); autoResize(); }}
            onKeyDown={onKeyDown}
            disabled={disabled}
            placeholder={disabled ? t('chat.input.disabledPlaceholder') : t('chat.input.placeholder')}
            rows={1}
            className="w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm focus:outline-none disabled:opacity-50 overflow-y-auto"
            style={{ fontSize: '16px', minHeight: '44px', maxHeight: '160px' }}
          />
          {/* Bottom bar inside the input box: attach left, send right */}
          <div className="flex items-center justify-between px-2 pb-2">
            <label className="p-1.5 rounded hover:bg-zinc-800 cursor-pointer text-zinc-500 hover:text-zinc-300 transition-colors" title={t('chat.input.attachBtn')}>
              <Paperclip size={18} />
              <input type="file" multiple className="hidden" onChange={async (e) => {
                const files = Array.from(e.target.files ?? []);
                for (const f of files) {
                  try {
                    const up = await api.uploadFile(f);
                    useUploadsStore.getState().add(up);
                  } catch (err) {
                    useUploadsStore.getState().setError(`${f.name}: ${(err as Error).message}`);
                  }
                }
                e.target.value = '';
              }} />
            </label>
            {running ? (
              <div className="flex gap-1">
                {/* 응답 중 메시지 → 현재 응답 중단하고 참고해서 이어서 답변 */}
                <button onClick={submit}
                  disabled={disabled || (!value.trim() && staged.length === 0)}
                  className="p-1.5 rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-30 text-white transition-colors"
                  title="응답 중 참고 — 현재 응답 중단 후 이전 진행사항 + 새 메시지로 이어서 답변">
                  <Send size={18} />
                </button>
                <button onClick={onAbort}
                  className="p-1.5 rounded bg-red-900/60 hover:bg-red-900 text-red-200 transition-colors" title={t('chat.input.abortBtn')}>
                  <Square size={18} />
                </button>
              </div>
            ) : (
              <button onClick={submit}
                disabled={disabled || (!value.trim() && staged.length === 0)}
                className="p-1.5 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-30 text-white transition-colors" title={t('chat.input.sendBtn')}>
                <Send size={18} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StagedChip({
  u,
  onRemove
}: {
  u: import('../../store/uploads-store').StagedUpload;
  onRemove: () => void;
}) {
  const t = useT();
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const isImg = isImage(u.contentType);

  useEffect(() => {
    if (!isImg) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    (async () => {
      try {
        const token = getAuthToken();
        const res = await fetch(`/api/uploads/${u.id}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {}
        });
        if (!res.ok || cancelled) return;
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setThumbUrl(objectUrl);
      } catch { /* ignore */ }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [u.id, isImg]);

  return (
    <div className="group relative flex items-center gap-1.5 rounded border border-emerald-900/50 bg-emerald-900/15 px-2 py-1.5" title={u.path}>
      {isImg && thumbUrl ? (
        <img src={thumbUrl} alt={u.filename} className="w-10 h-10 object-cover rounded border border-zinc-700 shrink-0" />
      ) : (
        <div className="w-10 h-10 rounded border border-zinc-800 bg-zinc-900 flex items-center justify-center shrink-0">
          <FileText size={14} className="text-zinc-500" />
        </div>
      )}
      <div className="flex flex-col min-w-0">
        <span className="text-[11px] text-zinc-200 truncate max-w-[180px]">{u.filename}</span>
        <span className="text-[11px] text-zinc-500">{formatSize(u.size)}</span>
      </div>
      <button onClick={onRemove} className="ml-1 text-zinc-500 hover:text-red-400" title={t('common.remove')}>
        <X size={12} />
      </button>
    </div>
  );
}
