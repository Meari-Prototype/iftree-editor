import { normalizeStableId } from './db/ids.mjs';

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
