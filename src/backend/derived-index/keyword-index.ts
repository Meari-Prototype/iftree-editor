import { normalizeStableId } from '../db/ids.js';
import type Database from 'better-sqlite3';
import {
  nodeContentRowsForAllDocs,
  nodeContentRowsForDoc,
  nodeContentRowsForNodeIds
} from '../db/node-content-rows.js';

interface KeywordIndexStore {
  // 与 IftreeStore.db / EntityStore.db 对齐（构造前/close 后为 null）；内部 `if (!store?.db) return []` 守卫。
  db?: Database | null;
}

interface KeywordIndexPayload {
  allDocs?: boolean;
  all_docs?: boolean;
  scope?: string;
  scopeDocId?: unknown;
  scope_doc_id?: unknown;
  docId?: unknown;
  doc_id?: unknown;
}

function normalizeIndexId(value: unknown, fallback: string | null = null): string | null {
  return normalizeStableId(value, fallback);
}

export function keywordIndexRowsForDoc(store: KeywordIndexStore | null | undefined, docId: unknown): Array<Record<string, unknown>> {
  return nodeContentRowsForDoc(store, docId);
}

// 按节点 id 取索引行（4-6-2 增量同步用）。分块避开 SQLite 绑定变量上限。
export function keywordIndexRowsForNodeIds(store: KeywordIndexStore | null | undefined, docId: unknown, nodeIds: unknown[] = []): Array<Record<string, unknown>> {
  return nodeContentRowsForNodeIds(store, docId, nodeIds);
}

export function keywordIndexRowsForAllDocs(store: KeywordIndexStore | null | undefined): Array<Record<string, unknown>> {
  return nodeContentRowsForAllDocs(store);
}

export function keywordIndexRowsForPayload(store: KeywordIndexStore | null | undefined, payload: KeywordIndexPayload = {}): Array<Record<string, unknown>> {
  const allDocs = payload.allDocs === true || payload.all_docs === true || payload.scope === 'all';
  if (allDocs) return keywordIndexRowsForAllDocs(store);
  const docId = normalizeIndexId(payload.scopeDocId ?? payload.scope_doc_id ?? payload.docId ?? payload.doc_id, null);
  if (!docId) throw new Error('content.searchKeyword requires docId unless allDocs is true');
  return keywordIndexRowsForDoc(store, docId);
}
