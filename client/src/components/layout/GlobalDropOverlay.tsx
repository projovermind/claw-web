import { Upload } from 'lucide-react';
import { useUploadsStore } from '../../store/uploads-store';

export default function GlobalDropOverlay() {
  const dragActive = useUploadsStore((s) => s.dragActive);

  if (!dragActive) return null;

  return (
    <div className="fixed inset-0 z-[100] pointer-events-none">
      {/* Dashed border around viewport */}
      <div className="absolute inset-4 rounded-xl border-4 border-dashed border-emerald-400/80 shadow-[0_0_40px_rgba(52,211,153,0.3)]" />
      {/* Center badge */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="bg-zinc-900/95 border border-emerald-400/50 rounded-2xl px-8 py-6 flex flex-col items-center gap-2 shadow-2xl">
          <Upload size={36} className="text-emerald-400 animate-bounce" />
          <div className="text-lg font-semibold text-white">파일 드롭해서 업로드</div>
          <div className="text-[11px] text-zinc-400">최대 20 MB · 여러 개 가능</div>
        </div>
      </div>
    </div>
  );
}
