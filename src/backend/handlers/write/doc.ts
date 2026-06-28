import { existsSync } from 'node:fs';

import {
  normalizeStableId
} from '../../db/ids.js';
import {
  docRefresh,
  docsRefresh,
  listDocs,
  maybeRefreshDoc,
  ownPatch,
  plain,
  requireDocId,
  requireId,
  type WriteContext
} from './shared.js';
import type { IftreeStore } from '../../store/index.js';

type WritePayload = Record<string, unknown>;

export function handleDocFolderMutation(store: IftreeStore, payload: WritePayload, action: string, effects: unknown[]) {
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

export async function handleDocMutation(store: IftreeStore, payload: WritePayload, ctx: WriteContext, action: string, effects: unknown[]) {
  if (action === 'doc.create') {
    const title = String(payload.title || '').trim();
    if (!title) throw new Error('doc.create requires title');
    const created = store.createDoc({
      title,
      rootText: payload.rootText ?? payload.root_text ?? title,
      meta: payload.meta ?? null,
      folderId: payload.folderId ?? payload.folder_id ?? null
    });
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
    if (!row) throw new Error(`doc.setEditMode: doc not found: ${docId}`);
    const doc = payload.includeDoc === false ? plain(row) : maybeRefreshDoc(store, ctx, docId, payload.refreshOptions || {});
    return docRefresh(action, docId, { doc, editMode: row.edit_mode, sideEffects: effects });
  }

  if (action === 'editBranch.begin') {
    const docId = requireDocId(payload);
    const branch = store.beginEditBranch(docId, payload.owner, { fresh: payload.fresh === true });
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
      resolutions: payload.resolutions ?? null,
      strategy: payload.strategy ?? null
    });
    const doc = payload.includeDoc === false || !result.applied
      ? null
      : maybeRefreshDoc(store, ctx, result.baseDocId, payload.refreshOptions || {});
    // 派生索引不在 handler 维护：落主干后由写分发收尾维护。touched/deleted/vectorStale 不进响应
    //（大编辑会撑大），但要传到维护层做 BM25 增量同步（4-6-2）：收进 derivedSync，由 mutation-api 读后剥离。
    // applyThreeWayMerge 是判别联合（applied=false 的 blocked/conflicts variant 没有 touched 字段），
    // destructure 给默认值兼容。
    const { touchedNodeIds = [], deletedNodeIds = [], vectorStaleNodeIds = [], ...resultForResponse }
      = result as Record<string, unknown>;
    return docRefresh(action, result.baseDocId, {
      ...resultForResponse,
      doc,
      sideEffects: effects,
      derivedSync: { touchedNodeIds, deletedNodeIds, vectorStaleNodeIds }
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
    // 非快进被前置验证拒绝（blocked/conflicts）→ applied:false、未写回，下面跳过 doc 刷新。
    const doc = payload.includeDoc === false || result.applied === false
      ? null
      : maybeRefreshDoc(store, ctx, result.baseDocId, payload.refreshOptions || {});
    // 派生索引不在 handler 维护：落主干后由写分发收尾维护。touched/deleted/vectorStale 不进响应，
    // 收进 derivedSync 供 mutation-api 做 BM25 增量同步、读后剥离（4-6-2）。
    // saveEditBranch（=applyThreeWayMerge）是判别联合，blocked/conflicts variant 没 touched/history。
    const { touchedNodeIds = [], deletedNodeIds = [], vectorStaleNodeIds = [], history: resultHistory = null, ...resultForResponse }
      = result as Record<string, unknown>;
    return docRefresh(action, result.baseDocId, {
      ...resultForResponse,
      history: plain(resultHistory),
      doc,
      sideEffects: effects,
      derivedSync: { touchedNodeIds, deletedNodeIds, vectorStaleNodeIds }
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
      return docRefresh(action, docId, { result: plain(result), sideEffects: effects });
    }
    const result = store.refreshAllAddresses();
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
    const current = store.db!.prepare('SELECT source_type FROM source_documents WHERE doc_id = ?').get(docId);
    const sourceType = payload.sourceType ?? payload.source_type ?? current?.source_type ?? 'md';
    const source = store.updateSourceBinding({ docId, sourcePath, sourceType });
    // 目标文件自检（不阻断）：relink 只改登记、不替外部程序维护其文件状态；但顺手报一句目标在不在，
    // 免得静默绑到不存在的路径。结果进 sideEffects，写入照常成功。
    effects.push({ effect: 'relink.targetCheck', ok: true, targetExists: existsSync(sourcePath), sourcePath });
    return docsRefresh(action, { docId, source: plain(source), docs: listDocs(store), sideEffects: effects });
  }

  throw new Error(`Unhandled database_write action: ${action}`);
}

// 流式写入（projectneed 4-16）：直接 append，不走 edit branch。
export async function handleStreamMutation(store: IftreeStore, payload: WritePayload, ctx: WriteContext, action: string, effects: unknown[]) {
  if (action === 'stream.bulkBegin') {
    // store.beginBulkImport() 已经返回 { ok: true, ... }——spread 即可，不再前置 ok:true 避免重复键。
    return { action, ...store.beginBulkImport(), sideEffects: effects };
  }
  if (action === 'stream.bulkEnd') {
    // endBulkImport 返回本批写过的文档；连同 embed 意图交给写分发收尾统一维护派生索引
    //（bulk 期间一路失活不逐批维护，避免 O(N²)）。
    return { action, ...store.endBulkImport(), embed: payload.embed === true, sideEffects: effects };
  }
  if (action === 'stream.push') {
    // 同步建向量统一用 embed（与 import 一名到底）；vectors 是旧名，传了直接报错、别静默不建。
    if (payload.vectors !== undefined) throw new Error('stream.push 用 embed 表示同步建向量，不再接受 vectors 参数。');
    // 首推新建守卫：push 省略 docId 会新建无源文件锚的文档，library_index 按文件系统匹配找不到它。
    // 要往库里新增文档请用 import（自动建锚）；要往已有文档追加内容请传 docId。记忆卷投递（memory_deliver /
    // appendSessionTurn）自己建卷后带 docId 调进来，不受此守卫影响。
    const resolvedDocId = payload.docId ?? payload.doc_id ?? null;
    if (resolvedDocId == null || resolvedDocId === '') {
      throw new Error('push 不允许省略 docId 新建文档（新建的文档无源文件锚，library_index 不可见）。要新增文档请用 import；要往已有文档追加内容请传 docId。');
    }
    // embed:true 的 fail-fast：声明建向量但模块不可用 → 写 SQL 前抛（4-16）。向量不在 push 当场建，
    // 由导入收尾（bulkEnd）按 embed 统一建；派生索引一律不在 push 逐批维护，避免流式百万级 O(N²)。
    if (payload.embed === true && ctx?.isVectorModuleEnabled?.() !== true) {
      throw new Error('stream.push 声明 embed:true，但向量模块不可用；请检查向量配置，或改为不启用向量。');
    }
    const result = store.pushStreamNodes({
      docId: resolvedDocId,
      title: payload.title ?? null,
      parentId: payload.parentId ?? payload.parent_id ?? null,
      nodes: payload.nodes ?? [],
      idempotencyKey: payload.idempotencyKey ?? payload.idempotency_key ?? null
    });
    // pushStreamNodes 是 StreamPushResult | { deduped: true; ... }（幂等缓存命中走 deduped 分支，
    // 无 createdCount 等）。统一用 Record 视图取字段、给默认值兼容两个 variant。
    const r = result as Record<string, unknown>;
    const returnedDocId = r.docId ?? resolvedDocId;
    const createdCount = typeof r.createdCount === 'number' ? r.createdCount : 0;
    const deduped = r.deduped === true;
    return {
      ok: true,
      action,
      ...r,
      docId: returnedDocId,
      changed: Boolean(!deduped && createdCount > 0),
      refresh: { kind: 'doc', docId: returnedDocId },
      embed: payload.embed === true,
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
      docBlocks: payload.docBlocks ?? payload.doc_blocks ?? [],
      // payload.nodeIdsBySentenceIndex 是 unknown，运行时是 Map / Array / Record（saveSourceDocument
      // 内部 instanceof + Array.isArray 守卫），cast 到 SourceNodeMap 一次性收紧。
      nodeIdsBySentenceIndex: (payload.nodeIdsBySentenceIndex ?? payload.node_ids_by_sentence_index ?? null) as Parameters<typeof store.saveSourceDocument>[0]['nodeIdsBySentenceIndex']
    });
    const spanCount = Array.isArray(payload.spans) ? payload.spans.length : 0;
    return docRefresh(action, docId, { spanCount, sideEffects: effects });
  }
  throw new Error(`Unhandled database_write action: ${action}`);
}
