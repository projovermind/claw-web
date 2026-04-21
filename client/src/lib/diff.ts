import { diffLines } from 'diff';
import type { ChatMessage } from './types';

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx';
  text: string;
}

/** Split a multi-line string into DiffLine segments (pair of before/after). */
export function computeLineDiff(before: string, after: string): DiffLine[] {
  const parts = diffLines(before ?? '', after ?? '');
  const out: DiffLine[] = [];
  for (const p of parts) {
    const raw = p.value.replace(/\n$/, '');
    const lines = raw.length === 0 ? [''] : raw.split('\n');
    const kind: DiffLine['kind'] = p.added ? 'add' : p.removed ? 'del' : 'ctx';
    for (const l of lines) out.push({ kind, text: l });
  }
  return out;
}

export interface FileEditEvent {
  /** Index within the messages array (for stable keys) */
  msgIndex: number;
  /** 'edit' = string-replace diff, 'write' = full overwrite (before is empty/unknown) */
  kind: 'edit' | 'write';
  oldStr: string;
  newStr: string;
  ts?: string;
  tool: 'Edit' | 'Write';
}

/** Collect all Edit/Write events targeting a given file path, in message order. */
export function collectFileEdits(messages: ChatMessage[], filePath: string): FileEditEvent[] {
  if (!filePath) return [];
  const out: FileEditEvent[] = [];
  messages.forEach((m, msgIndex) => {
    const tcs = (m.toolCalls ?? []) as { name: string; input: Record<string, unknown>; ts?: string }[];
    for (const tc of tcs) {
      const fp = tc.input?.file_path as string | undefined;
      if (fp !== filePath) continue;
      if (tc.name === 'Edit') {
        out.push({
          msgIndex,
          kind: 'edit',
          oldStr: (tc.input.old_string as string) ?? '',
          newStr: (tc.input.new_string as string) ?? '',
          ts: tc.ts,
          tool: 'Edit'
        });
      } else if (tc.name === 'Write') {
        out.push({
          msgIndex,
          kind: 'write',
          oldStr: '',
          newStr: (tc.input.content as string) ?? '',
          ts: tc.ts,
          tool: 'Write'
        });
      }
    }
  });
  return out;
}
