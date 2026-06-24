// @ts-nocheck
import { normalizeStableId } from './db/ids.js';

function normalizeIndexId(value, fallback = null) {
  return normalizeStableId(value, fallback);
}

export function keywordIndexRowsForDoc(store, docId) {
  const normalizedDocId = normalizeIndexId(docId, null);
  if (!store?.db || !normalizedDocId) return [];
  return store.db.prepare(`
    SELECT id, doc_id, address, node_title, text, node_note, updated_at
    FROM nodes
    WHERE doc_id = ?
    ORDER BY id
  `).all(normalizedDocId);
}

// 按节点 id 取索引行（4-6-2 增量同步用）。分块避开 SQLite 绑定变量上限。
export function keywordIndexRowsForNodeIds(store, docId, nodeIds = []) {
  const normalizedDocId = normalizeIndexId(docId, null);
  if (!store?.db || !normalizedDocId) return [];
  const ids = [...new Set((Array.isArray(nodeIds) ? nodeIds : [])
    .map((id) => normalizeIndexId(id, null))
    .filter(Boolean))];
  const rows = [];
  const CHUNK = 500;
  for (let offset = 0; offset < ids.length; offset += CHUNK) {
    const chunk = ids.slice(offset, offset + CHUNK);
    rows.push(...store.db.prepare(`
      SELECT id, doc_id, address, node_title, text, node_note, updated_at
      FROM nodes
      WHERE doc_id = ? AND id IN (${chunk.map(() => '?').join(',')})
      ORDER BY id
    `).all(normalizedDocId, ...chunk));
  }
  return rows;
}

export function keywordIndexRowsForAllDocs(store) {
  if (!store?.db) return [];
  return store.db.prepare(`
    SELECT id, doc_id, address, node_title, text, node_note, updated_at
    FROM nodes
    ORDER BY doc_id, id
  `).all();
}

export function keywordIndexRowsForPayload(store, payload = {}) {
  const allDocs = payload.allDocs === true || payload.all_docs === true || payload.scope === 'all';
  if (allDocs) return keywordIndexRowsForAllDocs(store);
  const docId = normalizeIndexId(payload.scopeDocId ?? payload.scope_doc_id ?? payload.docId ?? payload.doc_id, null);
  if (!docId) throw new Error('content.searchKeyword requires docId unless allDocs is true');
  return keywordIndexRowsForDoc(store, docId);
}
