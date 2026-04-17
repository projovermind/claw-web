import { useEffect, useMemo, useRef } from 'react';
import { useCommands, type SlashCommand } from '../../lib/commands';

/**
 * Popover that appears when the user types `/` at the start of the
 * ChatInput textarea. Shows a filtered list of slash commands.
 *
 * The popover is controlled: the parent decides when to show it (based on
 * whether the input starts with `/`), and the parent handles the final
 * insertion.
 */
export default function SlashPopover({
  query,
  cursor,
  onSelect,
  onCursorChange,
  onClose: _onClose
}: {
  /** The text after `/`, e.g. if input is "/com" then query = "com". */
  query: string;
  /** Currently highlighted index. */
  cursor: number;
  /** Called when user picks a command (Enter or click). */
  onSelect: (command: SlashCommand) => void;
  /** Called when arrow keys change cursor. */
  onCursorChange: (idx: number) => void;
  /** Called when user presses Escape or the popover should close. */
  onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const q = query.toLowerCase().trim();
  const commands = useCommands();

  const filtered = useMemo(
    () =>
      q
        ? commands.filter(
            (c) => c.name.includes(q) || c.desc.toLowerCase().includes(q)
          )
        : commands,
    [q, commands]
  );

  // Keep cursor in range
  useEffect(() => {
    if (cursor >= filtered.length) onCursorChange(Math.max(0, filtered.length - 1));
  }, [filtered.length, cursor, onCursorChange]);

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.children[cursor] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (filtered.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="absolute left-0 bottom-full mb-1 w-80 max-h-60 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl z-20"
    >
      {filtered.map((c, i) => (
        <button
          key={c.name}
          onMouseDown={(e) => {
            e.preventDefault(); // don't blur textarea
            onSelect(c);
          }}
          onMouseEnter={() => onCursorChange(i)}
          className={`w-full text-left px-3 py-2 flex items-center gap-2.5 text-sm ${
            i === cursor ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
          }`}
        >
          <span className="text-base shrink-0">{c.icon}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono font-semibold text-emerald-300">/{c.name}</span>
            </div>
            <div className="text-[11px] text-zinc-500 truncate">{c.desc}</div>
          </div>
        </button>
      ))}
    </div>
  );
}
