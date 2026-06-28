import { normalizeStableId } from '../../db/ids.js';
import type { IftreeStore } from '../../store/index.js';

type MutationPayload = Record<string, unknown>;
type PlainObject = Record<string, unknown>;

// 原本 WriteStore 是「最小子集 interface」，现在 IftreeStore 转调壳已收紧签名，handlers/* 全
// 改 IftreeStore 后这个本地子集失去意义；直接 alias，调用方不再 cast。
type WriteStore = IftreeStore;

// stream.push 等会调 ctx.isVectorModuleEnabled() 判断向量是否启用（来自 derived-index-reconciler
// 注入的 ctx）；refreshDoc 是 maybeRefreshDoc 用的回调。本接口是所有 write handler 共享的 ctx 形状。
export interface WriteContext {
  refreshDoc?: (docId: unknown, options?: unknown) => unknown;
  isVectorModuleEnabled?: () => boolean;
}

export function requireDocId(payload: MutationPayload = {}): string {
  const docId = normalizeStableId(payload.docId ?? payload.doc_id);
  if (!docId) throw new Error('database_write requires docId for this action');
  return docId;
}

// 接受两套主键：uuidv7（nodes/axioms/refs/docs）与正整数（doc_folders/save_history
// 的 INTEGER 主键）。tmp-… id 不会到这里——分支模式写操作在 mutation-api 就被
// stageEditBranch* 拦走。
export function requireId(payload: MutationPayload = {}, ...keys: string[]): string {
  for (const key of keys) {
    const value = normalizeStableId(payload[key]);
    if (value) return value;
  }
  throw new Error(`database_write requires ${keys[0]}`);
}

export function ownPatch(payload: MutationPayload = {}): PlainObject {
  const patch = payload.patch && typeof payload.patch === 'object' && !Array.isArray(payload.patch)
    ? payload.patch
    : {};
  return patch as PlainObject;
}

export function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') return { ...value };
  return value;
}

export function docRefresh(action: string, docId: unknown, extra: PlainObject = {}) {
  return {
    ok: true,
    action,
    docId,
    changed: true,
    refresh: { kind: 'doc', docId },
    ...extra
  };
}

export function docsRefresh(action: string, extra: PlainObject = {}) {
  return {
    ok: true,
    action,
    changed: true,
    refresh: { kind: 'docs' },
    ...extra
  };
}

export function nodeRefresh(action: string, docId: unknown, nodeId: unknown, extra: PlainObject = {}) {
  return {
    ok: true,
    action,
    docId,
    changed: true,
    refresh: { kind: 'node', docId, nodeId },
    ...extra
  };
}

export function maybeRefreshDoc(store: WriteStore, ctx: WriteContext = {}, docId: unknown, options: unknown = {}) {
  if (!docId) return null;
  if (typeof ctx.refreshDoc === 'function') return ctx.refreshDoc(docId, options);
  // IftreeStore.getDoc 现在签真签名（options 是精确字段集），unknown options 边界 cast 一次。
  return store.getDoc(docId, options as Parameters<IftreeStore['getDoc']>[1]);
}

export function listDocs(store: WriteStore) {
  return store.listDocs!().map(plain);
}

export function rowById(store: WriteStore, table: string, id: unknown): PlainObject | null {
  return store.db!.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) || null;
}

export function refDocId(store: WriteStore, refId: unknown): unknown {
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

export async function runOptionalEffect(effects: Array<Record<string, unknown>>, name: string, fn: unknown): Promise<void> {
  if (typeof fn !== 'function') return;
  try {
    await fn();
  } catch (error) {
    effects.push({ name, ok: false, error: (error as { message?: unknown } | null | undefined)?.message || String(error) });
  }
}
