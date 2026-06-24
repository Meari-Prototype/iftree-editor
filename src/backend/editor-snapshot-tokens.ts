// @ts-nocheck
// 编辑器易失撤销/重做令牌——进程内 Map，与持久化历史（commits / 内容寻址对象库）是两套机制
// （后端解耦第 1 步：从主库存储类剥离）。持有进程内令牌表，快照的创建/恢复回调注入的 store 原语
// （createSnapshot / restoreSnapshot / assertRestorableSnapshot）。store 析构即令牌全失，符合「易失」语义。
import { normalizePositiveId } from './db/normalizers.js';
import { sameStableId } from './db/ids.js';

export class EditorSnapshotTokens {
  constructor(store) {
    this.store = store;
    this.tokens = new Map();
    this.seq = 1;
  }

  create(docId) {
    const normalizedDocId = normalizePositiveId(docId);
    if (!normalizedDocId) {
      throw new Error('editor history requires docId');
    }
    const snapshot = this.store.createSnapshot(normalizedDocId);
    this.store.assertRestorableSnapshot(snapshot);
    const tokenId = `editor-${this.seq++}`;
    this.tokens.set(tokenId, {
      docId: normalizedDocId,
      snapshot
    });
    return { id: tokenId, docId: normalizedDocId };
  }

  restore({ docId, tokenId }) {
    const normalizedDocId = normalizePositiveId(docId);
    const normalizedTokenId = String(tokenId || '');
    const entry = this.tokens.get(normalizedTokenId);
    if (!entry) throw new Error('Editor history token not found');
    if (!sameStableId(entry.docId, normalizedDocId)) throw new Error('Editor history token belongs to another document');

    const redoToken = this.create(normalizedDocId);
    this.store.restoreSnapshot(normalizedDocId, entry.snapshot);
    this.tokens.delete(normalizedTokenId);
    return redoToken;
  }

  discard(tokenIds = []) {
    const ids = Array.isArray(tokenIds) ? tokenIds : [tokenIds];
    let deleted = 0;
    for (const tokenId of ids) {
      if (this.tokens.delete(String(tokenId || ''))) deleted += 1;
    }
    return deleted;
  }
}
