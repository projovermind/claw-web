import { Sparkles, Shield, Wrench, Leaf, LayoutList } from 'lucide-react';
import { useT } from '../../lib/i18n';

function getActions(t: (key: string) => string) {
  return [
    {
      id: 'seed',
      icon: Leaf,
      label: 'SEED',
      desc: t('framework.seedDesc'),
      color: 'text-emerald-400',
      message: 'Start a SEED ideation session. Guide me through type-aware project ideation. Ask me what type of project I want to build (Application, Workflow, Client, Utility, or Campaign) and walk through the structured planning process to create a PLANNING.md.'
    },
    {
      id: 'paul',
      icon: LayoutList,
      label: 'PAUL',
      desc: t('framework.paulDesc'),
      color: 'text-sky-400',
      message: 'Initialize a PAUL development loop for this project. Check if .paul/ exists — if not, run /paul init. Then show the current project state (phase, loop position, milestones) and ask what to work on next.'
    },
    {
      id: 'aegis',
      icon: Shield,
      label: 'AEGIS',
      desc: t('framework.aegisDesc'),
      color: 'text-amber-400',
      message: 'Run an AEGIS security audit on this codebase. Start with Phase 0 (context gathering), then proceed through the 6 diagnostic phases. Focus on security vulnerabilities, architecture risks, and code quality. Provide findings with severity ratings.'
    },
    {
      id: 'skillsmith',
      icon: Wrench,
      label: 'Skill',
      desc: t('framework.skillDesc'),
      color: 'text-violet-400',
      message: 'Start a Skillsmith discovery session. Guide me through building a new Claude Code skill. Ask about the workflow I want to automate, then scaffold a compliant skill directory.'
    },
  ];
}

export function FrameworkActions({
  onSend,
  disabled
}: {
  onSend: (message: string) => void;
  disabled: boolean;
}) {
  const t = useT();
  const ACTIONS = getActions(t);
  return (
    <div className="flex items-center gap-1 px-2 py-1 border-b border-zinc-800/50 overflow-x-auto">
      <Sparkles size={10} className="text-zinc-600 shrink-0" />
      {ACTIONS.map(a => (
        <button
          key={a.id}
          disabled={disabled}
          onClick={() => onSend(a.message)}
          title={a.desc}
          className={`shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-zinc-900/60 hover:bg-zinc-800 border border-zinc-800/50 hover:border-zinc-700 disabled:opacity-30 transition-colors ${a.color}`}
        >
          <a.icon size={10} />
          <span className="text-zinc-400">{a.label}</span>
        </button>
      ))}
    </div>
  );
}
