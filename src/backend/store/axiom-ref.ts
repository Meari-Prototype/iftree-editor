// 公理与引用的通用持久化（L2）：只校验行归属、引用约束与排序，不含上层动作语义。

import type Database from 'better-sqlite3';
import { assertValidNodeRefKind } from '../shared.js';
import { newStableId, sameStableId } from '../db/ids.js';
import {
  hasPatchValue,
  normalizeNodeSizeMode,
  normalizeNullableText,
  normalizePositiveNumber,
  patchValue
} from '../db/normalizers.js';
import { AXIOM_ORDER_SQL, type AxiomRow, type NodeRow, type RefRow } from '../db/schema.js';

type RowObject = Record<string, unknown>;

export interface AxiomRefStore {
  db: Database | null;
  touchDoc(docId: unknown): void;
  withTransaction<T>(fn: () => T): T;
}

export type AddAxiomRefPayload = {
  docId?: unknown;
  nodeId?: unknown;
  axiomId?: unknown;
  note?: unknown;
};

export type AddNodeRefPayload = {
  docId?: unknown;
  sourceNodeId?: unknown;
  targetNodeId?: unknown;
  refKind?: unknown;
  note?: unknown;
};

export function addAxiomRefToNode(store: AxiomRefStore, {
  docId, nodeId, axiomId, note = null
}: AddAxiomRefPayload) {
  const target = store.db!.prepare('SELECT * FROM nodes WHERE id = ?').get<NodeRow>(nodeId);
  if (!target) throw new Error(`Target node not found: ${nodeId}`);
  const axiom = store.db!.prepare('SELECT * FROM axioms WHERE id = ?').get<AxiomRow>(axiomId);
  if (!axiom) throw new Error(`Axiom not found: ${axiomId}`);
  if (!sameStableId(target.doc_id, docId) || !sameStableId(axiom.doc_id, docId)) {
    throw new Error('Axiom and node must belong to the same document');
  }
  if (target.parent_id === null || target.parent_id === undefined) {
    throw new Error('根节点天然引用全部事实前提，无需添加引用。');
  }

  const existing = store.db!.prepare(`
    SELECT * FROM refs
    WHERE source_type = 'axiom'
      AND source_id = ?
      AND target_type = 'node'
      AND target_id = ?
      AND ref_kind = '事实前提'
    LIMIT 1
  `).get<RefRow>(axiomId, nodeId);
  if (existing) return existing;

  const refId = newStableId();
  store.db!.prepare(`
    INSERT INTO refs (id, source_type, source_id, target_type, target_id, ref_kind, note)
    VALUES (?, 'axiom', ?, 'node', ?, '事实前提', ?)
  `).run(refId, axiomId, nodeId, normalizeNullableText(note));

  store.touchDoc(docId);
  return store.db!.prepare('SELECT * FROM refs WHERE id = ?').get<RefRow>(refId);
}

export function addNodeRefToNode(store: AxiomRefStore, {
  docId, sourceNodeId, targetNodeId, refKind, note = null
}: AddNodeRefPayload) {
  const kind = normalizeNullableText(refKind);
  if (!kind) throw new Error('ref.addNodeToNode requires refKind');
  assertValidNodeRefKind(kind);
  const source = store.db!.prepare('SELECT * FROM nodes WHERE id = ?').get<NodeRow>(sourceNodeId);
  if (!source) throw new Error(`Source node not found: ${sourceNodeId}`);
  const target = store.db!.prepare('SELECT * FROM nodes WHERE id = ?').get<NodeRow>(targetNodeId);
  if (!target) throw new Error(`Target node not found: ${targetNodeId}`);
  if (!sameStableId(source.doc_id, docId) || !sameStableId(target.doc_id, docId)) {
    throw new Error('Source node and target node must belong to the same document');
  }
  const existing = store.db!.prepare(`
    SELECT * FROM refs
    WHERE source_type = 'node'
      AND source_id = ?
      AND target_type = 'node'
      AND target_id = ?
      AND ref_kind = ?
    LIMIT 1
  `).get<RefRow>(sourceNodeId, targetNodeId, kind);
  if (existing) return existing;

  const refId = newStableId();
  store.db!.prepare(`
    INSERT INTO refs (id, source_type, source_id, target_type, target_id, ref_kind, note)
    VALUES (?, 'node', ?, 'node', ?, ?, ?)
  `).run(refId, sourceNodeId, targetNodeId, kind, normalizeNullableText(note));

  store.touchDoc(docId);
  return store.db!.prepare('SELECT * FROM refs WHERE id = ?').get<RefRow>(refId);
}

