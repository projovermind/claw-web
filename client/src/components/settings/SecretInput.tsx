import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, Save, Lock, Eye, EyeOff } from 'lucide-react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';

export function SecretInput({
  backendId,
  envKey,
  source,
  label,
  hint
}: {
  backendId: string;
  envKey: string;
  source: 'managed' | 'shell' | 'none';
  label?: string;
  hint?: string;
}) {
  const qc = useQueryClient();
  const t = useT();
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const setSecret = useMutation({
    mutationFn: (v: string | null) => api.setBackendSecret(backendId, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backends'] });
      setValue('');
    }
  });

  const sourceLabel =
    source === 'managed'
      ? { text: t('secret.managed'), cls: 'text-emerald-400' }
      : source === 'shell'
        ? { text: t('secret.shell', { envKey }), cls: 'text-sky-400' }
        : { text: t('secret.unset'), cls: 'text-red-400' };

  return (
    <div className="border-t border-zinc-800 pt-2 mt-1 space-y-1.5">
      <div className="flex items-center gap-1.5 text-[11px]">
        <Lock size={10} className="text-zinc-600" />
        <span className="text-zinc-500 uppercase tracking-wider">{label ?? t('secret.apiKey')}</span>
        <span className={`ml-auto ${sourceLabel.cls}`}>{sourceLabel.text}</span>
      </div>
      <div className="flex gap-1">
        <div className="flex-1 relative">
          <input
            type={reveal ? 'text' : 'password'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && value.trim()) setSecret.mutate(value.trim());
            }}
            placeholder={source === 'none' ? t('secret.placeholderNew') : t('secret.placeholderOverwrite')}
            className="w-full bg-zinc-950 border border-zinc-800 rounded pl-2 pr-7 py-1.5 text-[11px] font-mono focus:outline-none focus:border-zinc-600"
          />
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-zinc-500 hover:text-zinc-300"
            title={reveal ? t('secret.hide') : t('secret.show')}
          >
            {reveal ? <EyeOff size={11} /> : <Eye size={11} />}
          </button>
        </div>
        <button
          disabled={!value.trim() || setSecret.isPending}
          onClick={() => setSecret.mutate(value.trim())}
          className="rounded bg-emerald-900/40 hover:bg-emerald-900/60 disabled:opacity-30 text-emerald-200 px-2 py-1 text-[11px] flex items-center gap-1"
        >
          <Save size={10} />
          {t('secret.save')}
        </button>
        {source === 'managed' && (
          <button
            onClick={() => {
              if (confirm(t('secret.deleteConfirm'))) setSecret.mutate(null);
            }}
            className="rounded bg-red-900/40 hover:bg-red-900/60 text-red-200 px-2 py-1 text-[11px]"
            title={t('secret.delete')}
          >
            <Trash2 size={10} />
          </button>
        )}
      </div>
      <p className="text-[11px] text-zinc-600 leading-snug">
        {hint ?? t('secret.hintDefault')}
      </p>
    </div>
  );
}
