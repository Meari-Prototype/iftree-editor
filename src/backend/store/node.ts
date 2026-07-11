// 节点基础写操作（L2）：增、改、删子树、同父换序。事务与地址维护仍由 IftreeStore 统一提供。

import { normalizeNodeType } from '../../core/node-model.js';
import type Database from 'better-sqlite3';
import { mergeNodeNotes } from '../../core/node-notes.js';
import { splitSentences } from '../../core/tree.js';
import { newStableId } from '../db/ids.js';
import {
  normalizeNullableText,
  normalizeSourcePosition,
  patchValue
} from '../db/normalizers.js';
import type { NodeRow, SourceSpanRow } from '../db/schema.js';
import { assertNoHumanTagField } from '../shared.js';

export interface NodeStore {
  db: Database | null;
  normalizeSiblingOrder(docId: unknown, parentId: unknown): void;
  refreshAddressScopes(docId: unknown, parentIds?: unknown[] | unknown): { updated: number; scopes: number };
  setSiblingOrder(docId: unknown, parentId: unknown, orderedIds: unknown[]): void;
  touchDoc(docId: unknown): void;
  withTransaction<T>(fn: () => T): T;
}

type NodePatch = Record<string, unknown>;
type CountRow = { count: number };
type SourceParagraphTarget = { node: NodeRow; spans: SourceSpanRow[] };

export interface InsertNodePayload {
  docId?: unknown;
  parentId?: unknown;
  text?: unknown;
  nodeType?: unknown;
  nodeTitle?: unknown;
  nodeNote?: unknown;
  sourcePosition?: unknown;
  trustLevel?: unknown;
  afterNodeId?: unknown;
}

interface NodeRefPayload {
  docId?: unknown;
  nodeId?: unknown;
  targetNodeId?: unknown;
  newParentId?: unknown;
}

export function insertNode(store: NodeStore, {
  docId, parentId, text = '', nodeType = 'TEXT', nodeTitle = '', nodeNote = '',
  sourcePosition = null, trustLevel = null, afterNodeId = null
}: InsertNodePayload): NodeRow {
  const siblings = store.db!.prepare(`
    SELECT id, sort_order FROM nodes
    WHERE doc_id = ? AND parent_id IS ?
    ORDER BY sort_order, id
  `).all<Pick<NodeRow, 'id' | 'sort_order'>>(docId, parentId);

  let insertOrder = siblings.length + 1;
  if (afterNodeId !== null) {
    const index = siblings.findIndex((node) => node.id === afterNodeId);
    if (index >= 0) insertOrder = siblings[index].sort_order + 1;
  }

  store.db!.prepare(`
    UPDATE nodes
    SET sort_order = sort_order + 1
    WHERE doc_id = ? AND parent_id IS ? AND sort_order >= ?
  `).run(docId, parentId, insertOrder);

  const nodeId = newStableId();
  const normalizedNodeType = normalizeNodeType(nodeType);
  store.db!.prepare(`
    INSERT INTO nodes (id, doc_id, parent_id, sort_order, node_type, text, node_title, node_note, source_position, trust_level)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    nodeId, docId, parentId, insertOrder, normalizedNodeType, text, nodeTitle || '', nodeNote || '',
    normalizeSourcePosition(sourcePosition), normalizeNullableText(trustLevel)
  );

  store.refreshAddressScopes(docId, [parentId]);
  store.touchDoc(docId);
  return store.db!.prepare('SELECT * FROM nodes WHERE id = ?').get<NodeRow>(nodeId)!;
}

export function updateNode(store: NodeStore, nodeId: unknown, patch: NodePatch) {
  assertNoHumanTagField(patch, 'updateNode patch');
  const current = store.db!.prepare('SELECT * FROM nodes WHERE id = ?').get<NodeRow>(nodeId);
  if (!current) throw new Error(`Node not found: ${nodeId}`);

  const next = {
    text: patch.text ?? current.text,
    node_title: patch.node_title ?? patch.nodeTitle ?? current.node_title,
    node_note: patch.node_note ?? patch.nodeNote ?? current.node_note,
    source_position: patchValue(patch, 'source_position', 'sourcePosition', current.source_position),
    node_type: normalizeNodeType(patchValue(patch, 'node_type', 'nodeType', current.node_type)),
    trust_level: normalizeNullableText(patchValue(patch, 'trust_level', 'trustLevel', current.trust_level))
  };

  store.db!.prepare(`
    UPDATE nodes
    SET text = ?, node_title = ?, node_note = ?, source_position = ?, node_type = ?, trust_level = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    next.text,
    next.node_title || '',
    next.node_note || '',
    normalizeSourcePosition(next.source_position),
    next.node_type,
    next.trust_level,
    nodeId
  );

  store.touchDoc(current.doc_id);
  return store.db!.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId);
}

