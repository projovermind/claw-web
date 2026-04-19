import { useState } from 'react';
import { Brain, Edit3, Check, AlertCircle } from 'lucide-react';

const MEMORY_PLACEHOLDER = `## 핵심 경로
- 서버 진입점:
- 클라이언트:
- 설정 파일:

## 배포
- 빌드:
- 실행:
- 재시작 필요 조건:

## 환경 변수 / 포트
-

## 최근 작업 (최대 10건)
- [날짜] 에이전트: 작업 내용

## 주의사항
- `;

// ~500토큰 기준 (한글 기준 약 1500자)
const TOKEN_WARN_CHARS = 1500;

export function ProjectMemory({
  memory,
  onSave
}: {
  memory: string;
  onSave: (memory: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(memory);

  const save = () => {
    onSave(draft);
    setEditing(false);
  };

  const isOverLimit = draft.length > TOKEN_WARN_CHARS;

  return (
    <div className="rounded-lg border border-zinc-700/60 bg-zinc-900/40 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-800">
        <Brain size={14} className="text-violet-400" />
        <span className="text-sm font-semibold text-zinc-300 flex-1">프로젝트 메모리</span>
        <span className="text-[10px] text-zinc-600 mr-2">에이전트가 세션 시작 시 읽음</span>
        <button
          onClick={() => {
            if (editing) save();
            else { setDraft(memory); setEditing(true); }
          }}
          className="text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 flex items-center gap-1"
        >
          {editing ? <><Check size={10} /> 저장</> : <><Edit3 size={10} /> 편집</>}
        </button>
      </div>

      {editing ? (
        <div className="relative">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); }}
            placeholder={MEMORY_PLACEHOLDER}
            className="w-full bg-transparent text-sm text-zinc-300 p-4 min-h-[200px] resize-y outline-none placeholder-zinc-700 font-mono"
            autoFocus
          />
          <div className={`flex items-center gap-1 px-4 pb-2 text-[11px] ${isOverLimit ? 'text-amber-400' : 'text-zinc-600'}`}>
            {isOverLimit && <AlertCircle size={11} />}
            {draft.length}자 {isOverLimit ? `— ${TOKEN_WARN_CHARS}자 이하 권장 (토큰 절약)` : `/ ${TOKEN_WARN_CHARS}자 권장`}
          </div>
        </div>
      ) : (
        <div className="p-4 text-sm text-zinc-400 whitespace-pre-wrap min-h-[60px] font-mono">
          {memory || <span className="italic text-zinc-600 font-sans">비어있음 — 편집 버튼으로 경로, 배포 방식, 작업 내역 등을 기록하세요</span>}
        </div>
      )}
    </div>
  );
}
