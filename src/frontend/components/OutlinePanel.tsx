import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import { depthOf, hasKnownChildren } from '../lib/doc-utils.js';

interface OutlineTreeNode {
  id?: unknown;
  address?: unknown;
  text?: ReactNode;
  children?: OutlineTreeNode[];
  [extra: string]: unknown;
}

interface OutlineNodeProps {
  node: OutlineTreeNode;
  selectedNodeId?: unknown;
  collapsedOutlineNodeIds: Set<unknown>;
  onToggle: (id: unknown) => void;
  onSelect: (id: unknown) => void;
}

// 父节点驻留靠原生 position: sticky：每个节点一个 wrapper（行 + 子树），
// 展开的父行按深度阶梯钉在容器顶部，子树滚完由 wrapper 底边把行推走，
// 钉住、堆叠、推挤切换全部是浏览器行为，这里不维护任何滚动状态。
// 行高 32 = 28 行体 + 4px 行距（行距是行盒内的透明 border，不是 margin，
// 否则子树交接时槽位会露底闪烁）。深度上限防止驻留堆叠吃掉整个面板高度；
// 浅层行 z-index 更高，被推走的深层行从浅层行底下钻出去。
const OUTLINE_STICKY_ROW_HEIGHT = 32;
const OUTLINE_STICKY_MAX_DEPTH = 4;

function OutlineNode({
  node,
  selectedNodeId,
  collapsedOutlineNodeIds,
  onToggle,
  onSelect
}: OutlineNodeProps) {
  const hasChildren = hasKnownChildren(node as Parameters<typeof hasKnownChildren>[0]);
  const collapsedOutline = collapsedOutlineNodeIds.has(node.id);
  const depth = depthOf(String(node.address ?? ''));
  const sticky = hasChildren && !collapsedOutline && depth <= OUTLINE_STICKY_MAX_DEPTH;
  return (
    <div className="outline-node">
      <button
        type="button"
        className={`outline-item ${node.id === selectedNodeId ? 'active' : ''} ${hasChildren ? 'has-children' : ''} ${sticky ? 'is-outline-sticky' : ''}`}
        style={{
          paddingLeft: `${Math.min(depth - 1, 5) * 12 + 10}px`,
          // snap 吸附时行要停在上方驻留堆叠的底边，而不是容器顶
          scrollMarginTop: Math.min(depth - 1, OUTLINE_STICKY_MAX_DEPTH) * OUTLINE_STICKY_ROW_HEIGHT,
          ...(sticky ? { top: (depth - 1) * OUTLINE_STICKY_ROW_HEIGHT, zIndex: 15 - depth } : null)
        }}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('[data-outline-toggle]')) {
            event.preventDefault();
            onToggle(node.id);
            return;
          }
          onSelect(node.id);
        }}
      >
        <span className="outline-toggle" data-outline-toggle="true">
          {hasChildren ? (
            collapsedOutline ? <ChevronRight size={12} /> : <ChevronDown size={12} />
          ) : (
            <span className="outline-toggle-spacer" />
          )}
        </span>
        <code>{String(node.address ?? '')}</code>
        <span>{(node.text as ReactNode) || '空节点'}</span>
      </button>
      {!collapsedOutline && (node.children || []).map((child: OutlineTreeNode) => (
        <OutlineNode
          key={String(child.id ?? '')}
          node={child}
          selectedNodeId={selectedNodeId}
          collapsedOutlineNodeIds={collapsedOutlineNodeIds}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

export function OutlinePanel({
  tree,
  selectedNodeId,
  collapsedOutlineNodeIds,
  onToggle,
  onSelect
}: {
  tree?: OutlineTreeNode | null;
  selectedNodeId?: unknown;
  collapsedOutlineNodeIds?: Set<unknown>;
  onToggle?: (id: unknown) => void;
  onSelect?: (id: unknown) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  // 滚轮一格滚一行，且始终停在行格上：行格对齐后驻留底边永远贴着下一行
  // 的顶边，不出现被切一半的行。React 的 onWheel 是 passive 的，拦不住
  // 默认滚动，这里手动挂 non-passive 监听。
  useEffect(() => {
    const element = listRef.current;
    if (!element) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const direction = Math.sign(event.deltaY);
      if (!direction) return;
      const steps = Math.max(1, Math.round(Math.abs(event.deltaY) / 100));
      const currentRow = Math.round(element.scrollTop / OUTLINE_STICKY_ROW_HEIGHT);
      element.scrollTop = (currentRow + direction * steps) * OUTLINE_STICKY_ROW_HEIGHT;
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <section className="panel outline-panel">
      <header className="panel-header">目录</header>
      <div className="outline-list" ref={listRef}>
        {tree && onToggle && onSelect && (
          <OutlineNode
            node={tree}
            selectedNodeId={selectedNodeId}
            collapsedOutlineNodeIds={collapsedOutlineNodeIds ?? new Set()}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        )}
      </div>
    </section>
  );
}
