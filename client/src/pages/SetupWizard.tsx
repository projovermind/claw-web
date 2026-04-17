import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Sparkles, Folder, Check, X, Loader2 } from 'lucide-react';

interface ScannedProject {
  path: string;
  name: string;
  title?: string;
  description?: string;
  markers: string[];
  hasClaude: boolean;
  priority: number;
}

interface ScanResult {
  projects: ScannedProject[];
  tools: Record<string, { path: string; [k: string]: unknown }>;
}

interface SelectionState {
  [path: string]: {
    enabled: boolean;
    id: string;
    name: string;
    color: string;
    createDefaultAgents: boolean;
  };
}

const COLORS = ['#7bcce0', '#a78bfa', '#fbbf24', '#f472b6', '#34d399', '#f87171', '#60a5fa', '#c084fc'];

function suggestId(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z0-9-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 32);
}

export default function SetupWizard() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState<'scan' | 'select' | 'done'>('scan');
  const [rootPath, setRootPath] = useState('');
  const [result, setResult] = useState<ScanResult | null>(null);
  const [selection, setSelection] = useState<SelectionState>({});
  const [applyErrors, setApplyErrors] = useState<{ id: string; error: string }[]>([]);

  const scanMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/terraform/scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('claw:auth-token') ?? ''}`
        },
        body: JSON.stringify({ roots: rootPath ? [rootPath] : [] })
      });
      if (!res.ok) throw new Error('스캔 실패');
      return res.json() as Promise<ScanResult>;
    },
    onSuccess: (data) => {
      setResult(data);
      // 기본 선택: CLAUDE.md 있는 것만 enabled
      const init: SelectionState = {};
      data.projects.forEach((p, i) => {
        init[p.path] = {
          enabled: p.hasClaude,
          id: suggestId(p.title ?? p.name),
          name: p.title ?? p.name,
          color: COLORS[i % COLORS.length],
          createDefaultAgents: p.hasClaude
        };
      });
      setSelection(init);
      setStep('select');
    }
  });

  const applyMutation = useMutation({
    mutationFn: async () => {
      const projects = Object.entries(selection)
        .filter(([, s]) => s.enabled)
        .map(([path, s]) => ({
          id: s.id,
          name: s.name,
          path,
          color: s.color,
          createDefaultAgents: s.createDefaultAgents
        }));
      const res = await fetch('/api/terraform/apply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('claw:auth-token') ?? ''}`
        },
        body: JSON.stringify({ projects })
      });
      if (!res.ok) throw new Error('적용 실패');
      return res.json() as Promise<{ created: string[]; createdAgents: string[]; errors: { id: string; error: string }[] }>;
    },
    onSuccess: (data) => {
      setApplyErrors(data.errors);
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['agents'] });
      setStep('done');
    }
  });

  const selectedCount = Object.values(selection).filter(s => s.enabled).length;

  if (step === 'scan') {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl mx-auto space-y-5">
          <div className="flex items-center gap-3">
            <Sparkles className="text-amber-400" />
            <h1 className="text-2xl font-semibold">🦞 Claw Web 테라포밍</h1>
          </div>
          <p className="text-sm text-zinc-400 leading-relaxed">
            기존 프로젝트와 Claude 환경을 자동으로 감지해서 Claw Web에 가져옵니다.
            <br />
            <code className="text-xs text-zinc-500">CLAUDE.md</code>, <code className="text-xs text-zinc-500">package.json</code>, <code className="text-xs text-zinc-500">.git</code> 등으로 프로젝트를 인식하고,
            디스코드 봇 / Claude Code 세션 / CARL 설정을 탐지합니다.
          </p>
          <div className="rounded-lg border border-zinc-700 bg-zinc-900/40 p-4 space-y-3">
            <label className="block">
              <span className="block text-xs uppercase text-zinc-500 mb-1">스캔 경로 (비워두면 기본: Projects/, Documents/, Code/, /Volumes/Core/Vault)</span>
              <input
                value={rootPath}
                onChange={(e) => setRootPath(e.target.value)}
                placeholder="/Volumes/Core/Vault"
                className="w-full bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm font-mono"
              />
            </label>
            <button
              onClick={() => scanMutation.mutate()}
              disabled={scanMutation.isPending}
              className="w-full rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white py-2 text-sm font-semibold flex items-center justify-center gap-2"
            >
              {scanMutation.isPending ? (
                <><Loader2 size={14} className="animate-spin" /> 스캔 중...</>
              ) : (
                <><Sparkles size={14} /> 시작</>
              )}
            </button>
            {scanMutation.error && (
              <div className="text-xs text-red-400">{(scanMutation.error as Error).message}</div>
            )}
          </div>
          <button
            onClick={() => navigate('/')}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            ← 건너뛰기 (나중에 Settings에서 실행 가능)
          </button>
        </div>
      </div>
    );
  }

  if (step === 'select' && result) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto space-y-5">
          <h2 className="text-xl font-semibold">발견된 항목</h2>

          {/* 기존 도구 */}
          {Object.keys(result.tools).length > 0 && (
            <div className="rounded-lg border border-sky-900/50 bg-sky-950/20 p-4 space-y-2">
              <div className="text-sm font-semibold text-sky-300">기존 Claude 환경 감지됨</div>
              <div className="space-y-1 text-xs text-zinc-400">
                {result.tools.discordBot != null && (
                  <div>🤖 Discord Bot: {String(result.tools.discordBot.agentCount)}개 에이전트 (자동 동기화됨)</div>
                )}
                {result.tools.carl != null && (
                  <div>📜 CARL: {String(result.tools.carl.domainCount)}개 도메인 규칙 (자동 주입됨)</div>
                )}
                {result.tools.claudeCode != null && (
                  <div>📁 Claude Code: {String(result.tools.claudeCode.projectCount)}개 세션</div>
                )}
                {result.tools.paul != null && <div>🔧 PAUL 설치됨</div>}
              </div>
            </div>
          )}

          {/* 프로젝트 목록 */}
          <div className="rounded-lg border border-zinc-700 bg-zinc-900/40 overflow-hidden">
            <div className="px-4 py-2 border-b border-zinc-700 flex items-center gap-2">
              <Folder size={14} className="text-zinc-500" />
              <span className="text-sm font-semibold">프로젝트 ({result.projects.length})</span>
              <span className="ml-auto text-xs text-zinc-500">{selectedCount}개 선택됨</span>
            </div>
            <div className="divide-y divide-zinc-800 max-h-[500px] overflow-y-auto">
              {result.projects.map((p) => {
                const sel = selection[p.path];
                if (!sel) return null;
                return (
                  <div key={p.path} className="p-3 flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={sel.enabled}
                      onChange={(e) => setSelection({ ...selection, [p.path]: { ...sel, enabled: e.target.checked } })}
                      className="mt-1"
                    />
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ background: sel.color }}
                        />
                        <input
                          value={sel.name}
                          onChange={(e) => setSelection({ ...selection, [p.path]: { ...sel, name: e.target.value } })}
                          disabled={!sel.enabled}
                          className="bg-transparent text-sm font-semibold outline-none focus:bg-zinc-950/60 rounded px-1 disabled:opacity-50"
                        />
                        <span className="text-[11px] text-zinc-600">·</span>
                        <input
                          value={sel.id}
                          onChange={(e) => setSelection({ ...selection, [p.path]: { ...sel, id: e.target.value } })}
                          disabled={!sel.enabled}
                          className="bg-transparent text-[11px] font-mono text-zinc-500 outline-none focus:bg-zinc-950/60 rounded px-1 disabled:opacity-50 w-28"
                        />
                        {p.hasClaude && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-300">CLAUDE.md</span>}
                      </div>
                      <div className="text-[11px] text-zinc-600 font-mono truncate">{p.path}</div>
                      {p.description && (
                        <div className="text-[11px] text-zinc-500 line-clamp-2">{p.description}</div>
                      )}
                      <div className="flex items-center gap-2 text-[11px]">
                        <label className="flex items-center gap-1 text-zinc-500">
                          <input
                            type="checkbox"
                            checked={sel.createDefaultAgents}
                            onChange={(e) => setSelection({ ...selection, [p.path]: { ...sel, createDefaultAgents: e.target.checked } })}
                            disabled={!sel.enabled}
                          />
                          기본 기획자 에이전트 자동 생성
                        </label>
                        <div className="flex gap-0.5 ml-auto">
                          {COLORS.map(c => (
                            <button
                              key={c}
                              disabled={!sel.enabled}
                              onClick={() => setSelection({ ...selection, [p.path]: { ...sel, color: c } })}
                              className={`w-4 h-4 rounded-full border-2 ${sel.color === c ? 'border-white' : 'border-transparent'} disabled:opacity-30`}
                              style={{ background: c }}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setStep('scan')}
              className="text-xs text-zinc-500 hover:text-zinc-300"
            >
              ← 뒤로
            </button>
            <button
              onClick={() => applyMutation.mutate()}
              disabled={selectedCount === 0 || applyMutation.isPending}
              className="ml-auto rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white px-5 py-2 text-sm font-semibold flex items-center gap-2"
            >
              {applyMutation.isPending ? (
                <><Loader2 size={14} className="animate-spin" /> 적용 중...</>
              ) : (
                <><Check size={14} /> {selectedCount}개 적용</>
              )}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto space-y-5">
        <div className="flex items-center gap-3">
          <Check className="text-emerald-400" size={28} />
          <h1 className="text-2xl font-semibold">완료!</h1>
        </div>
        {applyErrors.length > 0 && (
          <div className="rounded-lg border border-red-900/50 bg-red-950/20 p-4 space-y-2">
            <div className="text-sm font-semibold text-red-300">일부 항목에서 오류</div>
            {applyErrors.map((e, i) => (
              <div key={i} className="text-xs text-red-400">
                <X size={10} className="inline" /> <code>{e.id}</code>: {e.error}
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <button onClick={() => navigate('/projects')} className="flex-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white py-2 text-sm font-semibold">프로젝트 보기</button>
          <button onClick={() => navigate('/chat')} className="flex-1 rounded bg-sky-700 hover:bg-sky-600 text-white py-2 text-sm font-semibold">채팅 시작</button>
        </div>
      </div>
    </div>
  );
}
