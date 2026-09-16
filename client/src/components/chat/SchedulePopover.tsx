import { useState, useEffect, useRef, useMemo } from 'react';
import { Clock } from 'lucide-react';
import { useT } from '../../lib/i18n';

interface Props {
  /** 예약할 시각이 정해졌을 때 호출 — ISO 문자열. */
  onPick: (runAt: string) => void;
  onClose: () => void;
}

/** Date → `<input type="datetime-local">` 가 요구하는 로컬 시각 문자열. */
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function atHour(dayOffset: number, hour: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d;
}

export default function SchedulePopover({ onPick, onClose }: Props) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const [custom, setCustom] = useState(() => toLocalInputValue(new Date(Date.now() + 30 * 60_000)));

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // 이미 지난 프리셋(예: 밤 10시에 본 '오늘 21시')은 숨긴다.
  const presets = useMemo(() => {
    const now = Date.now();
    return [
      { key: 'in10m', label: t('chat.schedule.in10m'), date: new Date(now + 10 * 60_000) },
      { key: 'in1h', label: t('chat.schedule.in1h'), date: new Date(now + 60 * 60_000) },
      { key: 'today21', label: t('chat.schedule.today21'), date: atHour(0, 21) },
      { key: 'tomorrow9', label: t('chat.schedule.tomorrow9'), date: atHour(1, 9) }
    ].filter((p) => p.date.getTime() > now);
  }, [t]);

  const customDate = custom ? new Date(custom) : null;
  const customValid = !!customDate && !Number.isNaN(customDate.getTime()) && customDate.getTime() > Date.now();

  return (
    <div
      ref={rootRef}
      className="absolute bottom-full right-0 mb-2 z-50 w-64 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl overflow-hidden"
    >
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-zinc-800 text-[11px] uppercase tracking-wider text-zinc-500">
        <Clock size={12} />
        <span>{t('chat.schedule.title')}</span>
      </div>

      <div className="p-1">
        {presets.map((p) => (
          <button
            key={p.key}
            onClick={() => onPick(p.date.toISOString())}
            className="w-full text-left px-2 py-1.5 rounded flex items-center justify-between gap-2 text-sm text-zinc-300 hover:bg-zinc-800/60"
          >
            <span>{p.label}</span>
            <span className="text-[11px] text-zinc-500 font-mono">
              {p.date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
            </span>
          </button>
        ))}
      </div>

      <div className="border-t border-zinc-800 p-2 space-y-2">
        <label className="block text-[11px] text-zinc-500">{t('chat.schedule.customLabel')}</label>
        <input
          type="datetime-local"
          value={custom}
          min={toLocalInputValue(new Date())}
          onChange={(e) => setCustom(e.target.value)}
          className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-zinc-600"
          style={{ fontSize: '14px' }}
        />
        <button
          onClick={() => customValid && onPick(customDate!.toISOString())}
          disabled={!customValid}
          className="w-full rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-30 disabled:hover:bg-emerald-700 text-white text-sm py-1.5 transition-colors"
        >
          {t('chat.schedule.confirm')}
        </button>
      </div>
    </div>
  );
}
