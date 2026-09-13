import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Trash2, Loader2 } from 'lucide-react';
import { api } from '../../lib/api';
import type { CalendarEvent, CalendarEventInput } from '../../lib/types';
import { dateKey, isDateOnly, localInputToIso, parseEventDate, toLocalInput } from '../../lib/calendar-date';

/** 색상 팔레트 — 다크 테마에서 읽히는 채도만 골랐다. null = 기본색. */
const COLORS = ['#60a5fa', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#f472b6', '#22d3ee'];

interface FormState {
  title: string;
  allDay: boolean;
  /** allDay 면 'YYYY-MM-DD', 아니면 'YYYY-MM-DDTHH:mm'. */
  start: string;
  end: string;
  location: string;
  notes: string;
  color: string | null;
  projectId: string;
}

/** 이벤트의 start/end 를 폼이 쓰는 입력 포맷으로 변환. */
function toFormValue(value: string | null, allDay: boolean): string {
  if (!value) return '';
  const d = parseEventDate(value);
  return allDay ? dateKey(d) : toLocalInput(d);
}

function initialForm(event: CalendarEvent | null, defaultDate: string): FormState {
  if (!event) {
    return {
      title: '',
      allDay: false,
      start: `${defaultDate}T09:00`,
      end: '',
      location: '',
      notes: '',
      color: null,
      projectId: ''
    };
  }
  return {
    title: event.title,
    allDay: event.allDay,
    start: toFormValue(event.start, event.allDay),
    end: toFormValue(event.end, event.allDay),
    location: event.location ?? '',
    notes: event.notes ?? '',
    color: event.color,
    projectId: event.projectId ?? ''
  };
}

/** 폼 입력값 → API 가 기대하는 start/end 문자열. */
const toApiDate = (value: string, allDay: boolean) =>
  allDay ? value : localInputToIso(value);

/** 종일 토글 시 이미 입력된 값의 포맷을 바꿔준다. */
function convertForAllDay(value: string, allDay: boolean): string {
  if (!value) return '';
  if (allDay) return value.slice(0, 10);
  return isDateOnly(value) ? `${value}T09:00` : value;
}

interface Props {
  /** null 이면 생성 모드. */
  event: CalendarEvent | null;
  /** 생성 모드에서 클릭한 날짜 'YYYY-MM-DD'. */
  defaultDate: string;
  onClose: () => void;
}

export default function EventModal({ event, defaultDate, onClose }: Props) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(() => initialForm(event, defaultDate));
  const [error, setError] = useState<string | null>(null);
  const { data: projects } = useQuery({ queryKey: ['projects'], queryFn: api.projects });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['calendar'] });
    queryClient.invalidateQueries({ queryKey: ['calendar-upcoming'] });
  };
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : '요청에 실패했습니다');

  const save = useMutation({
    mutationFn: (body: CalendarEventInput) =>
      event ? api.patchCalendarEvent(event.id, body) : api.createCalendarEvent(body),
    onSuccess: () => {
      invalidate();
      onClose();
    },
    onError: fail
  });

  const remove = useMutation({
    mutationFn: () => api.deleteCalendarEvent(event!.id),
    onSuccess: () => {
      invalidate();
      onClose();
    },
    onError: fail
  });

  const busy = save.isPending || remove.isPending;
  const valid = form.title.trim().length > 0 && form.start.length > 0;

  const submit = () => {
    if (!valid || busy) return;
    setError(null);
    save.mutate({
      title: form.title.trim(),
      start: toApiDate(form.start, form.allDay),
      end: form.end ? toApiDate(form.end, form.allDay) : null,
      allDay: form.allDay,
      location: form.location.trim(),
      notes: form.notes.trim(),
      color: form.color,
      projectId: form.projectId || null,
      ...(event ? {} : { source: 'user' as const })
    });
  };

  const setAllDay = (allDay: boolean) =>
    setForm((f) => ({
      ...f,
      allDay,
      start: convertForAllDay(f.start, allDay),
      end: convertForAllDay(f.end, allDay)
    }));

  const dateType = form.allDay ? 'date' : 'datetime-local';
  const inputCls = 'w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm';

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-zinc-900 border border-zinc-800 rounded-lg w-full max-w-lg max-h-[90vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
          <h3 className="text-lg font-semibold">{event ? '일정 수정' : '일정 추가'}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-400">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <Field label="제목">
            <input
              autoFocus
              value={form.title}
              maxLength={200}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="무슨 일정인가요?"
              className={inputCls}
            />
          </Field>

          <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
            <input
              type="checkbox"
              checked={form.allDay}
              onChange={(e) => setAllDay(e.target.checked)}
              className="accent-sky-500"
            />
            종일
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="시작">
              <input
                type={dateType}
                value={form.start}
                onChange={(e) => setForm({ ...form, start: e.target.value })}
                className={inputCls}
              />
            </Field>
            <Field label="종료 (선택)">
              <input
                type={dateType}
                value={form.end}
                onChange={(e) => setForm({ ...form, end: e.target.value })}
                className={inputCls}
              />
            </Field>
          </div>

          <Field label="장소 (선택)">
            <input
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
              className={inputCls}
            />
          </Field>

          <Field label="메모 (선택)">
            <textarea
              rows={3}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              className={`${inputCls} resize-y`}
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="색상">
              <div className="flex items-center gap-2 flex-wrap pt-1">
                <button
                  onClick={() => setForm({ ...form, color: null })}
                  title="기본색"
                  className={`w-6 h-6 rounded-full border-2 bg-zinc-700 ${form.color === null ? 'border-white' : 'border-transparent'}`}
                />
                {COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setForm({ ...form, color: c })}
                    style={{ backgroundColor: c }}
                    className={`w-6 h-6 rounded-full border-2 ${form.color === c ? 'border-white' : 'border-transparent'}`}
                  />
                ))}
              </div>
            </Field>
            <Field label="프로젝트 (선택)">
              <select
                value={form.projectId}
                onChange={(e) => setForm({ ...form, projectId: e.target.value })}
                className={inputCls}
              >
                <option value="">—</option>
                {(projects ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>

        <div className="flex items-center justify-between px-5 py-3 border-t border-zinc-800">
          <div>
            {event && (
              <button
                disabled={busy}
                onClick={() => {
                  if (confirm(`'${event.title}' 일정을 삭제할까요?`)) remove.mutate();
                }}
                className="flex items-center gap-1.5 px-3 py-2 rounded text-sm text-red-400 hover:bg-red-950/40 disabled:opacity-50"
              >
                <Trash2 size={15} />
                삭제
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-2 rounded text-sm text-zinc-400 hover:bg-zinc-800">
              취소
            </button>
            <button
              disabled={!valid || busy}
              onClick={submit}
              className="flex items-center gap-1.5 px-4 py-2 rounded text-sm bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:hover:bg-sky-600"
            >
              {busy && <Loader2 size={15} className="animate-spin" />}
              {event ? '저장' : '추가'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-zinc-500 mb-1">{label}</label>
      {children}
    </div>
  );
}
