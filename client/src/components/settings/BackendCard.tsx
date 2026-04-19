import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash2, ChevronDown, ChevronRight, Check, XCircle, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import type { BackendPublic } from '../../lib/types';
import { InlineEditText } from './InlineEditText';
import { ModelRow } from './ModelRow';
import { SecretInput } from './SecretInput';
import { useT } from '../../lib/i18n';

export function BackendCard({
  backend,
  isActive,
  isAusterity,
  allBackends,
  onDelete
}: {
  backend: BackendPublic;
  isActive: boolean;
  isAusterity: boolean;
  allBackends: BackendPublic[];
  onDelete: () => void;
}) {
  const qc = useQueryClient();
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [draftAlias, setDraftAlias] = useState('');
  const [draftModel, setDraftModel] = useState('');

  const patchField = useMutation({
    mutationFn: (patch: Partial<BackendPublic>) => api.patchBackend(backend.id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backends'] })
  });

  const patchModels = useMutation({
    mutationFn: (models: Record<string, string>) => api.patchBackend(backend.id, { models }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backends'] })
  });

  const addModel = () => {
    const key = draftAlias.trim();
    const val = draftModel.trim();
    if (!key || !val) return;
    patchModels.mutate({ ...backend.models, [key]: val });
    setDraftAlias('');
    setDraftModel('');
  };

  const removeModel = (key: string) => {
    const next = { ...backend.models };
    delete next[key];
    patchModels.mutate(next);
  };

  const updateModel = (key: string, newVal: string) => {
    patchModels.mutate({ ...backend.models, [key]: newVal });
  };

  const renameModel = (oldKey: string, newKey: string) => {
    const next = { ...backend.models };
    next[newKey] = next[oldKey];
    delete next[oldKey];
    patchModels.mutate(next);
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 space-y-2">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <InlineEditText
              value={backend.label}
              onSave={(v) => patchField.mutate({ label: v })}
              className="font-semibold truncate flex-1"
              placeholder="Backend label"
            />
            {isActive && (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300">
                ACTIVE
              </span>
            )}
            {isAusterity && (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300">
                AUSTERITY
              </span>
            )}
          </div>
          <div className="text-[11px] text-zinc-500 font-mono">{backend.id}</div>
        </div>
        {backend.type !== 'claude-cli' && (
          <button
            onClick={onDelete}
            className="p-1 rounded hover:bg-red-900/40 text-zinc-500 hover:text-red-400"
            title={t('backendCard.delete')}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
      <div className="text-[11px] text-zinc-500 space-y-1">
        <div>
          <span className="text-zinc-600">Type:</span> {backend.type}
        </div>
        {backend.type !== 'claude-cli' && (
          <div className="flex items-center gap-1.5 font-mono">
            <span className="text-zinc-600 shrink-0">URL:</span>
            <InlineEditText
              value={backend.baseURL ?? ''}
              onSave={(v) => patchField.mutate({ baseURL: v })}
              className="text-zinc-400 flex-1 truncate"
              placeholder="https://api.example.com/v1/"
            />
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <span className="text-zinc-600 shrink-0">Env:</span>
          {backend.type === 'claude-cli' ? (
            <span className="font-mono text-zinc-400">{backend.envKey ?? 'ANTHROPIC_API_KEY'}</span>
          ) : (
            <InlineEditText
              value={backend.envKey ?? ''}
              onSave={(v) => patchField.mutate({ envKey: v })}
              className="font-mono text-zinc-400"
              placeholder="MY_API_KEY"
            />
          )}
          {backend.envStatus?.startsWith('set') ? (
            <span className="flex items-center gap-0.5 text-emerald-400">
              <Check size={10} /> {backend.envStatus}
            </span>
          ) : backend.envKey ? (
            <span className="flex items-center gap-0.5 text-red-400">
              <XCircle size={10} /> unset
            </span>
          ) : (
            <span className="flex items-center gap-0.5 text-zinc-500">
              OAuth
            </span>
          )}
        </div>
        {backend.type === 'claude-cli' && (
          <div className="text-[11px] text-zinc-600">
            {t('backendCard.claudeOauthHint')}
          </div>
        )}
      </div>
      {/* Fallback 설정 */}
      {backend.type !== 'claude-cli' && (
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="text-zinc-600 shrink-0">{t('backendCard.fallbackLabel')}</span>
          <select
            value={backend.fallback ?? ''}
            onChange={(e) => patchField.mutate({ fallback: e.target.value || null } as Partial<BackendPublic>)}
            className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-[11px] text-zinc-400 font-mono"
          >
            <option value="">{t('backendCard.fallbackNone')}</option>
            {allBackends.filter(b => b.id !== backend.id).map(b => (
              <option key={b.id} value={b.id}>{b.label} ({b.id})</option>
            ))}
          </select>
          <span className="text-zinc-600">{t('backendCard.fallbackHint')}</span>
        </div>
      )}

      {backend.envKey && (
        <SecretInput
          backendId={backend.id}
          envKey={backend.envKey}
          source={backend.secretSource ?? 'none'}
        />
      )}
      {/* Claude CLI: OAuth 토큰도 별도 입력 */}
      {backend.type === 'claude-cli' && (
        <SecretInput
          backendId={`${backend.id}_oauth`}
          envKey="CLAUDE_CODE_OAUTH_TOKEN"
          source="none"
          label={t('backendCard.oauthTokenLabel')}
          hint={t('backendCard.oauthTokenHint')}
        />
      )}
      <div className="border-t border-zinc-800 pt-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center gap-1 text-[11px] uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
        >
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          <span>{t('backendCard.modelsLabel', { count: Object.keys(backend.models).length })}</span>
        </button>
        {expanded && (
          <div className="mt-2 space-y-2">
            <p className="text-[11px] text-zinc-600 leading-snug">
              {t('backendCard.modelsDesc')}
            </p>
            <div className="space-y-1">
              {Object.entries(backend.models).length === 0 && (
                <div className="text-[11px] text-zinc-600 italic">{t('backendCard.noModels')}</div>
              )}
              {Object.entries(backend.models).map(([key, val]) => (
                <ModelRow
                  key={key}
                  alias={key}
                  modelId={val}
                  onUpdate={(newVal) => updateModel(key, newVal)}
                  onRename={(newKey) => renameModel(key, newKey)}
                  onRemove={() => removeModel(key)}
                />
              ))}
            </div>
            <div className="flex gap-1">
              <input
                value={draftAlias}
                onChange={(e) => setDraftAlias(e.target.value)}
                placeholder={t('backendCard.aliasPlaceholder')}
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-[11px] font-mono"
              />
              <input
                value={draftModel}
                onChange={(e) => setDraftModel(e.target.value)}
                placeholder={t('backendCard.modelIdPlaceholder')}
                className="flex-[2] bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-[11px] font-mono"
              />
              <button
                onClick={addModel}
                disabled={!draftAlias.trim() || !draftModel.trim()}
                className="rounded bg-emerald-900/40 hover:bg-emerald-900/60 disabled:opacity-30 text-emerald-200 px-2 py-1 text-[11px] flex items-center"
              >
                <Plus size={11} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
