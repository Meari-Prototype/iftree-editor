import { useCallback, useMemo, useRef, useState } from 'react';

import { clampVerticalSplitSize } from '../../core/sidebar-split.mjs';
import {
  clamp,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_LEFT_WIDTH,
  MAX_RIGHT_WIDTH,
  MIN_DOC_PANEL_HEIGHT,
  MIN_LEFT_WIDTH,
  MIN_OUTLINE_PANEL_HEIGHT,
  MIN_RIGHT_WIDTH,
  PANEL_SPLIT_RAIL_SIZE
} from '../lib/doc-utils.mjs';
import { startResizeRailGesture } from '../lib/mindmap-utils.mjs';

const RAIL_ANIMATION_MS = 220;

export function useLayout() {
  const [leftWidth, setLeftWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [rightWidth, setRightWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [docPanelHeight, setDocPanelHeight] = useState(null);
  const [outlineCollapsedDown, setOutlineCollapsedDown] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [leftRailAnimate, setLeftRailAnimate] = useState(false);
  const [rightRailAnimate, setRightRailAnimate] = useState(false);

  const leftSidebarRef = useRef(null);
  const docPanelRef = useRef(null);
  const docPanelHeightBeforeCollapseRef = useRef(null);

  const toggleLeft = useCallback(() => {
    setLeftRailAnimate(true);
    setLeftCollapsed((value) => !value);
    setTimeout(() => setLeftRailAnimate(false), RAIL_ANIMATION_MS);
  }, []);

  const toggleRight = useCallback(() => {
    setRightRailAnimate(true);
    setRightCollapsed((value) => !value);
    setTimeout(() => setRightRailAnimate(false), RAIL_ANIMATION_MS);
  }, []);

  const toggleOutlineCollapseDown = useCallback(() => {
    const sidebar = leftSidebarRef.current;
    const docPanel = docPanelRef.current;
    if (!sidebar || !docPanel) return;
    if (outlineCollapsedDown) {
      setDocPanelHeight(docPanelHeightBeforeCollapseRef.current);
      setOutlineCollapsedDown(false);
      return;
    }

    const sidebarRect = sidebar.getBoundingClientRect();
    const docRect = docPanel.getBoundingClientRect();
    const docTop = docRect.top - sidebarRect.top;
    const availableSize = sidebarRect.height - docTop - PANEL_SPLIT_RAIL_SIZE;
    docPanelHeightBeforeCollapseRef.current = docPanelHeight;
    setDocPanelHeight(Math.max(MIN_DOC_PANEL_HEIGHT, availableSize));
    setOutlineCollapsedDown(true);
  }, [docPanelHeight, outlineCollapsedDown]);

  const startSidebarResize = useCallback((side, event) => {
    const isLeft = side === 'left';
    const isCollapsed = isLeft ? leftCollapsed : rightCollapsed;
    const toggleSidebar = isLeft ? toggleLeft : toggleRight;
    const startWidth = isLeft ? leftWidth : rightWidth;
    const resizeClass = isLeft ? 'is-resizing-left-sidebar' : 'is-resizing-right-sidebar';

    startResizeRailGesture(event, {
      collapsed: isCollapsed,
      onExpand: toggleSidebar,
      bodyClasses: ['is-resizing-horizontal', resizeClass],
      onDrag: (moveEvent, { startX }) => {
        const delta = moveEvent.clientX - startX;
        if (isLeft) {
          setLeftCollapsed(false);
          setLeftWidth(clamp(startWidth + delta, MIN_LEFT_WIDTH, MAX_LEFT_WIDTH));
        } else {
          setRightCollapsed(false);
          setRightWidth(clamp(startWidth - delta, MIN_RIGHT_WIDTH, MAX_RIGHT_WIDTH));
        }
      },
      onClick: toggleSidebar
    });
  }, [leftCollapsed, leftWidth, rightCollapsed, rightWidth, toggleLeft, toggleRight]);

  const startDocOutlineResize = useCallback((event) => {
    const sidebar = leftSidebarRef.current;
    const docPanel = docPanelRef.current;
    if (!sidebar || !docPanel) return;

    const sidebarRect = sidebar.getBoundingClientRect();
    const docRect = docPanel.getBoundingClientRect();
    const docTop = docRect.top - sidebarRect.top;
    const availableSize = sidebarRect.height - docTop - PANEL_SPLIT_RAIL_SIZE;
    const startSize = docRect.height;

    startResizeRailGesture(event, {
      collapsed: outlineCollapsedDown,
      onExpand: toggleOutlineCollapseDown,
      bodyClasses: ['is-resizing-vertical', 'is-resizing-left-split'],
      onDrag: (moveEvent, { startY }) => {
        setOutlineCollapsedDown(false);
        setDocPanelHeight(clampVerticalSplitSize({
          startSize,
          startY,
          currentY: moveEvent.clientY,
          availableSize,
          minTop: MIN_DOC_PANEL_HEIGHT,
          minBottom: MIN_OUTLINE_PANEL_HEIGHT
        }));
      },
      onClick: toggleOutlineCollapseDown
    });
  }, [outlineCollapsedDown, toggleOutlineCollapseDown]);

  return useMemo(() => ({
    leftWidth,
    rightWidth,
    leftCollapsed,
    rightCollapsed,
    leftRailAnimate,
    rightRailAnimate,
    docPanelHeight,
    outlineCollapsedDown,
    leftSidebarRef,
    docPanelRef,
    startSidebarResize,
    startDocOutlineResize,
    toggleLeft,
    toggleRight,
    toggleOutlineCollapseDown
  }), [
    docPanelHeight,
    leftCollapsed,
    leftRailAnimate,
    leftWidth,
    outlineCollapsedDown,
    rightCollapsed,
    rightRailAnimate,
    rightWidth,
    startDocOutlineResize,
    startSidebarResize,
    toggleLeft,
    toggleOutlineCollapseDown,
    toggleRight
  ]);
}
