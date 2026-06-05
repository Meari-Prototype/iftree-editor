import {
  normalizeStableId
} from '../../db/ids.mjs';
import {
  docRefresh,
  docsRefresh,
  listDocs,
  maybeRefreshDoc,
  ownPatch,
  plain,
  requireDocId,
  requirePositiveId,
  runOptionalEffect
} from './shared.mjs';

export function handleDocFolderMutation(store, payload, action, effects) {
  if (action === 'docFolder.create') {
    const name = String(payload.name || '').trim();
    if (!name) throw new Error('docFolder.create requires name');
    const folder = store.createDocFolder({
      name,
      parentId: payload.parentId ?? payload.parent_id ?? null
    });
    return docsRefresh(action, {
      folder: plain(folder),
      folders: store.listDocFolders().map(plain),
      sideEffects: effects
    });
  }

  if (action === 'docFolder.update') {
    const folderId = requirePositiveId(payload, 'folderId', 'folder_id');
    const folder = store.updateDocFolder(folderId, ownPatch(payload));
    return docsRefresh(action, {
      folder: plain(folder),
      folders: store.listDocFolders().map(plain),
      sideEffects: effects
    });
  }

  if (action === 'docFolder.delete') {
    const folderId = requirePositiveId(payload, 'folderId', 'folder_id');
    const changed = store.deleteDocFolder(folderId);
    return docsRefresh(action, {
      folderId,
      changed: Boolean(changed),
      folders: store.listDocFolders().map(plain),
      sideEffects: effects
    });
  }

  throw new Error(`Unhandled database_write action: ${action}`);
}

