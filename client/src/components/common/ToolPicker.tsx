import { useState } from 'react';
import { X } from 'lucide-react';
import { useT } from '../../lib/i18n';

/** Claude CLI stock tools. Custom entries (e.g. `Bash(git *:*)` patterns)
 *  go through the custom input row. */
export const KNOWN_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'NotebookEdit',
  'Agent'
];

/**
 * Reusable tool picker. Used by both AgentsPage (per-agent allow/deny) and
 * ProjectsPage (project-level defaults that cascade to all agents in the
 * project).
 */
export default function ToolPicker({
  selected,
  onChange,
  inherited = []
}: {
  selected: string[];
  onChange: (tools: string[]) => void;
  /** Optional: tools already inherited from the project level. Shown as
   *  read-only badges so the user knows they're already in effect. */
  inherited?: string[];
}) {
  const [custom, setCustom] = useState('');
  const t = useT();
  const toggle = (name: string) =>
    onChange(selected.includes(name) ? selected.filter((t) => t !== name) : [...selected, name]);
  const addCustom = () => {
    const v = custom.trim();
    if (!v || selected.includes(v)) return;
    onChange([...selected, v]);
    setCustom('');
  };
  const customOnly = selected.filter((t) => !KNOWN_TOOLS.includes(t));
  const inheritedOnly = inherited.filter((t) => !selected.includes(t));

  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/40 p-2 space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {KNOWN_TOOLS.map((tool) => {
          const checked = selected.includes(tool);
          const isInherited = inherited.includes(tool);
          return (
            <button
              key={tool}
              type="button"
              onClick={() => toggle(tool)}
              className={`text-xs px-2 py-1 rounded border transition-colors ${
                checked
                  ? 'bg-emerald-900/40 border-emerald-700/50 text-emerald-100'
                  : isInherited
                    ? 'bg-zinc-900 border-zinc-700 text-zinc-500'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
              }`}
              title={isInherited ? t('toolPicker.inheritedTitle') : undefined}
            >
              {tool}
              {isInherited && !checked && <span className="ml-1 text-[11px] text-zinc-600">↑</span>}
            </button>
          );
        })}
      </div>
      {customOnly.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {customOnly.map((tool) => (
            <button
              key={tool}
              type="button"
              onClick={() => toggle(tool)}
              className="text-xs px-2 py-1 rounded border bg-sky-900/30 border-sky-700/50 text-sky-100 flex items-center gap-1"
              title={t('toolPicker.customRemove')}
            >
              {tool}
              <X size={10} />
            </button>
          ))}
        </div>
      )}
      {inheritedOnly.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {inheritedOnly.map((tool) => (
            <span
              key={tool}
              className="text-xs px-2 py-1 rounded border bg-zinc-900 border-zinc-700 text-zinc-500 flex items-center gap-1"
              title={t('toolPicker.inheritedNoRemove')}
            >
              ↑ {tool}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addCustom();
            }
          }}
          placeholder={t('toolPicker.customPlaceholder')}
          className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs font-mono"
        />
        <button
          type="button"
          onClick={addCustom}
          disabled={!custom.trim()}
          className="text-xs rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 px-2 py-1"
        >
          {t('toolPicker.add')}
        </button>
      </div>
    </div>
  );
}
