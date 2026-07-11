import {
  docRefresh,
  maybeRefreshDoc,
  plain,
  requireDocId,
  requireId,
  rowById,
  type WriteContext
} from './shared.js';
// L4 内部横向复用：历史 ref 解析的唯一实现住读侧 handler，写侧 restore 直接借用（同层，非跨层引用）。
import { resolveHistoryCommitRow } from '../read/history.js';
import type { IftreeStore } from '../../store/index.js';

type WritePayload = Record<string, unknown>;
type EffectList = Array<Record<string, unknown>>;

type HistoryStore = IftreeStore;
type HistoryContext = WriteContext;

export async function handleHistoryMutation(store: HistoryStore, payload: WritePayload, ctx: HistoryContext, action: string, effects: EffectList) {
  if (action === 'history.save') {
    const docId = requireDocId(payload);
    // payload 是 WritePayload（Record<string, unknown> 索引签名）；SaveHistorySnapshotPayload
    // 是精确字段集（docId/summary/owner 全 unknown）。结构上后者是前者的子集，但 TS 索引签名
    // 不能自动收窄成精确字段，边界 cast。
    const history = store.saveHistorySnapshot(payload as unknown as Parameters<typeof store.saveHistorySnapshot>[0]);
    return docRefresh(action, docId, { history: plain(history), sideEffects: effects });
  }
  if (action === 'history.restore') {
    // commitId 精确优先；无 commitId 时走 ref/refKind 模糊解析（自 db-shell restore 下沉，唯一命中才落）。
    if (payload.commitId == null && payload.commit_id == null) {
      const commit = resolveHistoryCommitRow(store, payload);
      payload = { ...payload, commitId: commit.id, docId: payload.docId ?? payload.doc_id ?? commit.doc_id };
    }
    const commitId = requireId(payload, 'commitId', 'commit_id');
    const commit = rowById(store, 'commits', commitId);
    const docId = payload.docId ?? payload.doc_id ?? commit?.doc_id;
    if (!docId) throw new Error('history.restore requires docId or an existing commitId');
    const changed = store.restoreCommit(commitId);
    const doc = maybeRefreshDoc(store, ctx, docId, payload.refreshOptions || {});
    return docRefresh(action, docId, { changed: Boolean(changed), doc, sideEffects: effects });
  }
  if (action === 'history.certify') {
    const docId = requireDocId(payload);
    const result = store.certifyNodes({
      docId,
      nodeId: payload.nodeId ?? payload.node_id ?? null,
      address: payload.address ?? null,
      scope: payload.scope || 'subtree',
      trust: payload.trust || '受控',
      owner: payload.owner || 'human'
    });
    const doc = maybeRefreshDoc(store, ctx, docId, payload.refreshOptions || {});
    return docRefresh(action, docId, { ...result, doc, sideEffects: effects });
  }
  if (action === 'history.revert') {
    const commitId = requireId(payload, 'commitId', 'commit_id');
    const result = store.revertCommit({ commitId, owner: payload.owner || 'human', summary: payload.summary ?? null });
    const doc = maybeRefreshDoc(store, ctx, result.docId, payload.refreshOptions || {});
    return docRefresh(action, result.docId, { ...result, doc, sideEffects: effects });
  }
  throw new Error(`Unhandled database_write action: ${action}`);
}

export async function handleEditorHistoryMutation(store: HistoryStore, payload: WritePayload, ctx: HistoryContext, action: string, effects: EffectList) {
  if (action === 'editorHistory.capture') {
    const docId = requireDocId(payload);
    // editor-session 域实例挂 store（GC 保活根需要），动作面直调、不经 store 门面（§6-1）。
    const token = store.editorSnapshots.create(docId);
    return {
      ok: true,
      action,
      docId,
      token,
      sideEffects: effects
    };
  }

  if (action === 'editorHistory.restore') {
    const docId = requireDocId(payload);
    const tokenId = String(payload.tokenId ?? payload.token_id ?? '');
    if (!tokenId) throw new Error('editorHistory.restore requires tokenId');
    const token = store.editorSnapshots.restore({ docId, tokenId });
    const doc = maybeRefreshDoc(store, ctx, docId, payload.refreshOptions || {});
    return docRefresh(action, docId, { changed: true, doc, token, sideEffects: effects });
  }

  if (action === 'editorHistory.discard') {
    const tokenIds = Array.isArray(payload.tokenIds) ? payload.tokenIds : [payload.tokenId ?? payload.token_id].filter(Boolean);
    const discarded = store.editorSnapshots.discard(tokenIds);
    return {
      ok: true,
      action,
      changed: discarded,
      discarded,
      sideEffects: effects
    };
  }

  throw new Error(`Unhandled database_write action: ${action}`);
}