export function deleteRef(store: AxiomRefStore, refId: unknown) {
  const ref = store.db!.prepare('SELECT * FROM refs WHERE id = ?').get<RefRow>(refId);
  if (!ref) return false;

  let docId = null;
  if (ref.source_type === 'node') {
    docId = store.db!.prepare('SELECT doc_id FROM nodes WHERE id = ?').get<Pick<NodeRow, 'doc_id'>>(ref.source_id)?.doc_id ?? null;
  }
  if (docId === null && ref.target_type === 'node') {
    docId = store.db!.prepare('SELECT doc_id FROM nodes WHERE id = ?').get<Pick<NodeRow, 'doc_id'>>(ref.target_id)?.doc_id ?? null;
  }

  store.db!.prepare('DELETE FROM refs WHERE id = ?').run(refId);
  if (docId !== null) store.touchDoc(docId);
  return true;
}

export function listDocRefs(store: AxiomRefStore, docId: unknown) {
  return store.db!.prepare(`
    SELECT refs.* FROM refs
    LEFT JOIN nodes source_nodes ON refs.source_type = 'node' AND refs.source_id = source_nodes.id
    LEFT JOIN nodes target_nodes ON refs.target_type = 'node' AND refs.target_id = target_nodes.id
    LEFT JOIN axioms source_axioms ON refs.source_type = 'axiom' AND refs.source_id = source_axioms.id
    LEFT JOIN axioms target_axioms ON refs.target_type = 'axiom' AND refs.target_id = target_axioms.id
    WHERE (refs.source_type = 'node' AND source_nodes.doc_id = ?)
       OR (refs.target_type = 'node' AND target_nodes.doc_id = ?)
       OR (refs.source_type = 'axiom' AND source_axioms.doc_id = ?)
       OR (refs.target_type = 'axiom' AND target_axioms.doc_id = ?)
    ORDER BY refs.id
  `).all<RefRow>(docId, docId, docId, docId);
}

