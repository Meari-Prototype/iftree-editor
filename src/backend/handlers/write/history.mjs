import {
  docRefresh,
  maybeRefreshDoc,
  plain,
  requireDocId,
  requireId,
  rowById,
  runOptionalEffect
} from './shared.mjs';

export async function handleHistoryMutation(store, payload, ctx, action, effects) {
  if (action === 'history.save') {
    const docId = requireDocId(payload);
    const history = store.saveHistorySnapshot(payload);
    return docRefresh(action, docId, { history: plain(history), sideEffects: effects });
  }
  if (action === 'history.restore') {
    const commitId = requireId(payload, 'commitId', 'commit_id');
    const commit = rowById(store, 'commits', commitId);
    const docId = payload.docId ?? payload.doc_id ?? commit?.doc_id;
    if (!docId) throw new Error('history.restore requires docId or an existing commitId');
    const changed = store.restoreCommit(commitId);
    await runOptionalEffect(effects, 'vector.delete_doc', () => ctx.deleteDocVectors?.(docId));
    await runOptionalEffect(effects, 'vector.ensure_doc', () => ctx.ensureDocVectors?.(docId));
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
    if (result.changed) {
      // trust ∈ content_hash → keyword 索引（绑 address+contentHash）按受影响节点同步；向量只绑正文、不受 trust 影响。
      await runOptionalEffect(effects, 'keyword.update_nodes', () => ctx.updateKeywordForNodes?.(docId, result.touchedNodeIds, []));
    }
    const doc = maybeRefreshDoc(store, ctx, docId, payload.refreshOptions || {});
    return docRefresh(action, docId, { ...result, doc, sideEffects: effects });
  }
  if (action === 'history.revert') {
    const commitId = requireId(payload, 'commitId', 'commit_id');
    const result = store.revertCommit({ commitId, owner: payload.owner || 'human', summary: payload.summary ?? null });
    if (result.changed) {
      // 整文档 nodes 经三方调和后整体物化：keyword 全量重建、向量整文档删后补（同 history.restore）。
      await runOptionalEffect(effects, 'keyword.rebuild_doc', () => ctx.rebuildKeywordIndexForDoc?.(result.docId));
      await runOptionalEffect(effects, 'vector.delete_doc', () => ctx.deleteDocVectors?.(result.docId));
      await runOptionalEffect(effects, 'vector.ensure_doc', () => ctx.ensureDocVectors?.(result.docId));
    }
    const doc = maybeRefreshDoc(store, ctx, result.docId, payload.refreshOptions || {});
    return docRefresh(action, result.docId, { ...result, doc, sideEffects: effects });
  }
  throw new Error(`Unhandled database_write action: ${action}`);
}

export async function handleEditorHistoryMutation(store, payload, ctx, action, effects) {
  if (action === 'editorHistory.capture') {
    const docId = requireDocId(payload);
    const token = store.createEditorSnapshotToken(docId);
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
    const token = store.restoreEditorSnapshotToken({ docId, tokenId });
    await runOptionalEffect(effects, 'vector.delete_doc', () => ctx.deleteDocVectors?.(docId));
    await runOptionalEffect(effects, 'vector.ensure_doc', () => ctx.ensureDocVectors?.(docId));
    const doc = maybeRefreshDoc(store, ctx, docId, payload.refreshOptions || {});
    return docRefresh(action, docId, { changed: true, doc, token, sideEffects: effects });
  }

  if (action === 'editorHistory.discard') {
    const tokenIds = Array.isArray(payload.tokenIds) ? payload.tokenIds : [payload.tokenId ?? payload.token_id].filter(Boolean);
    const discarded = store.discardEditorSnapshotTokens(tokenIds);
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