export function deleteNodeSubtree(store: NodeStore, nodeId: unknown) {
  const node = store.db!.prepare('SELECT * FROM nodes WHERE id = ?').get<NodeRow>(nodeId);
  if (!node) return false;
  if (node.parent_id === null) throw new Error('Cannot delete document root node');

  store.withTransaction(() => {
    // 节点被摧毁 → 指向子树内任何节点的引用连带蒸发（refs 无外键，需手工清）。
    store.db!.prepare(`
      WITH RECURSIVE subtree(id) AS (
        SELECT id FROM nodes WHERE id = ?
        UNION ALL
        SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.id
      )
      DELETE FROM refs
      WHERE (source_type = 'node' AND source_id IN (SELECT id FROM subtree))
         OR (target_type = 'node' AND target_id IN (SELECT id FROM subtree))
    `).run(nodeId);
    store.db!.prepare('DELETE FROM nodes WHERE id = ?').run(nodeId);
    store.normalizeSiblingOrder(node.doc_id, node.parent_id);
    store.refreshAddressScopes(node.doc_id, [node.parent_id]);
    store.touchDoc(node.doc_id);
  });
  return true;
}

export function moveNode(store: NodeStore, nodeId: unknown, direction: unknown) {
  const node = store.db!.prepare('SELECT * FROM nodes WHERE id = ?').get<NodeRow>(nodeId);
  if (!node || node.parent_id === null) return false;

  const comparator = direction === 'up' ? '<' : '>';
  const order = direction === 'up' ? 'DESC' : 'ASC';
  const sibling = store.db!.prepare(`
    SELECT * FROM nodes
    WHERE doc_id = ? AND parent_id IS ? AND sort_order ${comparator} ?
    ORDER BY sort_order ${order}
    LIMIT 1
  `).get<NodeRow>(node.doc_id, node.parent_id, node.sort_order);

  if (!sibling) return false;

  store.withTransaction(() => {
    store.db!.prepare('UPDATE nodes SET sort_order = ? WHERE id = ?').run(sibling.sort_order, node.id);
    store.db!.prepare('UPDATE nodes SET sort_order = ? WHERE id = ?').run(node.sort_order, sibling.id);
    store.refreshAddressScopes(node.doc_id, [node.parent_id]);
    store.touchDoc(node.doc_id);
  });
  return true;
}

