import { normalizeStableId } from '../../db/ids.mjs';

export function requireDocId(payload = {}) {
  const docId = normalizeStableId(payload.docId ?? payload.doc_id);
  if (!docId) throw new Error('database_write requires docId for this action');
  return docId;
}

export function requirePositiveId(payload = {}, ...keys) {
  for (const key of keys) {
    const value = normalizeStableId(payload[key]);
    if (value) return value;
  }
  throw new Error(`database_write requires ${keys[0]}`);
}

export function ownPatch(payload = {}) {
  const patch = payload.patch && typeof payload.patch === 'object' && !Array.isArray(payload.patch)
    ? payload.patch
    : {};
  return patch;
}

export function plain(value) {
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') return { ...value };
  return value;
}

export function docRefresh(action, docId, extra = {}) {
  return {
    ok: true,
    action,
    docId,
    changed: true,
    refresh: { kind: 'doc', docId },
    ...extra
  };
}

export function docsRefresh(action, extra = {}) {
  return {
    ok: true,
    action,
    changed: true,
    refresh: { kind: 'docs' },
    ...extra
  };
}

export function nodeRefresh(action, docId, nodeId, extra = {}) {
  return {
    ok: true,
    action,
    docId,
    changed: true,
    refresh: { kind: 'node', docId, nodeId },
    ...extra
  };
}

export function maybeRefreshDoc(store, ctx, docId, options = {}) {
  if (!docId) return null;
  if (typeof ctx.refreshDoc === 'function') return ctx.refreshDoc(docId, options);
  return store.getDoc(docId, options);
}

export function listDocs(store) {
  return store.listDocs().map(plain);
}

export function rowById(store, table, id) {
  return store.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) || null;
}

export function refDocId(store, refId) {
  const ref = rowById(store, 'refs', refId);
  if (!ref) return null;
  if (ref.source_type === 'node') {
    const source = rowById(store, 'nodes', ref.source_id);
    if (source) return source.doc_id;
  }
  if (ref.target_type === 'node') {
    const target = rowById(store, 'nodes', ref.target_id);
    if (target) return target.doc_id;
  }
  if (ref.source_type === 'axiom') {
    const axiom = rowById(store, 'axioms', ref.source_id);
    if (axiom) return axiom.doc_id;
  }
  return null;
}

export async function runOptionalEffect(effects, name, fn) {
  if (typeof fn !== 'function') return;
  try {
    await fn();
  } catch (error) {
    effects.push({ name, ok: false, error: error?.message || String(error) });
  }
}
