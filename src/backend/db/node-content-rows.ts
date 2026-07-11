// 节点内容行的 L1 读取原语：供上层索引、实体排序等域复用，不包含索引策略。

import { normalizeStableId } from './ids.js';
import type Database from 'better-sqlite3';

export interface NodeContentRow extends Record<string, unknown> {
  id: string;
  doc_id: string;
  address: string;
  node_title: string;
  text: string;
  node_note: string;
  updated_at: string;
}

interface NodeContentStore {
  db?: Database | null;
}

function normalizedId(value: unknown): string | null {
  return normalizeStableId(value, null);
}

export function nodeContentRowsForDoc(store: NodeContentStore | null | undefined, docId: unknown): NodeContentRow[] {
  const normalizedDocId = normalizedId(docId);
  if (!store?.db || !normalizedDocId) return [];
  return store.db.prepare(`
    SELECT id, doc_id, address, node_title, text, node_note, updated_at
    FROM nodes
    WHERE doc_id = ?
    ORDER BY id
  `).all<NodeContentRow>(normalizedDocId);
}

export function nodeContentRowsForNodeIds(
  store: NodeContentStore | null | undefined,
  docId: unknown,
  nodeIds: unknown[] = []
): NodeContentRow[] {
  const normalizedDocId = normalizedId(docId);
  if (!store?.db || !normalizedDocId) return [];
  const ids = [...new Set((Array.isArray(nodeIds) ? nodeIds : [])
    .map(normalizedId)
    .filter((id): id is string => Boolean(id)))];
  const rows: NodeContentRow[] = [];
  const chunkSize = 500;
  for (let offset = 0; offset < ids.length; offset += chunkSize) {
    const chunk = ids.slice(offset, offset + chunkSize);
    rows.push(...store.db.prepare(`
      SELECT id, doc_id, address, node_title, text, node_note, updated_at
      FROM nodes
      WHERE doc_id = ? AND id IN (${chunk.map(() => '?').join(',')})
      ORDER BY id
    `).all<NodeContentRow>(normalizedDocId, ...chunk));
  }
  return rows;
}

export function nodeContentRowsForAllDocs(store: NodeContentStore | null | undefined): NodeContentRow[] {
  if (!store?.db) return [];
  return store.db.prepare(`
    SELECT id, doc_id, address, node_title, text, node_note, updated_at
    FROM nodes
    ORDER BY doc_id, id
  `).all<NodeContentRow>();
}
