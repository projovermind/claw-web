import { ReactNode, useEffect, useState } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import type { PaneCount } from '../../store/chat-store';

interface Props {
  workspaceId: string;
  count: PaneCount;
  /** 레이아웃 리셋 시 증가 — autoSaveId 변경으로 persist 된 크기 초기화. */
  resetKey?: number;
  /** 활성 페인 인덱스 — 모바일(<lg)에서 분할 대신 이 페인만 표시. */
  activeIndex?: number;
  /** `renderPane(index)` returns the ChatPane element for pane at `index`. */
  renderPane: (index: number) => ReactNode;
}

/**
 * Tailwind `lg` (1024px) 미만이면 모바일/태블릿 협폭으로 간주.
 * 분할 레이아웃은 가로폭이 충분할 때만 의미가 있으므로 좁은 화면에서는
 * 활성 페인 하나만 풀스크린으로 보여줌 (저장된 count 는 그대로 유지 — 화면이 넓어지면 복귀).
 */
function useIsNarrow(): boolean {
  const query = '(max-width: 1023.98px)';
  const get = () => typeof window !== 'undefined' && window.matchMedia(query).matches;
  const [narrow, setNarrow] = useState<boolean>(get);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);
  return narrow;
}

/**
 * Pane 배치 규칙:
 *  1: single
 *  2: 1×2 horizontal
 *  3: 1×3 horizontal
 *  4: 2×2 (2 rows × 2 cols)
 *  5: 3 top + 2 bottom (nested)
 *  6: 2×3 (2 rows × 3 cols)
 *
 *  모든 divider 드래그 리사이즈 가능 — 사이즈는 autoSaveId 로 자동 저장.
 */
export default function WorkspaceGrid({ workspaceId, count, resetKey = 0, activeIndex = 0, renderPane }: Props) {
  const narrow = useIsNarrow();
  if (count === 1 || narrow) {
    const idx = narrow ? Math.max(0, Math.min(activeIndex, count - 1)) : 0;
    return <div className="h-full w-full">{renderPane(idx)}</div>;
  }

  const saveKey = `claw-split-${workspaceId}-${count}-${resetKey}`;

  // 1-row horizontal layouts (2, 3)
  if (count === 2 || count === 3) {
    const sizes = count === 2 ? [50, 50] : [34, 33, 33];
    return (
      <PanelGroup direction="horizontal" autoSaveId={saveKey} className="h-full w-full">
        {Array.from({ length: count }, (_, i) => (
          <FragmentPanel key={i} index={i} last={i === count - 1} defaultSize={sizes[i]}>
            {renderPane(i)}
          </FragmentPanel>
        ))}
      </PanelGroup>
    );
  }

  // 2-row nested layouts
  const rows: [number, number] =
    count === 4 ? [2, 2] :
    count === 5 ? [3, 2] :
    /* 6 */      [3, 3];
  const [topCount, botCount] = rows;

  return (
    <PanelGroup direction="vertical" autoSaveId={saveKey} className="h-full w-full">
      <Panel defaultSize={50} minSize={15}>
        <PanelGroup direction="horizontal" autoSaveId={`${saveKey}-top`} className="h-full w-full">
          {Array.from({ length: topCount }, (_, i) => (
            <FragmentPanel key={i} index={i} last={i === topCount - 1}>
              {renderPane(i)}
            </FragmentPanel>
          ))}
        </PanelGroup>
      </Panel>
      <PanelResizeHandle className="h-1 bg-transparent hover:bg-sky-500/40 transition-colors" />
      <Panel defaultSize={50} minSize={15}>
        <PanelGroup direction="horizontal" autoSaveId={`${saveKey}-bot`} className="h-full w-full">
          {Array.from({ length: botCount }, (_, i) => (
            <FragmentPanel key={i} index={i} last={i === botCount - 1}>
              {renderPane(topCount + i)}
            </FragmentPanel>
          ))}
        </PanelGroup>
      </Panel>
    </PanelGroup>
  );
}

function FragmentPanel({
  last,
  defaultSize,
  children
}: {
  index: number;
  last: boolean;
  defaultSize?: number;
  children: ReactNode;
}) {
  return (
    <>
      <Panel defaultSize={defaultSize} minSize={10}>
        <div className="h-full w-full">{children}</div>
      </Panel>
      {!last && (
        <PanelResizeHandle className="w-1 bg-transparent hover:bg-sky-500/40 transition-colors" />
      )}
    </>
  );
}
