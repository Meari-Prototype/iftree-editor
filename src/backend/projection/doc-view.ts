// L3 当前文档视图：只把 human 草稿投影进主视图；L2 仅提供原始行物化。

import { projectEditBranchDoc } from './edit-branch-projection.js';
import type { DocMaterializedRows, IftreeStore } from '../store/index.js';

type DocOptions = Parameters<IftreeStore['getDoc']>[1];
type ProjectionCache = { docId: string; branchId: number; stamp: string; rows: DocMaterializedRows };
const cacheByStore = new WeakMap<IftreeStore, ProjectionCache>();

export function getProjectedDoc(store: IftreeStore, docId: unknown, options: DocOptions = {}) {
  const branch = store.activeEditBranchForBaseDoc(docId, 'human') as { id: number; diff?: string | null } | null;
  if (!branch) {
    cacheByStore.delete(store);
    return store.getDoc(docId, options);
  }
  let entries: unknown[] = [];
  try {
    const diff = JSON.parse(branch.diff || '{}');
    entries = Array.isArray(diff.entries) ? diff.entries : [];
  } catch { entries = []; }
  if (entries.length === 0) {
    cacheByStore.delete(store);
    return store.getDoc(docId, options);
  }

  const stamp = store._dataChangeStamp();
  const cached = cacheByStore.get(store);
  let rows: DocMaterializedRows;
  if (cached && cached.docId === String(docId) && cached.branchId === branch.id && cached.stamp === stamp) {
    rows = cached.rows;
  } else {
    const base = store.materializeDoc(docId, {
      includeSourceSpans: false,
      includeSourceDocumentContent: false
    });
    if (!base) return null;
    const projected = projectEditBranchDoc({
      docId: String(docId),
      nodes: base.nodes,
      axioms: base.axioms,
      refs: base.refs
    }, entries);
    rows = {
      nodes: projected.nodes,
      axioms: projected.axioms,
      refs: projected.refs
    };
    cacheByStore.set(store, { docId: String(docId), branchId: branch.id, stamp, rows });
  }
  return store.materializeDoc(docId, options, rows);
}
