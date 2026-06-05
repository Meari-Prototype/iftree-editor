import { ChevronDown, ChevronRight } from 'lucide-react';

import { OUTLINE_ROW_HEIGHT, depthOf, hasKnownChildren } from '../lib/doc-utils.mjs';

function OutlineNodeButton({
  node,
  selectedNodeId,
  collapsedOutlineNodeIds,
  onToggle,
  onSelect,
  sticky = false,
  itemKey = null
}) {
  const hasChildren = hasKnownChildren(node);
  const collapsedOutline = collapsedOutlineNodeIds.has(node.id);
  const depth = depthOf(node.address);
  return (
    <button
      key={itemKey || node.id}
      type="button"
      className={`outline-item ${node.id === selectedNodeId ? 'active' : ''} ${hasChildren ? 'has-children' : ''} ${sticky ? 'is-outline-sticky' : ''}`}
      style={{
        paddingLeft: `${Math.min(depth - 1, 5) * 12 + 10}px`,
        ...(sticky
          ? {
              '--outline-sticky-top': `${Math.max(0, depth - 1) * OUTLINE_ROW_HEIGHT}px`,
              '--outline-sticky-z': 10 + depth
            }
          : {})
      }}
      onClick={(event) => {
        if (event.target.closest('[data-outline-toggle]')) {
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
      <code>{node.address}</code>
      <span>{node.text || '空节点'}</span>
    </button>
  );
}

export function OutlinePanel({
  scrollRef,
  onScroll,
  stickyRows,
  topSpacer,
  renderedRows,
  bottomSpacer,
  selectedNodeId,
  collapsedOutlineNodeIds,
  onToggle,
  onSelect
}) {
  return (
    <section className="panel outline-panel">
      <header className="panel-header">目录</header>
      <div className="outline-list outline-list-virtual" ref={scrollRef} onScroll={onScroll}>
        {stickyRows.map((node) => (
          <OutlineNodeButton
            key={`sticky:${node.id}`}
            itemKey={`sticky:${node.id}`}
            node={node}
            selectedNodeId={selectedNodeId}
            collapsedOutlineNodeIds={collapsedOutlineNodeIds}
            onToggle={onToggle}
            onSelect={onSelect}
            sticky
          />
        ))}
        {topSpacer > 0 && <div className="outline-spacer" style={{ height: topSpacer }} />}
        {renderedRows.map((node) => (
          <OutlineNodeButton
            key={node.id}
            node={node}
            selectedNodeId={selectedNodeId}
            collapsedOutlineNodeIds={collapsedOutlineNodeIds}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        ))}
        {bottomSpacer > 0 && <div className="outline-spacer" style={{ height: bottomSpacer }} />}
      </div>
    </section>
  );
}