export async function handleDocMutation(store, payload, ctx, action, effects) {
  if (action === 'doc.create') {
    const title = String(payload.title || '').trim();
    if (!title) throw new Error('doc.create requires title');
    const created = store.createDoc({
      title,
      rootText: payload.rootText ?? payload.root_text ?? title,
      meta: payload.meta ?? null,
      folderId: payload.folderId ?? payload.folder_id ?? null
    });
    await runOptionalEffect(effects, 'keyword.rebuild_doc', () => ctx.rebuildKeywordIndexForDoc?.(created.id));
    const doc = maybeRefreshDoc(store, ctx, created.id, payload.refreshOptions || {});
    return docRefresh(action, created.id, { doc, created: plain(created), sideEffects: effects });
  }

  if (action === 'doc.moveToFolder') {
    const docId = requireDocId(payload);
    const changed = store.moveDocToFolder({
      docId,
      folderId: payload.folderId ?? payload.folder_id ?? null
    });
    return docsRefresh(action, { docId, changed: Boolean(changed), docs: listDocs(store), sideEffects: effects });
  }

  if (action === 'doc.delete') {
    const docId = requireDocId(payload);
    const changed = store.deleteDoc(docId);
    if (changed) {
      await runOptionalEffect(effects, 'vector.delete_doc', () => ctx.deleteDocVectors?.(docId));
      await runOptionalEffect(effects, 'keyword.delete_doc', () => ctx.deleteKeywordDoc?.(docId));
    }
    return docsRefresh(action, { docId, changed: Boolean(changed), docs: listDocs(store), sideEffects: effects });
  }

  if (action === 'doc.updateAxiomsCollapsed') {
    const docId = requireDocId(payload);
    const row = store.updateDocAxiomsCollapsed(docId, payload.collapsed);
    const doc = payload.includeDoc === false ? plain(row) : maybeRefreshDoc(store, ctx, docId, payload.refreshOptions || {});
    return docRefresh(action, docId, { doc, sideEffects: effects });
  }

  if (action === 'editBranch.begin') {
    const docId = requireDocId(payload);
    const branch = store.beginEditBranch(docId, payload.owner);
    const doc = payload.includeDoc === false ? null : maybeRefreshDoc(store, ctx, branch.shadow_doc_id, payload.refreshOptions || {});
    return docRefresh(action, branch.shadow_doc_id, {
      baseDocId: branch.base_doc_id,
      shadowDocId: branch.shadow_doc_id,
      branch: plain(branch),
      doc,
      sideEffects: effects
    });
  }

  if (action === 'editBranch.rebase') {
    const result = store.rebaseEditBranch({
      branchId: payload.branchId ?? payload.branch_id ?? null,
      shadowDocId: payload.shadowDocId ?? payload.shadow_doc_id ?? payload.docId ?? payload.doc_id ?? null,
      baseDocId: payload.baseDocId ?? payload.base_doc_id ?? null,
      owner: payload.owner
    });
    const doc = payload.includeDoc === false
      ? null
      : maybeRefreshDoc(store, ctx, result.branch.base_doc_id, payload.refreshOptions || {});
    return docRefresh(action, result.branch.base_doc_id, {
      changed: Boolean(result.changed),
      baseDocId: result.branch.base_doc_id,
      shadowDocId: result.branch.shadow_doc_id,
      branchId: result.branch.id,
      owner: result.branch.owner,
      baseCommitId: result.baseCommitId,
      branch: plain(result.branch),
      undoDepth: result.undoDepth,
      redoDepth: result.redoDepth,
      doc,
      sideEffects: effects
    });
  }

  if (action === 'editBranch.cherryPick') {
    const result = store.cherryPickEditBranchEntries({
      sourceHistoryId: payload.sourceHistoryId ?? payload.source_history_id ?? payload.historyId ?? payload.history_id ?? null,
      sourceBranchId: payload.sourceBranchId ?? payload.source_branch_id ?? null,
      targetBranchId: payload.targetBranchId ?? payload.target_branch_id ?? payload.branchId ?? payload.branch_id ?? null,
      targetBaseDocId: payload.targetBaseDocId ?? payload.target_base_doc_id ?? payload.baseDocId ?? payload.base_doc_id ?? payload.docId ?? payload.doc_id ?? null,
      targetOwner: payload.targetOwner ?? payload.target_owner ?? payload.owner ?? 'human',
      entryId: payload.entryId ?? payload.entry_id ?? null,
      entryIndex: payload.entryIndex ?? payload.entry_index ?? null
    });
    const doc = payload.includeDoc === false
      ? null
      : maybeRefreshDoc(store, ctx, result.baseDocId, payload.refreshOptions || {});
    return docRefresh(action, result.baseDocId, {
      changed: Boolean(result.changed),
      baseDocId: result.baseDocId,
      branchId: result.branchId,
      owner: result.owner,
      pickedCount: result.pickedCount,
      branch: plain(result.branch),
      picked: result.picked,
      doc,
      sideEffects: effects
    });
  }

  if (action === 'editBranch.save') {
    const result = store.saveEditBranch({
      branchId: payload.branchId ?? payload.branch_id ?? null,
      shadowDocId: payload.shadowDocId ?? payload.shadow_doc_id ?? payload.docId ?? payload.doc_id ?? null,
      baseDocId: payload.baseDocId ?? payload.base_doc_id ?? null,
      owner: payload.owner,
      summary: payload.summary || '保存编辑分支'
    });
    await runOptionalEffect(effects, 'vector.delete_doc', () => ctx.deleteDocVectors?.(result.baseDocId));
    await runOptionalEffect(effects, 'vector.ensure_doc', () => ctx.ensureDocVectors?.(result.baseDocId));
    await runOptionalEffect(effects, 'keyword.rebuild_doc', () => ctx.rebuildKeywordIndexForDoc?.(result.baseDocId));
    const doc = payload.includeDoc === false ? null : maybeRefreshDoc(store, ctx, result.baseDocId, payload.refreshOptions || {});
    return docRefresh(action, result.baseDocId, {
      ...result,
      history: plain(result.history),
      doc,
      sideEffects: effects
    });
  }

  if (action === 'editBranch.discard') {
    const branch = store.findEditBranch({
      branchId: payload.branchId ?? payload.branch_id ?? null,
      shadowDocId: payload.shadowDocId ?? payload.shadow_doc_id ?? payload.docId ?? payload.doc_id ?? null,
      baseDocId: payload.baseDocId ?? payload.base_doc_id ?? null,
      owner: payload.owner
    });
    const changed = store.discardEditBranch({
      branchId: payload.branchId ?? payload.branch_id ?? null,
      shadowDocId: payload.shadowDocId ?? payload.shadow_doc_id ?? payload.docId ?? payload.doc_id ?? null,
      baseDocId: payload.baseDocId ?? payload.base_doc_id ?? null,
      owner: payload.owner
    });
    const doc = payload.includeDoc === false
      ? null
      : (branch?.base_doc_id ? maybeRefreshDoc(store, ctx, branch.base_doc_id, payload.refreshOptions || {}) : null);
    return {
      ok: true,
      action,
      docId: branch?.base_doc_id ?? null,
      changed: Boolean(changed),
      refresh: { kind: 'doc', docId: branch?.base_doc_id ?? null },
      baseDocId: branch?.base_doc_id ?? null,
      shadowDocId: branch?.shadow_doc_id ?? null,
      doc,
      sideEffects: effects
    };
  }

  if (action === 'editBranch.undo' || action === 'editBranch.redo') {
    const run = action === 'editBranch.undo'
      ? store.undoEditBranchEntry.bind(store)
      : store.redoEditBranchEntry.bind(store);
    const result = run({
      branchId: payload.branchId ?? payload.branch_id ?? null,
      shadowDocId: payload.shadowDocId ?? payload.shadow_doc_id ?? payload.docId ?? payload.doc_id ?? null,
      baseDocId: payload.baseDocId ?? payload.base_doc_id ?? null,
      owner: payload.owner
    });
    const doc = payload.includeDoc === false
      ? null
      : maybeRefreshDoc(store, ctx, result.branch.base_doc_id, payload.refreshOptions || {});
    return docRefresh(action, result.branch.base_doc_id, {
      changed: Boolean(result.changed),
      baseDocId: result.branch.base_doc_id,
      shadowDocId: result.branch.shadow_doc_id,
      branchId: result.branch.id,
      owner: result.branch.owner,
      branch: plain(result.branch),
      undoDepth: result.undoDepth,
      redoDepth: result.redoDepth,
      doc,
      sideEffects: effects
    });
  }

  if (action === 'doc.refreshAddresses') {
    const rawDocId = payload.docId ?? payload.doc_id;
    const docId = normalizeStableId(rawDocId);
    if (docId) {
      const result = store.refreshDocAddresses(docId);
      await runOptionalEffect(effects, 'keyword.rebuild_doc', () => ctx.rebuildKeywordIndexForDoc?.(docId));
      return docRefresh(action, docId, { result: plain(result), sideEffects: effects });
    }
    const result = store.refreshAllAddresses();
    await runOptionalEffect(effects, 'keyword.rebuild_all_docs', () => ctx.rebuildKeywordIndexForAllDocs?.());
    return docsRefresh(action, { result: plain(result), sideEffects: effects });
  }

  if (action === 'treeView.update') {
    const docId = requireDocId(payload);
    const doc = store.updateDocTreeViewState(docId, payload.state || {});
    return {
      ok: true,
      action,
      docId,
      changed: true,
      refresh: { kind: 'doc_state', docId },
      doc: plain(doc),
      sideEffects: effects
    };
  }

  throw new Error(`Unhandled database_write action: ${action}`);
}
