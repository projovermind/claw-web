export function SectionLabel({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-zinc-500">
      {icon}
      <span>{label}</span>
    </div>
  );
}
