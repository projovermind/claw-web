import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { EditorConfig, WebSettings } from './types';

export const DEFAULT_EDITOR: EditorConfig = { scheme: 'vscode', pathMap: {} };

/** React hook — returns current editor config (defaults + server override). */
export function useEditorConfig(): EditorConfig {
  const { data } = useQuery({
    queryKey: ['settings-editor'],
    queryFn: api.getSettings,
    refetchOnWindowFocus: false,
    staleTime: 60_000
  });
  const raw = (data as WebSettings | undefined)?.editor;
  return { ...DEFAULT_EDITOR, ...(raw ?? {}) };
}

/** Apply `pathMap` prefix remap (server path → local path). Longest-prefix wins. */
export function remapPath(absPath: string, pathMap: Record<string, string> | undefined): string {
  if (!pathMap) return absPath;
  const prefixes = Object.keys(pathMap).sort((a, b) => b.length - a.length);
  for (const from of prefixes) {
    if (absPath.startsWith(from)) {
      return pathMap[from] + absPath.slice(from.length);
    }
  }
  return absPath;
}

/**
 * Build the editor URL for the configured scheme.
 * Returns null when scheme is 'off' or path is empty.
 *
 * vscode://file/{path}:{line}:{col}
 * cursor://file/{path}:{line}:{col}
 */
export function editorUrl(
  absPath: string,
  config: EditorConfig,
  line?: number,
  col?: number
): string | null {
  if (!absPath || config.scheme === 'off') return null;
  const local = remapPath(absPath, config.pathMap);
  // macOS/Linux absolute paths begin with '/'; vscode:// URLs want an extra leading slash.
  // On Windows (c:\foo) the scheme expects the raw drive letter.
  const pathPart = local.startsWith('/') ? local : `/${local.replace(/\\/g, '/')}`;
  let url = `${config.scheme}://file${pathPart}`;
  if (typeof line === 'number' && line > 0) {
    url += `:${line}`;
    if (typeof col === 'number' && col > 0) url += `:${col}`;
  }
  return url;
}

/** Whitelisted extensions auto-linked in assistant markdown text. */
const LINKIFY_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'cc', 'cpp', 'h', 'hpp',
  'cs', 'php', 'lua', 'sh', 'bash', 'zsh',
  'json', 'yaml', 'yml', 'toml', 'ini', 'env',
  'md', 'mdx', 'txt',
  'html', 'css', 'scss', 'sass',
  'sql', 'vue', 'svelte'
]);

/**
 * Replace `/abs/path.ext[:line[:col]]` in markdown text with clickable
 * `[path:line](editor-url)` links. Skips fenced code blocks and inline code.
 * Returns original text if scheme is 'off'.
 */
export function linkifyFilePaths(body: string, config: EditorConfig): string {
  if (config.scheme === 'off' || !body) return body;
  // Split on fenced code blocks first — preserve them unchanged.
  const parts = body.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part) => {
      if (part.startsWith('```')) return part;
      // Also skip inline `...` — split on single backtick spans.
      const inline = part.split(/(`[^`\n]+`)/g);
      return inline
        .map((seg) => (seg.startsWith('`') ? seg : linkifySegment(seg, config)))
        .join('');
    })
    .join('');
}

function linkifySegment(seg: string, config: EditorConfig): string {
  // Absolute path: starts at word-boundary with '/', at least one '/', then .ext
  // Followed by optional :line or :line:col
  const re = /(^|[\s(\[`])(\/(?:[\w.\-]+\/)+[\w.\-]+\.([a-zA-Z0-9]{1,6}))(?::(\d+))?(?::(\d+))?/g;
  return seg.replace(re, (match, pre, path, ext, lineStr, colStr) => {
    if (!LINKIFY_EXTS.has(ext.toLowerCase())) return match;
    const line = lineStr ? parseInt(lineStr, 10) : undefined;
    const col = colStr ? parseInt(colStr, 10) : undefined;
    const url = editorUrl(path, config, line, col);
    if (!url) return match;
    const label = lineStr ? `${path}:${lineStr}${colStr ? `:${colStr}` : ''}` : path;
    return `${pre}[${label}](${url})`;
  });
}

/**
 * Global event-based trigger for the file-diff modal.
 * Any component can call openFileDiff(path) and the single <FileDiffHost/>
 * mounted at App root renders the modal.
 */
export const FILE_DIFF_EVENT = 'claw:open-file-diff';

export function openFileDiff(filePath: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(FILE_DIFF_EVENT, { detail: { filePath } }));
}

/** Extract the absolute file path from an editor-scheme URL (vscode:// or cursor://). */
export function pathFromEditorUrl(url: string): string | null {
  const m = url.match(/^(?:vscode|cursor):\/\/file(\/[^:]+)(?::\d+(?::\d+)?)?$/);
  return m ? m[1] : null;
}
