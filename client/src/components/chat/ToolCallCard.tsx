import { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench, Download, Image, ExternalLink, Maximize2 } from 'lucide-react';
import { getAuthToken } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { editorUrl, useEditorConfig, openFileDiff } from '../../lib/editor';
import type { ToolCall } from '../../store/chat-store';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
function isImagePath(p: string): boolean {
  const ext = p.slice(p.lastIndexOf('.')).toLowerCase();
  return IMAGE_EXTS.has(ext);
}
function fileUrl(absPath: string, download = false): string {
  const token = getAuthToken();
  const base = `/api/fs/file?path=${encodeURIComponent(absPath)}`;
  const dl = download ? '&download=true' : '';
  const auth = token ? `&_token=${encodeURIComponent(token)}` : '';
  return `${base}${dl}${auth}`;
}

const TOOL_ICONS: Record<string, string> = {
  Read: '📄',
  Write: '✏️',
  Edit: '✏️',
  Bash: '💻',
  Grep: '🔎',
  Glob: '📁',
  WebFetch: '🌐',
  WebSearch: '🔍',
  TodoWrite: '✅',
  Task: '🎯',
  NotebookEdit: '📓'
};

function summarize(tool: ToolCall): string {
  const input = tool.input as Record<string, unknown>;
  if (tool.name === 'Read' || tool.name === 'Write' || tool.name === 'Edit') {
    // 파일명만 표시 (경로 축약)
    const fp = (input.file_path as string) ?? '';
    const last = fp.split('/').pop() ?? fp;
    return last;
  }
  if (tool.name === 'Bash') {
    const cmd = (input.command as string) ?? '';
    // 명령어 첫 단어 + 짧은 요약
    return cmd.split('\n')[0].slice(0, 60);
  }
  if (tool.name === 'Grep') return (input.pattern as string)?.slice(0, 40) ?? '';
  if (tool.name === 'Glob') return (input.pattern as string)?.slice(0, 40) ?? '';
  if (tool.name === 'WebFetch' || tool.name === 'WebSearch') {
    const u = (input.url || input.query) as string ?? '';
    // 도메인만 추출
    try { return new URL(u).hostname; } catch { return u.slice(0, 40); }
  }
  if (tool.name === 'TodoWrite') {
    const todos = (input.todos as { content?: string }[] | undefined) ?? [];
    const inProgress = todos.filter(t => (t as { status?: string }).status === 'in_progress').length;
    const done = todos.filter(t => (t as { status?: string }).status === 'completed').length;
    return `${done}/${todos.length} ${inProgress > 0 ? `(진행 중 ${inProgress})` : ''}`;
  }
  if (tool.name === 'Task') return (input.description as string)?.slice(0, 40) ?? (input.subagent_type as string) ?? '';
  return '';
}

function formatTs(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('ko-KR', { hour12: false });
  } catch {
    return '';
  }
}

/** Trigger button to open the aggregated file-diff modal (global event). */
function DiffButton({ filePath }: { filePath: string }) {
  if (!filePath) return null;
  return (
    <button
      onClick={() => openFileDiff(filePath)}
      className="shrink-0 text-sky-400 hover:text-sky-300 flex items-center gap-1 text-[11px]"
      title="파일 단위 누적 diff 보기"
    >
      <Maximize2 size={11} /> diff
    </button>
  );
}

/** Open-in-Editor link (vscode:// or cursor://). Renders nothing if disabled. */
function OpenInEditor({ filePath, line }: { filePath: string; line?: number }) {
  const cfg = useEditorConfig();
  const url = editorUrl(filePath, cfg, line);
  if (!url) return null;
  const label = cfg.scheme === 'cursor' ? 'Cursor' : 'VS Code';
  return (
    <a
      href={url}
      className="shrink-0 text-sky-400 hover:text-sky-300 flex items-center gap-1 text-[11px]"
      title={`Open in ${label}`}
    >
      <ExternalLink size={11} /> {label}
    </a>
  );
}

/** Inline image/file preview from the fs/file endpoint. */
function FilePreview({ filePath }: { filePath: string }) {
  const t = useT();
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState(false);
  const isImg = isImagePath(filePath);

  if (!isImg) {
    return (
      <a
        href={fileUrl(filePath, true)}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sky-400 hover:text-sky-300 flex items-center gap-1 text-[11px]"
      >
        <Download size={11} /> {filePath.split('/').pop()}
      </a>
    );
  }

  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/50 p-1 inline-block">
      {!err ? (
        <img
          src={fileUrl(filePath)}
          alt={filePath.split('/').pop() ?? ''}
          onLoad={() => setLoaded(true)}
          onError={() => setErr(true)}
          className={`max-w-full max-h-64 rounded ${loaded ? '' : 'opacity-0 h-0'}`}
        />
      ) : (
        <div className="text-[11px] text-zinc-500 italic p-2 flex items-center gap-1">
          <Image size={12} /> {t('common.imageLoadFail')}
        </div>
      )}
      {!loaded && !err && (
        <div className="text-[11px] text-zinc-500 p-2">{t('common.loading')}</div>
      )}
      <div className="mt-1 flex items-center gap-2">
        <a
          href={fileUrl(filePath, true)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sky-400 hover:text-sky-300 flex items-center gap-1 text-[11px]"
        >
          <Download size={11} /> {t('tools.download')}
        </a>
        <span className="text-[11px] text-zinc-600 truncate">{filePath.split('/').pop()}</span>
      </div>
    </div>
  );
}

