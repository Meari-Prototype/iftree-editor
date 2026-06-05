import { X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { nodeTypeLabel } from '../lib/doc-utils.mjs';

const FIELD_LABELS = {
  text: '正文',
  node_title: '标题',
  node_note: '备注',
  node_type: '类型',
  trust_level: '信任',
  source_position: '来源位置',
  parent_id: '父节点',
  sort_order: '顺序'
};

function ownerLabel(owner) {
  return String(owner || 'human') === 'llm' ? 'LLM' : 'human';
}

function statusLabel(status) {
  if (status === 'added') return '新增';
  if (status === 'deleted') return '删除';
  if (status === 'modified') return '修改';
  return '未改';
}

function nodeTitle(node) {
  return String(node?.nodeTitle || node?.title || '').trim();
}

function nodeText(node) {
  return String(node?.text || '').trim();
}

function nodeNote(node) {
  return String(node?.nodeNote || node?.note || '').trim();
}

function expandedRows(rows, expandedKeys) {
  const result = [];
  for (const row of rows || []) {
    result.push(row);
    if (row.kind === 'collapsed' && expandedKeys.has(row.key)) {
      for (const hidden of row.hiddenRows || []) {
        result.push({ ...hidden, key: `${row.key}:${hidden.key}` });
      }
    }
  }
  return result;
}

function DiffNodeCard({ node, side, row }) {
  const emptyText = side === 'left' ? '右侧新增' : '左侧删除';
  if (!node) {
    return (
      <div className={`diff-node-card empty ${side}`}>
        <span>{emptyText}</span>
      </div>
    );
  }
  const title = nodeTitle(node);
  const text = nodeText(node);
  const note = nodeNote(node);
  return (
    <article className={`diff-node-card ${side} ${row.status}`}>
      <header>
        <code>{node.address || row.address}</code>
        <span>{nodeTypeLabel(node.nodeType || node.node_type || 'TEXT')}</span>
        <em>{statusLabel(row.status)}</em>
      </header>
      {title ? <strong>{title}</strong> : null}
      <p>{text || '空节点'}</p>
      {note ? <p className="diff-node-note">{note}</p> : null}
      {row.status === 'modified' && row.changedFields?.length ? (
        <footer>
          {row.changedFields.map((field) => (
            <span key={field}>{FIELD_LABELS[field] || field}</span>
          ))}
        </footer>
      ) : null}
    </article>
  );
}

function DiffRow({ row, expanded, onToggle }) {
  if (row.kind === 'collapsed') {
    return (
      <div className="edit-branch-diff-row collapsed" style={{ '--diff-depth': row.depth || 1 }}>
        <button type="button" onClick={() => onToggle(row.key)}>
          {expanded ? '收起' : '展开'} {row.hiddenCount || 0} 个未修改节点
        </button>
      </div>
    );
  }
  return (
    <div
      className={`edit-branch-diff-row ${row.status || 'unchanged'}`}
      style={{ '--diff-depth': row.depth || 1 }}
      data-address={row.address}
    >
      <DiffNodeCard node={row.left} side="left" row={row} />
      <DiffNodeCard node={row.right} side="right" row={row} />
    </div>
  );
}

export function EditBranchDiffDialog({ view, loading = false, error = '', onClose }) {
  const [expandedKeys, setExpandedKeys] = useState(() => new Set());
  const rows = useMemo(() => expandedRows(view?.rows || [], expandedKeys), [view?.rows, expandedKeys]);

  useEffect(() => {
    setExpandedKeys(new Set());
  }, [view?.branch?.id]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  function toggleCollapsed(key) {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const stats = view?.stats || {};
  const owner = ownerLabel(view?.branch?.owner);

  return (
    <div className="dialog-overlay edit-branch-diff-overlay" onMouseDown={() => onClose?.()}>
      <section
        className="dialog-box edit-branch-diff-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="编辑分支对比"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="edit-branch-diff-header">
          <div>
            <strong>编辑分支对比</strong>
            <span>{owner} · {stats.activeEntryCount || 0} 条 active diff</span>
          </div>
          <button type="button" className="diff-dialog-close" aria-label="关闭" onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        {loading ? (
          <div className="edit-branch-diff-state">载入对比...</div>
        ) : error ? (
          <div className="edit-branch-diff-state error">{error}</div>
        ) : (
          <>
            <div className="edit-branch-diff-stats" aria-label="变更统计">
              <span>新增 {stats.added || 0}</span>
              <span>删除 {stats.deleted || 0}</span>
              <span>修改 {stats.modified || 0}</span>
              <span>折叠 {stats.unchangedCollapsed || 0}</span>
            </div>
            <div className="edit-branch-diff-column-head">
              <div>
                <strong>Base</strong>
                <span>{view?.baseDoc?.title || 'base doc'}</span>
              </div>
              <div>
                <strong>Shadow Projection</strong>
                <span>{view?.projectedDoc?.title || view?.baseDoc?.title || 'projected doc'}</span>
              </div>
            </div>
            <div className="edit-branch-diff-scroll">
              {rows.length > 0 ? rows.map((row) => (
                <DiffRow
                  key={row.key}
                  row={row}
                  expanded={expandedKeys.has(row.key)}
                  onToggle={toggleCollapsed}
                />
              )) : (
                <div className="edit-branch-diff-state">没有节点级差异</div>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
