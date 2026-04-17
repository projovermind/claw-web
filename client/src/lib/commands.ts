/**
 * Built-in slash commands. Typing `/` at the start of the message input
 * triggers a filtered dropdown of these commands.
 *
 * desc / template 은 i18n 처리되어 있어 `useCommands()` hook 을 통해서만
 * 사용합니다. 외부에서 정적으로 import 하지 마세요.
 */
import { useMemo } from 'react';
import { useT } from './i18n';

export interface SlashCommand {
  name: string;
  icon: string;
  desc: string;
  /** The text that replaces the input. `$INPUT` is replaced with whatever
   *  the user typed after the command name. */
  template: string;
  /** If true, this is a system command (UI action) handled by ChatInput
   *  directly instead of being sent as a message. */
  system?: boolean;
}

// static spec — 아이콘 / name / system flag 만 정적.
// desc / template 은 useCommands 에서 i18n lookup.
const SPEC: { name: string; icon: string; system?: boolean }[] = [
  { name: 'commit',   icon: '📝' },
  { name: 'review',   icon: '🔍' },
  { name: 'test',     icon: '🧪' },
  { name: 'plan',     icon: '📋' },
  { name: 'explain',  icon: '💡' },
  { name: 'fix',      icon: '🔧' },
  { name: 'refactor', icon: '♻️' },
  { name: 'docs',     icon: '📖' },
  { name: 'build',    icon: '🏗️' },
  { name: 'status',   icon: '📊' },
  { name: 'loop',     icon: '🔄' },
  { name: 'run',      icon: '⚙️' },
  { name: 'clear',    icon: '🗑️', system: true },
  { name: 'new',      icon: '➕', system: true },
  { name: 'rename',   icon: '✏️', system: true },
  { name: 'export',   icon: '💾', system: true },
  { name: 'pin',      icon: '📌', system: true },
  { name: 'search',   icon: '🔍', system: true },
  { name: 'help',     icon: '❓', system: true },
  { name: 'compact',  icon: '📦', system: true }
];

/**
 * React hook — 현재 언어에 맞춰 slash command 목록 반환.
 * useMemo 로 lang 바뀔 때만 재생성.
 */
export function useCommands(): SlashCommand[] {
  const t = useT();
  return useMemo(
    () =>
      SPEC.map((s) => ({
        name: s.name,
        icon: s.icon,
        desc: t(`cmd.${s.name}.desc`),
        template: s.system ? '' : t(`cmd.${s.name}.tpl`),
        system: s.system
      })),
    [t]
  );
}

/**
 * Expand a command template with the user's input text.
 */
export function expandCommand(command: SlashCommand, userInput: string): string {
  return command.template.replace('$INPUT', userInput.trim());
}