export function addAxiom(store: AxiomRefStore, {
  docId, content, status = 'pending', nodeTitle = '', nodeNote = '',
  nodeWidth = null, nodeHeight = null, nodeSizeMode = 'auto'
}: RowObject) {
  return store.withTransaction(() => {
    const next = store.db!.prepare(`
      SELECT COALESCE(MAX(
        CASE WHEN label GLOB 'A[0-9]*' THEN CAST(substr(label, 2) AS INTEGER) ELSE 0 END
      ), 0) + 1 AS next_label
      FROM axioms
      WHERE doc_id = ?
    `).get<{ next_label: number }>(docId);
    const label = `A${Number(next?.next_label || 1)}`;
    const width = normalizePositiveNumber(nodeWidth);
    const height = normalizePositiveNumber(nodeHeight);
    let sizeMode = normalizeNodeSizeMode(nodeSizeMode);
    if (sizeMode === 'manual' && (width === null || height === null)) {
      sizeMode = 'auto';
    } else if (sizeMode === 'auto') {
      sizeMode = width !== null && height !== null ? 'manual' : 'auto';
    }
    const axiomId = newStableId();
    store.db!.prepare(`
      INSERT INTO axioms (id, doc_id, label, content, status, node_title, node_note, node_width, node_height, node_size_mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      axiomId,
      docId,
      label,
      typeof content === 'string' ? content : '',
      typeof status === 'string' ? status : 'pending',
      String(nodeTitle || '').trim() || `事实前提 ${label}`,
      String(nodeNote || ''),
      sizeMode === 'manual' ? width : null,
      sizeMode === 'manual' ? height : null,
      sizeMode
    );
    store.touchDoc(docId);
    return store.db!.prepare('SELECT * FROM axioms WHERE id = ?').get<AxiomRow>(axiomId);
  });
}

export function listAxioms(store: AxiomRefStore, docId: unknown) {
  return store.db!.prepare(`
    SELECT * FROM axioms
    WHERE doc_id = ?
    ORDER BY ${AXIOM_ORDER_SQL}
  `).all<AxiomRow>(docId);
}

export function deleteAxiom(store: AxiomRefStore, axiomId: unknown) {
  const axiom = store.db!.prepare('SELECT * FROM axioms WHERE id = ?').get<AxiomRow>(axiomId);
  if (!axiom) return false;
  store.withTransaction(() => {
    store.db!.prepare("DELETE FROM refs WHERE source_type = 'axiom' AND source_id = ?").run(axiomId);
    store.db!.prepare('DELETE FROM axioms WHERE id = ?').run(axiomId);
    store.touchDoc(axiom.doc_id);
  });
  return true;
}

export function updateAxiom(store: AxiomRefStore, axiomId: unknown, patch: RowObject) {
  const current = store.db!.prepare('SELECT * FROM axioms WHERE id = ?').get<AxiomRow>(axiomId);
  if (!current) throw new Error(`Axiom not found: ${axiomId}`);
  const hasWidthPatch = hasPatchValue(patch, 'node_width', 'nodeWidth');
  const hasHeightPatch = hasPatchValue(patch, 'node_height', 'nodeHeight');
  const hasSizeModePatch = hasPatchValue(patch, 'node_size_mode', 'nodeSizeMode');
  let nodeWidth = normalizePositiveNumber(patchValue(patch, 'node_width', 'nodeWidth', current.node_width));
  let nodeHeight = normalizePositiveNumber(patchValue(patch, 'node_height', 'nodeHeight', current.node_height));
  let nodeSizeMode = normalizeNodeSizeMode(
    patchValue(patch, 'node_size_mode', 'nodeSizeMode', current.node_size_mode)
  );
  if (!hasSizeModePatch && (hasWidthPatch || hasHeightPatch)) {
    nodeSizeMode = nodeWidth !== null && nodeHeight !== null ? 'manual' : 'auto';
  }
  if (nodeSizeMode === 'auto') {
    nodeWidth = null;
    nodeHeight = null;
  }
  store.db!.prepare(`
    UPDATE axioms
    SET content = ?, status = ?, node_title = ?, node_note = ?, node_width = ?, node_height = ?, node_size_mode = ?
    WHERE id = ?
  `).run(
    patch.content ?? current.content,
    patch.status ?? current.status,
    patch.node_title ?? patch.nodeTitle ?? current.node_title ?? '',
    patch.node_note ?? patch.nodeNote ?? current.node_note ?? '',
    nodeWidth,
    nodeHeight,
    nodeSizeMode,
    axiomId
  );
  store.touchDoc(current.doc_id);
  return store.db!.prepare('SELECT * FROM axioms WHERE id = ?').get<AxiomRow>(axiomId);
}

export function moveAxiom(store: AxiomRefStore, {
  docId, axiomId, direction
}: { docId?: unknown; axiomId?: unknown; direction?: unknown }) {
  const axioms = listAxioms(store, docId);
  const index = axioms.findIndex((axiom) => sameStableId(axiom.id, axiomId));
  if (index < 0) throw new Error(`Axiom not found: ${axiomId}`);
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= axioms.length) return false;
  const current = axioms[index];
  const target = axioms[targetIndex];
  store.withTransaction(() => {
    store.db!.prepare('UPDATE axioms SET label = ? WHERE id = ?').run(target.label, current.id);
    store.db!.prepare('UPDATE axioms SET label = ? WHERE id = ?').run(current.label, target.id);
    store.touchDoc(docId);
  });
  return true;
}
