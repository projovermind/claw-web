import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, AlertTriangle } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useT } from '../../lib/i18n';

/** 서버가 4개를 넘으면 모든 세션 시작 시 도구 정의를 전부 로드하게 된다. */
const SERVER_COUNT_WARN = 4;

export function McpServersTab() {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['mcp-servers'],
    queryFn: api.getMcpServers
  });

  const { data: presets = [] } = useQuery({
    queryKey: ['mcp-presets'],
    queryFn: api.mcpPresets
  });

  const [jsonText, setJsonText] = useState('{}');
  const [parseError, setParseError] = useState<string | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);

  const applyPreset = useMutation({
    mutationFn: (id: string) => api.applyMcpPreset(id),
    onSuccess: () => {
      setPresetError(null);
      qc.invalidateQueries({ queryKey: ['mcp-servers'] });
    },
    onError: (e: Error) => {
      setPresetError(
        e instanceof ApiError && e.status === 409
          ? '같은 이름의 서버가 이미 등록돼 있습니다.'
          : e.message
      );
    }
  });

  useEffect(() => {
    if (data?.mcpServers) {
      setJsonText(JSON.stringify(data.mcpServers, null, 2));
    }
  }, [data]);

  const saveMut = useMutation({
    mutationFn: (mcpServers: Record<string, unknown>) => api.putMcpServers(mcpServers),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mcp-servers'] });
      setParseError(null);
    }
  });

  const handleSave = () => {
    try {
      const parsed = JSON.parse(jsonText);
      setParseError(null);
      saveMut.mutate(parsed);
    } catch (e) {
      setParseError((e as Error).message);
    }
  };

  const handleChange = (val: string) => {
    setJsonText(val);
    try {
      JSON.parse(val);
      setParseError(null);
    } catch (e) {
      setParseError((e as Error).message);
    }
  };

  const serverCount = Object.keys(data?.mcpServers ?? {}).length;

  if (isLoading) return <div className="text-zinc-500 text-sm">Loading...</div>;

  return (
    <div className="max-w-2xl space-y-3">
      <p className="text-[11px] text-zinc-500">
        {t('mcpTab.desc')}
      </p>
      {data?.path && (
        <div className="text-[11px] text-zinc-600 font-mono">{data.path}</div>
      )}

      {serverCount >= SERVER_COUNT_WARN && (
        <div className="flex items-start gap-2 rounded border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-300">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            MCP 서버 {serverCount}개 — 모든 세션이 시작할 때 도구 정의를 전부 로드합니다.
            쓰지 않는 서버는 지우는 편이 세션 시작 비용을 줄입니다.
          </span>
        </div>
      )}

      {presets.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[11px] text-zinc-500">프리셋 — 현재 목록에 병합합니다.</div>
          <div className="flex flex-wrap gap-1.5">
            {presets.map((p) => (
              <button
                key={p.id}
                onClick={() => applyPreset.mutate(p.id)}
                disabled={applyPreset.isPending}
                title={p.desc}
                className="text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-3 py-1.5 rounded disabled:opacity-40"
              >
                + {p.name}
              </button>
            ))}
          </div>
          {presetError && <div className="text-[11px] text-red-400">{presetError}</div>}
        </div>
      )}

      <textarea
        value={jsonText}
        onChange={(e) => handleChange(e.target.value)}
        spellCheck={false}
        className="w-full h-64 bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-zinc-600 resize-y"
      />

      {parseError && (
        <div className="text-[11px] text-red-400">{t('mcpTab.parseError', { error: parseError })}</div>
      )}

      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={!!parseError || saveMut.isPending}
          className="flex items-center gap-1.5 text-xs bg-emerald-900/50 text-emerald-200 px-4 py-2 rounded disabled:opacity-40 hover:bg-emerald-900/70"
        >
          <Save size={14} />
          {saveMut.isPending ? t('mcpTab.saving') : t('mcpTab.save')}
        </button>
      </div>
    </div>
  );
}
