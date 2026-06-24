// @ts-nocheck
import { RESIZE_RAIL_DRAG_THRESHOLD } from './doc-utils.js';

export function startResizeRailGesture(event, {
  collapsed = false,
  onExpand,
  bodyClasses = [],
  onDrag,
  onClick
}) {
  event.preventDefault();
  if (collapsed) {
    onExpand?.();
    return;
  }

  const startX = event.clientX;
  const startY = event.clientY;
  let dragged = false;
  if (bodyClasses.length) document.body.classList.add(...bodyClasses);

  const move = (moveEvent) => {
    const distance = Math.max(Math.abs(moveEvent.clientX - startX), Math.abs(moveEvent.clientY - startY));
    if (distance > RESIZE_RAIL_DRAG_THRESHOLD) dragged = true;
    if (!dragged) return;
    onDrag?.(moveEvent, { startX, startY });
  };

  const stop = () => {
    if (bodyClasses.length) document.body.classList.remove(...bodyClasses);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
    if (!dragged) onClick?.();
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
}
