import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight, MapPin, Plus } from 'lucide-react';
import { api } from '../lib/api';
import type { CalendarEvent } from '../lib/types';
import EventModal from '../components/calendar/EventModal';
import {
  addDays,
  addMonths,
  dateKey,
  formatEventWhen,
  formatTime,
  monthGrid,
  parseEventDate,
  startOfMonth
} from '../lib/calendar-date';

const DEFAULT_COLOR = '#60a5fa';
const UPCOMING_DAYS = 14;
const WEEK_HEADS = ['월', '화', '수', '목', '금', '토', '일'];

/** 이벤트를 걸쳐 있는 모든 날짜 칸에 배치한다 (다중일 일정 대응). */
function bucketByDay(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const byDay = new Map<string, CalendarEvent[]>();
  const push = (key: string, ev: CalendarEvent) => {
    const list = byDay.get(key);
    if (list) list.push(ev);
    else byDay.set(key, [ev]);
  };
  for (const ev of events) {
    const start = parseEventDate(ev.start);
    const end = ev.end ? parseEventDate(ev.end) : start;
    // 최대 366일까지만 펼친다 — 잘못된 end 로 무한 루프 도는 것 방지
    let cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    for (let i = 0; i <= 366 && cursor <= last; i += 1) {
      push(dateKey(cursor), ev);
      cursor = addDays(cursor, 1);
    }
  }
  return byDay;
}

