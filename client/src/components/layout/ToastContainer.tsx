import { X, CheckCircle, AlertTriangle, XCircle, Info } from 'lucide-react';
import { useToastStore, type Toast } from '../../store/toast-store';

const ICON_MAP: Record<Toast['type'], { Icon: typeof CheckCircle; color: string; bg: string }> = {
  success: { Icon: CheckCircle, color: 'text-emerald-400', bg: 'border-emerald-800/60 bg-emerald-950/80' },
  error: { Icon: XCircle, color: 'text-red-400', bg: 'border-red-800/60 bg-red-950/80' },
  warning: { Icon: AlertTriangle, color: 'text-amber-400', bg: 'border-amber-800/60 bg-amber-950/80' },
  info: { Icon: Info, color: 'text-sky-400', bg: 'border-sky-800/60 bg-sky-950/80' },
};

export default function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => {
        const { Icon, color, bg } = ICON_MAP[t.type];
        return (
          <div
            key={t.id}
            className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 shadow-lg backdrop-blur-sm animate-toast-in ${bg}`}
          >
            <Icon size={16} className={`${color} shrink-0 mt-0.5`} />
            <span className="flex-1 text-sm text-zinc-200 break-words">{t.message}</span>
            <button
              onClick={() => dismiss(t.id)}
              className="shrink-0 text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
