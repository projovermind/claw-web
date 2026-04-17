import { useState } from 'react';
import { Plus, Trash2, ExternalLink, FileText, Key, Edit3 } from 'lucide-react';
import type { CustomWidget } from '../../lib/types';
import { useT } from '../../lib/i18n';

function getWidgetTypes(t: (key: string) => string): { type: CustomWidget['type']; label: string; icon: typeof ExternalLink; placeholder: string }[] {
  return [
    { type: 'link', label: t('projects.widgetLink'), icon: ExternalLink, placeholder: 'https://...' },
    { type: 'text', label: t('projects.widgetText'), icon: FileText, placeholder: t('projects.widgetTextPlaceholder') },
    { type: 'kv', label: t('projects.widgetKV'), icon: Key, placeholder: t('projects.widgetKVPlaceholder') },
    { type: 'markdown', label: t('projects.widgetMd'), icon: Edit3, placeholder: t('projects.widgetMdPlaceholder') },
  ];
}

function WidgetCard({ widget, onRemove }: { widget: CustomWidget; onRemove: () => void }) {
  const t = useT();
  const WIDGET_TYPES = getWidgetTypes(t);
  const typeMeta = WIDGET_TYPES.find(x => x.type === widget.type) ?? WIDGET_TYPES[1];
  const Icon = typeMeta.icon;

  return (
    <div className="group rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Icon size={11} className="text-zinc-500 shrink-0" />
        <span className="text-[11px] font-semibold text-zinc-400 flex-1 truncate">{widget.title}</span>
        <button
          onClick={onRemove}
          className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-red-400 text-zinc-600"
        >
          <Trash2 size={10} />
        </button>
      </div>
      {widget.type === 'link' ? (
        <a href={widget.value} target="_blank" rel="noopener noreferrer"
          className="text-xs text-sky-400 hover:text-sky-300 truncate block font-mono">
          {widget.value}
        </a>
      ) : widget.type === 'kv' ? (
        <div className="text-[11px] font-mono space-y-0.5">
          {widget.value.split('\n').filter(Boolean).map((line, i) => {
            const [k, ...rest] = line.split('=');
            return (
              <div key={i} className="flex gap-1">
                <span className="text-zinc-500">{k}</span>
                <span className="text-zinc-400">{rest.join('=')}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-xs text-zinc-400 whitespace-pre-wrap">{widget.value}</div>
      )}
    </div>
  );
}

export function CustomWidgets({
  widgets,
  onUpdate
}: {
  widgets: CustomWidget[];
  onUpdate: (widgets: CustomWidget[]) => void;
}) {
  const t = useT();
  const WIDGET_TYPES = getWidgetTypes(t);
  const [adding, setAdding] = useState(false);
  const [draftType, setDraftType] = useState<CustomWidget['type']>('link');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftValue, setDraftValue] = useState('');

  const addWidget = () => {
    if (!draftTitle.trim() || !draftValue.trim()) return;
    const w: CustomWidget = {
      id: `w_${Date.now().toString(36)}`,
      type: draftType,
      title: draftTitle.trim(),
      value: draftValue.trim()
    };
    onUpdate([...widgets, w]);
    setDraftTitle('');
    setDraftValue('');
    setAdding(false);
  };

  const removeWidget = (id: string) => {
    onUpdate(widgets.filter(w => w.id !== id));
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-800">
        <span className="text-sm">📌</span>
        <span className="text-sm font-semibold text-zinc-300 flex-1">{t('projects.customWidgets')}</span>
        <button
          onClick={() => setAdding(v => !v)}
          className="text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 flex items-center gap-1"
        >
          <Plus size={10} /> {t('common.add')}
        </button>
      </div>

      {adding && (
        <div className="p-3 border-b border-zinc-800 space-y-2 bg-zinc-950/40">
          <div className="flex gap-2">
            <select
              value={draftType}
              onChange={(e) => setDraftType(e.target.value as CustomWidget['type'])}
              className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-[11px]"
            >
              {WIDGET_TYPES.map(t => (
                <option key={t.type} value={t.type}>{t.label}</option>
              ))}
            </select>
            <input
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              placeholder={t('projects.widgetTitle')}
              className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-[11px] outline-none"
            />
          </div>
          <textarea
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            placeholder={WIDGET_TYPES.find(x => x.type === draftType)?.placeholder}
            className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-[11px] min-h-[60px] resize-y outline-none font-mono"
          />
          <div className="flex justify-end gap-1">
            <button onClick={() => setAdding(false)} className="px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-300">{t('common.cancel')}</button>
            <button
              onClick={addWidget}
              disabled={!draftTitle.trim() || !draftValue.trim()}
              className="px-3 py-1 text-[11px] rounded bg-emerald-900/40 hover:bg-emerald-900/60 text-emerald-200 disabled:opacity-30"
            >{t('common.add')}</button>
          </div>
        </div>
      )}

      <div className="p-3">
        {widgets.length === 0 && !adding ? (
          <div className="text-[11px] text-zinc-600 italic text-center py-4">
            {t('projects.widgetsEmpty')}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {widgets.map(w => (
              <WidgetCard key={w.id} widget={w} onRemove={() => removeWidget(w.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