export default function CalendarPage() {
  const [month, setMonth] = useState<Date>(() => startOfMonth(new Date()));
  const [modal, setModal] = useState<{ event: CalendarEvent | null; date: string } | null>(null);

  const days = useMemo(() => monthGrid(month), [month]);
  const from = dateKey(days[0]);
  const to = dateKey(days[days.length - 1]);
  const todayKey = dateKey(new Date());

  const { data: events } = useQuery({
    queryKey: ['calendar', from, to],
    queryFn: () => api.calendar(from, to)
  });
  const { data: upcoming } = useQuery({
    queryKey: ['calendar-upcoming', UPCOMING_DAYS],
    queryFn: () => api.calendarUpcoming(UPCOMING_DAYS)
  });

  const byDay = useMemo(() => bucketByDay(events ?? []), [events]);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-semibold">
            {month.getFullYear()}년 {month.getMonth() + 1}월
          </h2>
          <div className="flex items-center gap-1">
            <NavButton onClick={() => setMonth(addMonths(month, -1))} label="이전 달">
              <ChevronLeft size={16} />
            </NavButton>
            <NavButton onClick={() => setMonth(addMonths(month, 1))} label="다음 달">
              <ChevronRight size={16} />
            </NavButton>
            <button
              onClick={() => setMonth(startOfMonth(new Date()))}
              className="px-3 py-1.5 rounded border border-zinc-800 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              오늘
            </button>
          </div>
        </div>
        <button
          onClick={() => setModal({ event: null, date: todayKey })}
          className="flex items-center gap-1.5 px-3 py-2 rounded bg-sky-600 hover:bg-sky-500 text-sm"
        >
          <Plus size={15} />
          일정 추가
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-5">
        <div className="rounded-lg border border-zinc-800 overflow-hidden">
          <div className="grid grid-cols-7 border-b border-zinc-800 bg-zinc-900/60">
            {WEEK_HEADS.map((w) => (
              <div
                key={w}
                className={`py-2 text-center text-xs ${w === '일' ? 'text-red-400' : w === '토' ? 'text-sky-400' : 'text-zinc-500'}`}
              >
                {w}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {days.map((day) => {
              const key = dateKey(day);
              return (
                <DayCell
                  key={key}
                  day={day}
                  inMonth={day.getMonth() === month.getMonth()}
                  isToday={key === todayKey}
                  events={byDay.get(key) ?? []}
                  onAdd={() => setModal({ event: null, date: key })}
                  onOpen={(ev) => setModal({ event: ev, date: key })}
                />
              );
            })}
          </div>
        </div>

        <div className="rounded-lg border border-zinc-800 p-4">
          <div className="flex items-center gap-2 mb-3">
            <CalendarDays size={15} className="text-zinc-500" />
            <h3 className="text-sm font-medium">다가오는 일정</h3>
            <span className="text-xs text-zinc-600">{UPCOMING_DAYS}일</span>
          </div>
          {upcoming && upcoming.length > 0 ? (
            <ul className="space-y-1.5">
              {upcoming.map((ev) => (
                <li key={ev.id}>
                  <button
                    onClick={() => setModal({ event: ev, date: dateKey(parseEventDate(ev.start)) })}
                    className="w-full text-left rounded-md border border-zinc-800 hover:bg-zinc-800/60 px-3 py-2 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ backgroundColor: ev.color ?? DEFAULT_COLOR }}
                      />
                      <span className="text-sm truncate">{ev.title}</span>
                      {ev.source === 'agent' && <AgentBadge />}
                    </div>
                    <div className="mt-0.5 pl-3.5 text-xs text-zinc-500 flex items-center gap-2">
                      <span>{formatEventWhen(ev.start, ev.allDay)}</span>
                      {ev.location && (
                        <span className="flex items-center gap-0.5 truncate">
                          <MapPin size={11} />
                          {ev.location}
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-zinc-600">예정된 일정 없음</p>
          )}
        </div>
      </div>

      {modal && (
        <EventModal event={modal.event} defaultDate={modal.date} onClose={() => setModal(null)} />
      )}
    </div>
  );
}

function NavButton({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className="p-1.5 rounded border border-zinc-800 text-zinc-400 hover:bg-zinc-800"
    >
      {children}
    </button>
  );
}

function AgentBadge() {
  return (
    <span
      title="에이전트가 등록한 일정"
      className="shrink-0 rounded bg-violet-950/60 border border-violet-800/60 px-1 text-[10px] text-violet-300 leading-4"
    >
      에이전트
    </span>
  );
}

interface DayCellProps {
  day: Date;
  inMonth: boolean;
  isToday: boolean;
  events: CalendarEvent[];
  onAdd: () => void;
  onOpen: (ev: CalendarEvent) => void;
}

/** 칸 하나 — 빈 영역 클릭은 추가, 일정 클릭은 수정. */
function DayCell({ day, inMonth, isToday, events, onAdd, onOpen }: DayCellProps) {
  const weekday = day.getDay();
  const dateColor = !inMonth
    ? 'text-zinc-700'
    : weekday === 0
      ? 'text-red-400'
      : weekday === 6
        ? 'text-sky-400'
        : 'text-zinc-300';

  return (
    <div
      onClick={onAdd}
      className={`min-h-[104px] border-b border-r border-zinc-800 p-1.5 cursor-pointer transition-colors hover:bg-zinc-800/30 ${
        inMonth ? '' : 'bg-zinc-950/40'
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <span
          className={`text-xs w-5 h-5 flex items-center justify-center rounded-full ${
            isToday ? 'bg-sky-600 text-white' : dateColor
          }`}
        >
          {day.getDate()}
        </span>
      </div>
      <div className="space-y-0.5">
        {events.slice(0, 3).map((ev) => (
          <button
            key={ev.id}
            onClick={(e) => {
              e.stopPropagation();
              onOpen(ev);
            }}
            title={ev.title}
            className="w-full flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-left hover:brightness-125"
            style={{
              backgroundColor: `${ev.color ?? DEFAULT_COLOR}22`,
              borderLeft: `2px solid ${ev.color ?? DEFAULT_COLOR}`
            }}
          >
            {!ev.allDay && <span className="text-zinc-500 shrink-0">{formatTime(ev.start)}</span>}
            <span className="truncate">{ev.title}</span>
            {ev.source === 'agent' && <span className="shrink-0 text-violet-400">•</span>}
          </button>
        ))}
        {events.length > 3 && (
          <div className="px-1 text-[10px] text-zinc-500">+{events.length - 3}</div>
        )}
      </div>
    </div>
  );
}