export function splitNodeIntoChildren(
  store: NodeStore,
  nodeId: unknown,
  options: { splitAsciiPunctuation?: unknown; split_ascii_punctuation?: unknown } = {}
) {
  const current = store.db!.prepare('SELECT * FROM nodes WHERE id = ?').get<NodeRow>(nodeId);
  if (!current) throw new Error(`Node not found: ${nodeId}`);

  if (splitSourceParagraphsIntoSentenceChildren(store, current)) return true;

  const sentences = splitSentences(current.text, {
    splitAsciiPunctuation: options.splitAsciiPunctuation === true || options.split_ascii_punctuation === true
  });
  if (sentences.length < 2) return false;

  store.withTransaction(() => {
    store.db!.prepare('UPDATE nodes SET text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(sentences[0], nodeId);

    store.db!.prepare(`
      UPDATE nodes
      SET sort_order = sort_order + ?
      WHERE doc_id = ? AND parent_id IS ? AND sort_order >= 1
    `).run(sentences.length - 1, current.doc_id, nodeId);

    const insert = store.db!.prepare(`
      INSERT INTO nodes (id, doc_id, parent_id, sort_order, node_type, text)
      VALUES (?, ?, ?, ?, 'TEXT', ?)
    `);
    sentences.slice(1).forEach((sentence, index) => {
      insert.run(newStableId(), current.doc_id, nodeId, index + 1, sentence);
    });

    store.normalizeSiblingOrder(current.doc_id, nodeId);
    store.refreshAddressScopes(current.doc_id, [nodeId]);
    store.touchDoc(current.doc_id);
  });

  return true;
}

export function splitSourceParagraphsIntoSentenceChildren(store: NodeStore, rootNode: NodeRow) {
  const candidates = store.db!.prepare(`
    WITH RECURSIVE subtree(id) AS (
      SELECT id FROM nodes WHERE id = ?
      UNION ALL
      SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.id
    )
    SELECT n.*
    FROM nodes n
    JOIN subtree s ON n.id = s.id
    WHERE n.source_position IS NOT NULL
      AND ABS(n.source_position - CAST(n.source_position AS INTEGER)) > 0.000001
    ORDER BY n.id
  `).all<NodeRow>(rootNode.id);
  if (candidates.length === 0) return false;

  const spansForNode = store.db!.prepare(`
    SELECT *
    FROM source_spans
    WHERE node_id = ?
    ORDER BY sentence_index, id
  `);
  const childCount = store.db!.prepare('SELECT COUNT(*) AS count FROM nodes WHERE parent_id = ?');
  const targetRows: SourceParagraphTarget[] = [];
  for (const candidate of candidates) {
    if (Number(childCount.get<CountRow>(candidate.id)?.count) > 0) continue;
    const spans = spansForNode.all<SourceSpanRow>(candidate.id);
    if (spans.length > 0) targetRows.push({ node: candidate, spans });
  }
  if (targetRows.length === 0) return false;

  store.withTransaction(() => {
    const clearParagraph = store.db!.prepare('UPDATE nodes SET text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const insert = store.db!.prepare(`
      INSERT INTO nodes (id, doc_id, parent_id, sort_order, node_type, text, source_position)
      VALUES (?, ?, ?, ?, 'TEXT', ?, ?)
    `);
    const updateSpan = store.db!.prepare('UPDATE source_spans SET node_id = ? WHERE id = ?');

    for (const target of targetRows) {
      clearParagraph.run('', target.node.id);
      for (const [index, span] of target.spans.entries()) {
        const nodeId = newStableId();
        insert.run(
          nodeId,
          target.node.doc_id,
          target.node.id,
          index + 1,
          span.text || '',
          normalizeSourcePosition(span.sentence_index)
        );
        updateSpan.run(nodeId, span.id);
      }
      store.normalizeSiblingOrder(target.node.doc_id, target.node.id);
    }
    store.refreshAddressScopes(rootNode.doc_id, targetRows.map((target) => target.node.id));
    store.touchDoc(rootNode.doc_id);
  });

  return true;
}

export function isDescendant(store: NodeStore, candidateId: unknown, ancestorId: unknown) {
  let current = store.db!.prepare('SELECT parent_id FROM nodes WHERE id = ?')
    .get<Pick<NodeRow, 'parent_id'>>(candidateId);
  while (current?.parent_id !== null && current?.parent_id !== undefined) {
    if (current.parent_id === ancestorId) return true;
    current = store.db!.prepare('SELECT parent_id FROM nodes WHERE id = ?')
      .get<Pick<NodeRow, 'parent_id'>>(current.parent_id);
  }
  return false;
}

export function promoteNode(store: NodeStore, nodeId: unknown) {
  const current = store.db!.prepare('SELECT * FROM nodes WHERE id = ?').get<NodeRow>(nodeId);
  if (!current || current.parent_id === null) return false;

  const parent = store.db!.prepare('SELECT * FROM nodes WHERE id = ?').get<NodeRow>(current.parent_id);
  if (!parent || parent.parent_id === null) return false;

  store.withTransaction(() => {
    store.db!.prepare(`
      UPDATE nodes
      SET sort_order = sort_order + 1
      WHERE doc_id = ? AND parent_id IS ? AND sort_order > ?
    `).run(current.doc_id, parent.parent_id, parent.sort_order);

    store.db!.prepare('UPDATE nodes SET parent_id = ?, sort_order = ? WHERE id = ?')
      .run(parent.parent_id, parent.sort_order + 1, current.id);

    store.normalizeSiblingOrder(current.doc_id, parent.id);
    store.normalizeSiblingOrder(current.doc_id, parent.parent_id);
    store.refreshAddressScopes(current.doc_id, [parent.id, parent.parent_id]);
    store.touchDoc(current.doc_id);
  });

  return true;
}

export function moveNodeToParent(store: NodeStore, { nodeId, newParentId }: NodeRefPayload) {
  const current = store.db!.prepare('SELECT * FROM nodes WHERE id = ?').get<NodeRow>(nodeId);
  const newParent = store.db!.prepare('SELECT * FROM nodes WHERE id = ?').get<NodeRow>(newParentId);
  if (!current || !newParent) return false;
  if (current.parent_id === null) return false;
  if (current.id === newParent.id) return false;
  if (current.doc_id !== newParent.doc_id) return false;
  if (isDescendant(store, newParent.id, current.id)) return false;

  const newOrder = Number(store.db!.prepare(`
    SELECT COUNT(*) AS count FROM nodes WHERE doc_id = ? AND parent_id IS ?
  `).get<CountRow>(current.doc_id, newParent.id)?.count ?? 0) + 1;

  store.withTransaction(() => {
    const oldParentId = current.parent_id;
    store.db!.prepare('UPDATE nodes SET parent_id = ?, sort_order = ? WHERE id = ?')
      .run(newParent.id, newOrder, current.id);
    store.normalizeSiblingOrder(current.doc_id, oldParentId);
    store.normalizeSiblingOrder(current.doc_id, newParent.id);
    store.refreshAddressScopes(current.doc_id, [oldParentId, newParent.id]);
    store.touchDoc(current.doc_id);
  });

  return true;
}

export function moveNodeAfterSibling(store: NodeStore, { nodeId, targetNodeId }: NodeRefPayload) {
  return moveNodeAroundSibling(store, nodeId, targetNodeId, 'after');
}

export function moveNodeBeforeSibling(store: NodeStore, { nodeId, targetNodeId }: NodeRefPayload) {
  return moveNodeAroundSibling(store, nodeId, targetNodeId, 'before');
}

function moveNodeAroundSibling(
  store: NodeStore,
  nodeId: unknown,
  targetNodeId: unknown,
  placement: 'before' | 'after'
) {
  const current = store.db!.prepare('SELECT * FROM nodes WHERE id = ?').get<NodeRow>(nodeId);
  const target = store.db!.prepare('SELECT * FROM nodes WHERE id = ?').get<NodeRow>(targetNodeId);
  if (!current || !target) return false;
  if (current.parent_id === null || target.parent_id === null) return false;
  if (current.id === target.id) return false;
  if (current.doc_id !== target.doc_id) return false;
  if (isDescendant(store, target.parent_id, current.id)) return false;

  store.withTransaction(() => {
    const targetSiblings = store.db!.prepare(`
      SELECT id FROM nodes
      WHERE doc_id = ? AND parent_id IS ? AND id != ?
      ORDER BY sort_order, id
    `).all<Pick<NodeRow, 'id'>>(current.doc_id, target.parent_id, current.id).map((item) => item.id);

    const targetIndex = targetSiblings.indexOf(target.id);
    if (targetIndex < 0) return;
    targetSiblings.splice(targetIndex + (placement === 'after' ? 1 : 0), 0, current.id);

    const oldParentId = current.parent_id;
    store.db!.prepare('UPDATE nodes SET parent_id = ? WHERE id = ?').run(target.parent_id, current.id);
    store.setSiblingOrder(current.doc_id, target.parent_id, targetSiblings);
    if (oldParentId !== target.parent_id) store.normalizeSiblingOrder(current.doc_id, oldParentId);
    store.refreshAddressScopes(current.doc_id, [oldParentId, target.parent_id]);
    store.touchDoc(current.doc_id);
  });

  return true;
}

export function mergeNodeIntoPreviousSibling(store: NodeStore, nodeId: unknown) {
  const current = store.db!.prepare('SELECT * FROM nodes WHERE id = ?').get<NodeRow>(nodeId);
  if (!current || current.parent_id === null) return false;

  const previous = store.db!.prepare(`
    SELECT * FROM nodes
    WHERE doc_id = ? AND parent_id IS ? AND sort_order < ?
    ORDER BY sort_order DESC, id DESC
    LIMIT 1
  `).get<NodeRow>(current.doc_id, current.parent_id, current.sort_order);
  if (!previous) return false;

  return mergeNodeRows(store, current, previous);
}

export function mergeNodeIntoTarget(store: NodeStore, { nodeId, targetNodeId }: NodeRefPayload) {
  const current = store.db!.prepare('SELECT * FROM nodes WHERE id = ?').get<NodeRow>(nodeId);
  const target = store.db!.prepare('SELECT * FROM nodes WHERE id = ?').get<NodeRow>(targetNodeId);
  if (!current || !target) return false;
  if (current.parent_id === null) return false;
  if (current.id === target.id) return false;
  if (current.doc_id !== target.doc_id) return false;
  if (isDescendant(store, target.id, current.id)) return false;

  return mergeNodeRows(store, current, target);
}

function mergeNodeRows(store: NodeStore, current: NodeRow, target: NodeRow) {
  store.withTransaction(() => {
    const mergedText = [target.text, current.text]
      .map((part) => String(part || '').trim())
      .filter(Boolean)
      .join('\n\n');
    const mergedTitle = mergeNodeNotes(target.node_title, current.node_title);
    const mergedNote = mergeNodeNotes(target.node_note, current.node_note);

    store.db!.prepare('UPDATE nodes SET text = ?, node_title = ?, node_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(mergedText, mergedTitle, mergedNote, target.id);

    const targetChildCount = Number(store.db!.prepare(`
      SELECT COUNT(*) AS count FROM nodes WHERE doc_id = ? AND parent_id IS ?
    `).get<CountRow>(current.doc_id, target.id)?.count ?? 0);

    const movingChildren = store.db!.prepare(`
      SELECT id FROM nodes
      WHERE doc_id = ? AND parent_id IS ?
      ORDER BY sort_order, id
    `).all<Pick<NodeRow, 'id'>>(current.doc_id, current.id);

    movingChildren.forEach((child, index) => {
      store.db!.prepare('UPDATE nodes SET parent_id = ?, sort_order = ? WHERE id = ?')
        .run(target.id, targetChildCount + index + 1, child.id);
    });

    const oldParentId = current.parent_id;
    store.db!.prepare('UPDATE source_spans SET node_id = ? WHERE node_id = ?').run(target.id, current.id);
    // 被合并节点被摧毁 → 指向它的引用连带蒸发（孩子已搬走、其引用不动）。
    store.db!.prepare(`
      DELETE FROM refs
      WHERE (source_type = 'node' AND source_id = ?)
         OR (target_type = 'node' AND target_id = ?)
    `).run(current.id, current.id);
    store.db!.prepare('DELETE FROM nodes WHERE id = ?').run(current.id);
    store.normalizeSiblingOrder(current.doc_id, oldParentId);
    store.normalizeSiblingOrder(current.doc_id, target.id);
    store.refreshAddressScopes(current.doc_id, [oldParentId, target.id]);
    store.touchDoc(current.doc_id);
  });

  return true;
}
