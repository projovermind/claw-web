import { useState } from 'react';
import { useProgressMutation } from '../../lib/useProgressMutation';
import { X, AlertTriangle } from 'lucide-react';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-wider text-zinc-500 mb-1">{label}</div>
      {children}
    </label>
  );
}

export function AddBackendModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [form, setForm] = useState({
    id: '',
    label: '',
    baseURL: '',
    envKey: '',
    secret: '',
    defaultModel: ''
  });
  const add = useProgressMutation({
    title: '백엔드 연결 중...',
    successMessage: '연결 완료',
    invalidateKeys: [['backends']],
    mutationFn: () =>
      api.createBackend({
        id: form.id,
        type: 'openai-compatible',
        label: form.label,
        baseURL: form.baseURL,
        envKey: form.envKey,
        secret: form.secret.trim() || undefined,
        models: {
          default: form.defaultModel,
          opus: form.defaultModel,
          sonnet: form.defaultModel,
          haiku: form.defaultModel
        }
      }),
    onSuccess: () => {
      onClose();
    }
  });
  const valid = form.id && form.label && form.baseURL && form.envKey && form.defaultModel;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
          <h3 className="text-lg font-semibold">{t('addBackend.title')}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-400">
            <X size={18} />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <Labeled label={t('addBackend.id')}>
            <input
              value={form.id}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
              placeholder="ex: groq"
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
            />
          </Labeled>
          <Labeled label={t('addBackend.label')}>
            <input
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
              placeholder="Groq"
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm"
            />
          </Labeled>
          <Labeled label={t('addBackend.baseUrl')}>
            <input
              value={form.baseURL}
              onChange={(e) => setForm({ ...form, baseURL: e.target.value })}
              placeholder="https://api.groq.com/openai/v1/"
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
            />
          </Labeled>
          <Labeled label={t('addBackend.envKey')}>
            <input
              value={form.envKey}
              onChange={(e) => setForm({ ...form, envKey: e.target.value })}
              placeholder="GROQ_API_KEY"
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
            />
            <div className="text-[11px] text-zinc-600 mt-1">
              {t('addBackend.envKeyHint')}
            </div>
          </Labeled>
          <Labeled label={t('addBackend.secret')}>
            <input
              type="password"
              value={form.secret}
              onChange={(e) => setForm({ ...form, secret: e.target.value })}
              placeholder="sk-..."
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
            />
            <div className="text-[11px] text-zinc-600 mt-1">
              {t('addBackend.secretHint')}
            </div>
          </Labeled>
          <Labeled label={t('addBackend.defaultModel')}>
            <input
              value={form.defaultModel}
              onChange={(e) => setForm({ ...form, defaultModel: e.target.value })}
              placeholder="llama-3.3-70b-versatile"
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono"
            />
          </Labeled>
          <div className="text-[11px] text-amber-400 flex items-start gap-1.5 pt-1">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>{t('addBackend.warn')}</span>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-zinc-800">
          <button onClick={onClose} className="px-4 py-2 rounded bg-zinc-800 hover:bg-zinc-700 text-sm">
            {t('addBackend.cancel')}
          </button>
          <button
            disabled={!valid || add.isPending}
            onClick={() => add.mutate()}
            className="px-4 py-2 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-sm"
          >
            {add.isPending ? t('addBackend.submitting') : t('addBackend.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}
