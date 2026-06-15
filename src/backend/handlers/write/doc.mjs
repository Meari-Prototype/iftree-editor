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
  requireId,
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
    const folderId = requireId(payload, 'folderId', 'folder_id');
    const folder = store.updateDocFolder(folderId, ownPatch(payload));
    return docsRefresh(action, {
      folder: plain(folder),
      folders: store.listDocFolders().map(plain),
      sideEffects: effects
    });
  }

  if (action === 'docFolder.delete') {
    const folderId = requireId(payload, 'folderId', 'folder_id');
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

  if (action === 'doc.setEditMode') {
    const docId = requireDocId(payload);
    const row = store.setDocEditMode(docId, payload.mode ?? payload.editMode ?? payload.edit_mode);
    const doc = payload.includeDoc === false ? plain(row) : maybeRefreshDoc(store, ctx, docId, payload.refreshOptions || {});
    return docRefresh(action, docId, { doc, editMode: row.edit_mode, sideEffects: effects });
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

  if (action === 'editBranch.applyMerge') {
    const result = store.applyThreeWayMerge({
      branchId: payload.branchId ?? payload.branch_id ?? null,
      shadowDocId: payload.shadowDocId ?? payload.shadow_doc_id ?? payload.docId ?? payload.doc_id ?? null,
      baseDocId: payload.baseDocId ?? payload.base_doc_id ?? null,
      owner: payload.owner,
      summary: payload.summary ?? '三方合并',
      resolutions: payload.resolutions ?? null
    });
    if (result.applied && result.changed) {
      // 保存离场只押主数据落库（8-3-2-2）：BM25 按本次受影响节点增量更新（4-6-2），
      // CPU 毫秒级，不整篇重建；向量不随保存生成/重算（4-6-1），但正文已变更与已删除
      // 节点的旧向量行连带删除——就地清陈旧（完整性只会被编辑破坏），库中不存陈旧行，
      // 跨文档检索按已建索引节点即安全；补齐归完整性检验（14-2/15-8-1）。
      await runOptionalEffect(effects, 'keyword.update_nodes', () => (
        ctx.updateKeywordForNodes?.(result.baseDocId, result.touchedNodeIds, result.deletedNodeIds)
      ));
      await runOptionalEffect(effects, 'vector.delete_nodes', () => (
        ctx.deleteVectorsForNodes?.(result.baseDocId, [
          ...(result.vectorStaleNodeIds || []),
          ...(result.deletedNodeIds || [])
        ])
      ));
    }
    const doc = payload.includeDoc === false || !result.applied
      ? null
      : maybeRefreshDoc(store, ctx, result.baseDocId, payload.refreshOptions || {});
    // 受影响节点集只服务索引同步，不进响应（大编辑会把响应撑大）。
    const { touchedNodeIds: _touched, deletedNodeIds: _deleted, vectorStaleNodeIds: _stale, ...resultForResponse } = result;
    return docRefresh(action, result.baseDocId, {
      ...resultForResponse,
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
    // 非快进被前置验证拒绝（blocked/conflicts）→ 未写回，跳过索引同步与 doc 刷新。
    if (result.applied && result.changed) {
      // 同 editBranch.applyMerge：保存离场只押主数据落库，BM25 增量、
      // 向量只清陈旧行（正文变更+删除节点）不生成。
      await runOptionalEffect(effects, 'keyword.update_nodes', () => (
        ctx.updateKeywordForNodes?.(result.baseDocId, result.touchedNodeIds, result.deletedNodeIds)
      ));
      await runOptionalEffect(effects, 'vector.delete_nodes', () => (
        ctx.deleteVectorsForNodes?.(result.baseDocId, [
          ...(result.vectorStaleNodeIds || []),
          ...(result.deletedNodeIds || [])
        ])
      ));
    }
    const doc = payload.includeDoc === false || result.applied === false
      ? null
      : maybeRefreshDoc(store, ctx, result.baseDocId, payload.refreshOptions || {});
    const { touchedNodeIds: _touched, deletedNodeIds: _deleted, vectorStaleNodeIds: _stale, ...resultForResponse } = result;
    return docRefresh(action, result.baseDocId, {
      ...resultForResponse,
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

  // doc.relink：把已导入 doc 重绑到新源文件路径（锚改名/迁移后用，full 档运维动词，
  // projectneed 15-10-4）。只改绑定（meta.sourcePath + source_documents.original_path），
  // 不动正文；source_type 缺省保留原值。
  if (action === 'doc.relink') {
    const docId = requireDocId(payload);
    const sourcePath = String(payload.sourcePath ?? payload.source_path ?? payload.path ?? '').trim();
    if (!sourcePath) throw new Error('doc.relink requires sourcePath');
    const current = store.db.prepare('SELECT source_type FROM source_documents WHERE doc_id = ?').get(docId);
    const sourceType = payload.sourceType ?? payload.source_type ?? current?.source_type ?? 'md';
    const source = store.updateSourceBinding({ docId, sourcePath, sourceType });
    return docsRefresh(action, { docId, source: plain(source), docs: listDocs(store), sideEffects: effects });
  }

  throw new Error(`Unhandled database_write action: ${action}`);
}

// 把 store 返回的 created 树（含写入 id）与原始 payload.nodes（含正文字段）按同构位置拉链成
// [{id,address,text,node_title,node_note}]，供向量与关键字两个增量入口共用。
function zipStreamNodes(srcList, createdList, out = []) {
  const src = Array.isArray(srcList) ? srcList : [];
  const made = Array.isArray(createdList) ? createdList : [];
  for (let i = 0; i < made.length; i += 1) {
    const node = made[i];
    if (!node) continue;
    const s = src[i] || {};
    out.push({
      id: node.id,
      address: node.address,
      text: typeof s.text === 'string' ? s.text : '',
      node_title: s.node_title ?? s.nodeTitle ?? '',
      node_note: s.node_note ?? s.nodeNote ?? ''
    });
    if (Array.isArray(node.children) && node.children.length) {
      zipStreamNodes(s.children, node.children, out);
    }
  }
  return out;
}

// 流式写入（projectneed 4-16）：直接 append，不走 edit branch。
export async function handleStreamMutation(store, payload, ctx, action, effects) {
  if (action === 'stream.bulkBegin') {
    return { ok: true, action, ...store.beginBulkImport(), sideEffects: effects };
  }
  if (action === 'stream.bulkEnd') {
    return { ok: true, action, ...store.endBulkImport(), sideEffects: effects };
  }
  if (action === 'stream.push') {
    const wantVectors = payload.vectors === true || payload.embed === true;
    if (wantVectors && ctx?.isVectorModuleEnabled?.() !== true) {
      // fail-fast：声明启用向量但配置不可用 → 写 SQL 前抛，SQL 一字不写（4-16）。
      throw new Error('stream.push 声明 vectors:true，但向量模块不可用；请检查向量配置，或改为不启用向量。');
    }
    const result = store.pushStreamNodes({
      docId: payload.docId ?? payload.doc_id ?? null,
      title: payload.title ?? null,
      parentId: payload.parentId ?? payload.parent_id ?? null,
      nodes: payload.nodes ?? [],
      idempotencyKey: payload.idempotencyKey ?? payload.idempotency_key ?? null
    });
    if (!result.deduped && Array.isArray(result.created) && result.created.length) {
      const nodes = zipStreamNodes(payload.nodes ?? [], result.created);
      // 首推新建文档时根节点不在推送列表里：补进本批 FTS 行。漏掉它索引行数会
      // 永远比 SQL 少 1，首次关键字查询的就绪比对（ensureKeywordIndexReady）
      // 会把"增量索引"整文档推倒重建。
      if (result.createdRootId) {
        const rootRow = store.db.prepare(
          'SELECT id, doc_id, address, node_title, text, node_note, updated_at FROM nodes WHERE id = ?'
        ).get(result.createdRootId);
        if (rootRow) nodes.unshift(rootRow);
      }
      // FTS 增量入库（默认，CPU 轻量）：写一批 add 一批，立刻可被 find 关键字检索（projectneed 4-16）。
      await runOptionalEffect(effects, 'keyword.add_stream', () => ctx.addStreamKeywords?.(result.docId, nodes));
      // 向量增量（GPU，按 vectors 开关）：推一点算一点，只 embed 这批。
      // 任一索引运行时失败 → runOptionalEffect 记入 sideEffects 不阻塞；调用方停止后同批幂等重补。
      if (wantVectors) {
        await runOptionalEffect(effects, 'vector.embed_stream', () => ctx.embedStreamNodes?.(result.docId, nodes));
      }
    }
    return {
      ok: true,
      action,
      docId: result.docId,
      changed: Boolean(!result.deduped && result.createdCount > 0),
      refresh: { kind: 'doc', docId: result.docId },
      ...result,
      sideEffects: effects
    };
  }
  // 流式文档的可选源文档层（4-16）：文档本体因为太大才分批流式推，源文本与句位
  // spans 在推完后一次挂载。语义与直写导入一致——整体替换该 doc 的
  // source_documents / source_spans / pdf 层；节点句位用流式节点的 source_position
  // + 这里的 nodeIdsBySentenceIndex（句位 → 节点 id，调用方从 stream.push 返回的
  // created 树按推送顺序自建）。
  if (action === 'stream.attachSource') {
    const docId = requireDocId(payload);
    store.saveSourceDocument({
      docId,
      sourcePath: payload.sourcePath ?? payload.source_path ?? null,
      sourceType: payload.sourceType ?? payload.source_type ?? 'md',
      rawMarkdown: payload.rawMarkdown ?? payload.raw_markdown ?? payload.rawText ?? '',
      spans: payload.spans ?? [],
      pdfPages: payload.pdfPages ?? payload.pdf_pages ?? [],
      pdfChars: payload.pdfChars ?? payload.pdf_chars ?? [],
      nodeIdsBySentenceIndex: payload.nodeIdsBySentenceIndex ?? payload.node_ids_by_sentence_index ?? null
    });
    const spanCount = Array.isArray(payload.spans) ? payload.spans.length : 0;
    return docRefresh(action, docId, { spanCount, sideEffects: effects });
  }
  throw new Error(`Unhandled database_write action: ${action}`);
}
