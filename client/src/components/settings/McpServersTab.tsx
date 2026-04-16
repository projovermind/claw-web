import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { api } from '../../lib/api';

export function McpServersTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['mcp-servers'],
    queryFn: api.getMcpServers
  });

  const [jsonText, setJsonText] = useState('{}');
  const [parseError, setParseError] = useState<string | null>(null);

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

  if (isLoading) return <div className="text-zinc-500 text-sm">Loading...</div>;

  return (
    <div className="max-w-2xl space-y-3">
      <p className="text-[11px] text-zinc-500">
        Claude CLI의 MCP 서버 설정을 관리합니다. <code className="text-zinc-400">.claude/settings.json</code>의 <code className="text-zinc-400">mcpServers</code> 필드를 직접 편집합니다.
      </p>
      {data?.path && (
        <div className="text-[11px] text-zinc-600 font-mono">{data.path}</div>
      )}

      <textarea
        value={jsonText}
        onChange={(e) => handleChange(e.target.value)}
        spellCheck={false}
        className="w-full h-64 bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-zinc-600 resize-y"
      />

      {parseError && (
        <div className="text-[11px] text-red-400">JSON 파싱 오류: {parseError}</div>
      )}

      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={!!parseError || saveMut.isPending}
          className="flex items-center gap-1.5 text-xs bg-emerald-900/50 text-emerald-200 px-4 py-2 rounded disabled:opacity-40 hover:bg-emerald-900/70"
        >
          <Save size={14} />
          {saveMut.isPending ? '저장 중...' : '저장'}
        </button>
      </div>
    </div>
  );
}
