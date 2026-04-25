import { useEffect, useMemo, useState } from 'react';
import { Palette, Copy, X } from 'lucide-react';
import { useT } from '../../lib/i18n';
import { useToastStore } from '../../store/toast-store';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Claude Design 요청 프롬프트 빌더.
 * 4요소(목표/레이아웃/콘텐츠/대상) + 선택 컨텍스트를 모아
 * Claude Design(claude.ai)에 붙여넣기 좋은 포맷으로 만들어 클립보드에 복사.
 */
export default function ClaudeDesignModal({ open, onClose }: Props) {
  const t = useT();
  const addToast = useToastStore((s) => s.add);

  const [goal, setGoal] = useState('');
  const [layout, setLayout] = useState('');
  const [content, setContent] = useState('');
  const [audience, setAudience] = useState('');
  const [extra, setExtra] = useState('');

  useEffect(() => {
    if (open) {
      setGoal('');
      setLayout('');
      setContent('');
      setAudience('');
      setExtra('');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const prompt = useMemo(() => {
    const lines = [
      goal.trim() && `[${t('design.field.goal')}] ${goal.trim()}`,
      layout.trim() && `[${t('design.field.layout')}] ${layout.trim()}`,
      content.trim() && `[${t('design.field.content')}] ${content.trim()}`,
      audience.trim() && `[${t('design.field.audience')}] ${audience.trim()}`,
      `[${t('design.field.brand')}] ${t('design.brand.value')}`,
      extra.trim() && `[${t('design.field.extra')}] ${extra.trim()}`
    ].filter(Boolean);
    return lines.join('\n');
  }, [goal, layout, content, audience, extra, t]);

  const canCopy =
    goal.trim().length > 0 &&
    layout.trim().length > 0 &&
    content.trim().length > 0 &&
    audience.trim().length > 0;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      addToast('success', t('design.toast.copied'));
      onClose();
    } catch {
      addToast('error', t('design.toast.copyFail'));
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-start justify-center z-[95] p-4 pt-[10vh]"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-zinc-900 border border-zinc-700 rounded-lg w-full max-w-2xl shadow-2xl overflow-hidden"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
          <Palette size={16} className="text-orange-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-sm text-zinc-100 font-medium">{t('design.title')}</div>
            <div className="text-[11px] text-zinc-500">{t('design.subtitle')}</div>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 shrink-0">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-3 max-h-[60vh] overflow-y-auto">
          <Field
            autoFocus
            label={t('design.field.goal')}
            hint={t('design.hint.goal')}
            value={goal}
            onChange={setGoal}
          />
          <Field
            label={t('design.field.layout')}
            hint={t('design.hint.layout')}
            value={layout}
            onChange={setLayout}
          />
          <Field
            label={t('design.field.content')}
            hint={t('design.hint.content')}
            value={content}
            onChange={setContent}
          />
          <Field
            label={t('design.field.audience')}
            hint={t('design.hint.audience')}
            value={audience}
            onChange={setAudience}
          />
          <Field
            label={`${t('design.field.extra')} (${t('design.optional')})`}
            hint={t('design.hint.extra')}
            value={extra}
            onChange={setExtra}
          />

          <div>
            <div className="text-[11px] text-zinc-500 mb-1">{t('design.preview')}</div>
            <pre className="text-xs bg-zinc-950 border border-zinc-800 rounded p-3 whitespace-pre-wrap text-zinc-300 max-h-40 overflow-y-auto font-mono">
              {prompt}
            </pre>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-800">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
          >
            {t('design.cancel')}
          </button>
          <button
            onClick={onCopy}
            disabled={!canCopy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-orange-500 hover:bg-orange-400 disabled:bg-zinc-700 disabled:text-zinc-500 disabled:cursor-not-allowed text-white font-medium"
            title={canCopy ? '' : t('design.hint.fillRequired')}
          >
            <Copy size={12} />
            {t('design.copy')}
          </button>
        </div>
      </div>
    </div>
  );
}

interface FieldProps {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}

function Field({ label, hint, value, onChange, autoFocus }: FieldProps) {
  return (
    <div>
      <label className="text-[11px] text-zinc-400">{label}</label>
      <textarea
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={hint}
        rows={2}
        className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-orange-500/50 resize-none"
      />
    </div>
  );
}
