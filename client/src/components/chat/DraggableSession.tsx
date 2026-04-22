import { ReactNode } from 'react';
import { useDraggable } from '@dnd-kit/core';

interface Props {
  sessionId: string;
  agentId: string;
  children: ReactNode;
  className?: string;
}

/**
 * 세션 리스트 아이템을 감싸는 드래그 소스.
 * ChatPane 의 droppable (`pane:<wsId>:<paneId>`) 로 드롭하면
 * 해당 pane 에 세션이 장착됩니다.
 *
 * 시각적 드래그 프리뷰는 상위 `<DragOverlay>` 가 담당한다.
 * 여기서는 소스 위치에 transform 을 적용하지 않고,
 * 드래그 중임을 나타내는 dim(opacity) 만 준다.
 */
export default function DraggableSession({ sessionId, agentId, children, className }: Props) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `session:${sessionId}`,
    data: { kind: 'session', sessionId, agentId }
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={className}
      style={{
        opacity: isDragging ? 0.4 : undefined,
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        cursor: isDragging ? 'grabbing' : undefined
      }}
    >
      {children}
    </div>
  );
}

export const sessionDragId = (id: string) => `session:${id}`;