export default function ToolCallCard({ tool, index }: { tool: ToolCall; index?: number }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const icon = TOOL_ICONS[tool.name] ?? '🔧';
  const summary = summarize(tool);
  const ts = formatTs(tool.ts);
  const isEdit = tool.name === 'Edit';
  const isWrite = tool.name === 'Write';
  const isRead = tool.name === 'Read';
  const filePath = (tool.input as Record<string, unknown>)?.file_path as string | undefined;

  const showInlineDiff = (isEdit || isWrite) && !!filePath;

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/60 text-xs">
      <div className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-zinc-800/50">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
        >
          {open ? (
            <ChevronDown size={11} className="text-zinc-500 shrink-0" />
          ) : (
            <ChevronRight size={11} className="text-zinc-500 shrink-0" />
          )}
          {typeof index === 'number' && (
            <span className="text-[11px] text-zinc-600 font-mono min-w-[16px]">#{index}</span>
          )}
          <span className="shrink-0">{icon}</span>
          <Wrench size={11} className="text-zinc-500 shrink-0" />
          <span className="font-semibold text-zinc-300 shrink-0">{tool.name}</span>
          {summary && (
            <span
              className="text-zinc-500 font-mono truncate flex-1 text-left"
              title={summary}
            >
              {summary}
            </span>
          )}
        </button>
        {showInlineDiff && <DiffButton filePath={filePath!} />}
        {ts && <span className="text-[11px] text-zinc-600 font-mono shrink-0">{ts}</span>}
      </div>
      {open && (
        <div className="px-3 pb-2 text-[11px] font-mono overflow-x-auto">
          {isEdit ? (
            <EditDiff
              filePath={filePath ?? ''}
              oldStr={(tool.input as Record<string, unknown>).old_string as string}
              newStr={(tool.input as Record<string, unknown>).new_string as string}
            />
          ) : isWrite ? (
            <WriteDiff
              filePath={filePath ?? ''}
              content={(tool.input as Record<string, unknown>).content as string}
            />
          ) : isRead && filePath && isImagePath(filePath) ? (
            <div className="space-y-1">
              <div className="text-zinc-500 truncate flex items-center gap-2">
                <span className="truncate">📄 {filePath} ({t('tools.read')})</span>
                <OpenInEditor filePath={filePath} />
              </div>
              <FilePreview filePath={filePath} />
            </div>
          ) : isRead && filePath ? (
            <div className="space-y-1">
              <div className="text-zinc-500 truncate flex items-center gap-2">
                <span className="truncate">📄 {filePath} ({t('tools.read')})</span>
                <OpenInEditor filePath={filePath} />
              </div>
              <pre className="text-zinc-400 whitespace-pre-wrap break-all">
                {JSON.stringify(tool.input, null, 2)}
              </pre>
            </div>
          ) : (
            <pre className="text-zinc-400 whitespace-pre-wrap break-all">
              {JSON.stringify(tool.input, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function EditDiff({
  filePath,
  oldStr,
  newStr
}: {
  filePath: string;
  oldStr: string;
  newStr: string;
}) {
  const t = useT();
  if (!oldStr && !newStr) return <span className="text-zinc-500">{t('tools.emptyEdit')}</span>;

  return (
    <div className="space-y-1.5">
      <div className="text-zinc-500 truncate flex items-center gap-2">
        <span className="truncate">📄 {filePath}</span>
        <DiffButton filePath={filePath} />
        <OpenInEditor filePath={filePath} />
      </div>
      {oldStr && (
        <div className="rounded bg-red-950/30 border border-red-900/30 p-2">
          <div className="text-[11px] text-red-400 mb-1 uppercase tracking-wider">{t('tools.removed')}</div>
          <pre className="text-red-300 whitespace-pre-wrap break-all">{oldStr}</pre>
        </div>
      )}
      {newStr && (
        <div className="rounded bg-emerald-950/30 border border-emerald-900/30 p-2">
          <div className="text-[11px] text-emerald-400 mb-1 uppercase tracking-wider">{t('tools.added')}</div>
          <pre className="text-emerald-300 whitespace-pre-wrap break-all">{newStr}</pre>
        </div>
      )}
    </div>
  );
}

function WriteDiff({ filePath, content }: { filePath: string; content: string }) {
  const t = useT();
  const isImg = isImagePath(filePath);
  return (
    <div className="space-y-1.5">
      <div className="text-zinc-500 truncate flex items-center gap-2">
        <span className="truncate">📄 {filePath} ({t('tools.writeFull')})</span>
        <DiffButton filePath={filePath} />
        <OpenInEditor filePath={filePath} />
        <a
          href={fileUrl(filePath, true)}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-sky-400 hover:text-sky-300 flex items-center gap-1"
          title={t('tools.download')}
        >
          <Download size={11} /> {t('tools.download')}
        </a>
      </div>
      {isImg ? (
        <FilePreview filePath={filePath} />
      ) : (
        <div className="rounded bg-emerald-950/30 border border-emerald-900/30 p-2 max-h-48 overflow-y-auto">
          <pre className="text-emerald-300 whitespace-pre-wrap break-all">
            {(content ?? '').slice(0, 2000)}
            {(content ?? '').length > 2000 && `\n\n... (${content.length.toLocaleString()} chars)`}
          </pre>
        </div>
      )}
    </div>
  );
}
