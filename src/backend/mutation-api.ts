import { handleAxiomMutation, handleRefMutation } from './handlers/write/axiom-ref.js';
import { handleDocFolderMutation, handleDocMutation, handleStreamMutation } from './handlers/write/doc.js';
import { handleMemoryMutation } from './memory/index.js';
import { handleEditorHistoryMutation, handleHistoryMutation } from './handlers/write/history.js';
import { handleNodeMutation } from './handlers/write/node.js';
import { plain } from './handlers/write/shared.js';
import { editModeMismatchMessage } from './shared.js';
import { ENTITY_WRITE_ACTIONS, runEntityWrite, stageEntityWrite } from './entities/write.js';
import { NODE_TYPES, NODE_TYPE_LABELS } from '../core/node-model.js';
import type { EditBranchRow } from './db/rows.js';
import type { IftreeStore } from './store/index.js';

const ACTIONS = Object.freeze([
  'mutation.actions',
  'docFolder.create',
  'docFolder.update',
  'docFolder.delete',
  'doc.create',
  'doc.moveToFolder',
  'doc.delete',
  'doc.updateAxiomsCollapsed',
  'doc.setEditMode',
  'doc.relink',
  'stream.push',
  'stream.bulkBegin',
  'stream.bulkEnd',
  'stream.attachSource',
  'memory.deliverVolume',
  'memory.appendSessionTurn',
  'memory.markDistilled',
  'editBranch.begin',
  'editBranch.rebase',
  'editBranch.cherryPick',
  'editBranch.applyMerge',
  'editBranch.save',
  'editBranch.discard',
  'editBranch.undo',
  'editBranch.redo',
  'doc.refreshAddresses',
  'treeView.update',
  'node.insert',
  'node.update',
  'node.delete',
  'node.move',
  'node.promote',
  'node.split',
  'node.mergePrevious',
  'node.mergeInto',
  'node.reparent',
  'node.moveBefore',
  'node.moveAfter',
  'axiom.add',
  'axiom.update',
  'axiom.delete',
  'axiom.move',
  'ref.addNodeToNode',
  'ref.addAxiomToNode',
  'ref.delete',
  'editorHistory.capture',
  'editorHistory.restore',
  'editorHistory.discard',
  'history.save',
  'history.restore',
  'history.certify',
  'history.revert',
  'objects.gc',
  ...ENTITY_WRITE_ACTIONS
]);

const STABLE_ID_SCHEMA = Object.freeze({
  anyOf: [{ type: 'string' }, { type: 'number' }]
});

const NODE_TYPE_SCHEMA = Object.freeze({
  type: 'string',
  enum: NODE_TYPES,
  description: `节点类型。中文输入请在 db shell/MCP edit payload 中写 node_type，由后端归一为内部码；当前内部码：${NODE_TYPES.join(', ')}；中文标签：${Object.values(NODE_TYPE_LABELS).join(' / ')}。`
});

export type MutationPayload = Record<string, unknown>;
export type MutationResult = Record<string, unknown>;
type EffectList = Array<Record<string, unknown>>;

// 写入入口的 store facade：IftreeStore 现在公开方法签名已整体收紧（store/index.ts:188- TailParameters），
// MutationStore 直接 alias 到 IftreeStore，下游 handlers/* 也都用 IftreeStore——8 处 cast 同时清零。
export type MutationStore = IftreeStore;

export interface MutationContext {
  editBranchOwner?: string;
  editBranchBaseDocId?: unknown;
  editBranchId?: unknown;
  refreshDoc?: (docId: unknown, options?: unknown) => unknown;
  maintainDerivedAfterWrite?: (
    docId: unknown,
    options?: Record<string, unknown>
  ) => Promise<unknown> | unknown;
  [extra: string]: unknown;
}

// store.stage* / handlers 写出的 staged/result 形状很零散，这里给一个宽松形状：分发器只读出常用字段。
type StagedShape = {
  node?: Record<string, unknown> | null;
  axiom?: Record<string, unknown> | null;
  branch?: EditBranchRow | null;
  changed?: boolean;
  docId?: unknown;
  insertedNodeId?: unknown;
  insertedAxiomId?: unknown;
  insertedRefId?: unknown;
  [key: string]: unknown;
};

function normalizeMutationAction(value: unknown): string {
  const action = String(value || '').trim();
  return (ACTIONS as readonly string[]).includes(action) ? action : '';
}

function requireStore(store: MutationStore | null | undefined): asserts store is MutationStore {
  if (!store?.db) throw new Error('database_write store is not available');
}

export function databaseWriteActions(): string[] {
  return [...ACTIONS];
}

export function databaseWriteToolSchema() {
  return {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: databaseWriteActions(),
        description: '白名单数据库写动作；不接受裸 SQL。'
      },
      docId: STABLE_ID_SCHEMA,
      nodeId: STABLE_ID_SCHEMA,
      axiomId: STABLE_ID_SCHEMA,
      errorId: STABLE_ID_SCHEMA,
      refId: STABLE_ID_SCHEMA,
      historyId: STABLE_ID_SCHEMA,
      commitId: STABLE_ID_SCHEMA,
      sourceHistoryId: STABLE_ID_SCHEMA,
      sourceBranchId: { type: 'number' },
      targetBranchId: { type: 'number' },
      targetBaseDocId: STABLE_ID_SCHEMA,
      entryId: { type: 'string' },
      entryIndex: { type: 'number' },
      branchId: { type: 'number' },
      shadowDocId: STABLE_ID_SCHEMA,
      baseDocId: STABLE_ID_SCHEMA,
      owner: { type: 'string' },
      editBranchOwner: { type: 'string' },
      targetOwner: { type: 'string' },
      name: { type: 'string' },
      parentId: STABLE_ID_SCHEMA,
      newParentId: STABLE_ID_SCHEMA,
      targetNodeId: STABLE_ID_SCHEMA,
      folderId: { type: 'number' },
      direction: { type: 'string', enum: ['up', 'down'] },
      splitAsciiPunctuation: { type: 'boolean' },
      trust: { type: 'string', enum: ['受控', '不受控'] },
      scope: { type: 'string', enum: ['subtree', 'node'] },
      address: { type: 'string' },
      title: { type: 'string' },
      term: { type: 'string' },
      literal: { type: 'string' },
      entityId: STABLE_ID_SCHEMA,
      sourceEntityId: STABLE_ID_SCHEMA,
      targetEntityId: STABLE_ID_SCHEMA,
      entityIds: { type: 'array', items: STABLE_ID_SCHEMA },
      kind: { type: 'string', enum: ['synonym', 'related'] },
      linkKind: { type: 'string', enum: ['synonym', 'related'] },
      sourceTerm: { type: 'string' },
      targetTerm: { type: 'string' },
      relatedTerm: { type: 'string' },
      rootText: { type: 'string' },
      text: { type: 'string' },
      nodeType: NODE_TYPE_SCHEMA,
      node_type: NODE_TYPE_SCHEMA,
      nodeTitle: { type: 'string' },
      nodeNote: { type: 'string' },
      sourceNodeId: STABLE_ID_SCHEMA,
      targetAddress: { type: 'string' },
      refKind: { type: 'string' },
      note: { type: 'string' },
      tokenId: { type: 'string' },
      tokenIds: { type: 'array', items: { type: 'string' } },
      patch: { type: 'object' },
      state: { type: 'object' },
      items: { type: 'array' },
      positions: { type: 'array' },
      updates: { type: 'array' },
      depthKey: { type: 'string' },
      nodeIds: { type: 'array', items: STABLE_ID_SCHEMA },
      deltaY: { type: 'number' },
      mode: { type: 'string' },
      nodes: { type: 'array' },
      idempotencyKey: { type: 'string' },
      agent: { type: 'string', description: '记忆卷 agent 身份（memory.deliverVolume 必填）' },
      sessionId: { type: 'string', description: '记忆卷 session id（memory.deliverVolume 必填）' },
      hostAnchor: { type: 'string', description: '宿主 session 文件锚（路径#sessionid）；deliverVolume 投递前校验真实存在、不接受悬空（15-10-4）' },
      startedAt: { type: 'string', description: '卷起始时间 ISO 8601' },
      endedAt: { type: 'string', description: '卷结束时间 ISO 8601' },
      force: { type: 'boolean', description: 'memory.markDistilled：用户明确指示时跳过冷却期立即触发' },
      sourcePath: { type: 'string' },
      sourceType: { type: 'string' },
      rawMarkdown: { type: 'string' },
      spans: { type: 'array' },
      pdfPages: { type: 'array' },
      pdfChars: { type: 'array' },
      docBlocks: { type: 'array' },
      nodeIdsBySentenceIndex: { type: 'object' },
      refreshOptions: { type: 'object' }
    },
    required: ['action']
  };
}

function shouldRouteToEditBranch(action: string): boolean {
  if (action.startsWith('node.')) return true;
  if (action.startsWith('axiom.')) return true;
  if (action.startsWith('ref.')) return true;
  if (action.startsWith('entity.')) return true;
  return false;
}

// 编辑模式互斥（projectneed 4-16-8）：增量编辑（流式写入）文档拒绝分支编辑/合并；只读文档拒绝一切编辑。
// 流式写入自身（stream.push）的模式校验在 store.pushStreamNodes 内（含首推自建文档）。
function guardEditMode(store: MutationStore, action: string, payload: MutationPayload): void {
  if (!(shouldRouteToEditBranch(action) || action.startsWith('editBranch.'))) return;
  const docId = store.docIdForMutationPayload(payload);
  if (!docId) return;
  const mode = store.getDocEditMode(docId);
  if (mode === 'incremental' || mode === 'readonly') {
    throw new Error(editModeMismatchMessage({ docId, current: mode, required: 'full', intent: '编辑分支/合并' }));
  }
}

function requestedEditBranchOwner(payload: MutationPayload = {}, ctx: MutationContext = {}): string {
  return String(ctx.editBranchOwner ?? payload.editBranchOwner ?? payload.edit_branch_owner ?? '') || '';
}

function requestedEditBranchBaseDocId(payload: MutationPayload = {}, ctx: MutationContext = {}): unknown {
  return ctx.editBranchBaseDocId
    ?? payload.editBranchBaseDocId
    ?? payload.edit_branch_base_doc_id
    ?? null;
}

function requestedEditBranchId(payload: MutationPayload = {}, ctx: MutationContext = {}): unknown {
  return ctx.editBranchId ?? payload.editBranchId ?? payload.edit_branch_id ?? null;
}

function activeEditBranchForMutation(store: MutationStore, payload: MutationPayload = {}): EditBranchRow | null {
  const docId = store.docIdForMutationPayload(payload);
  if (!docId) return null;
  // 无显式 owner 的 mutation = 人类在 GUI 直接编辑，路由到其 owner=human 分支；
  // llm 类写入必带 editBranchOwner（owner=llm:<会话>），不走此无主路径（A5-5 多分支）。
  return (store.activeEditBranchForBaseDoc(docId, 'human') as EditBranchRow | null) || null;
}

function stagedNodeUpdateResult(action: string, staged: StagedShape): MutationResult {
  const docId = (staged.node?.doc_id as unknown)
    ?? (staged.node?.docId as unknown)
    ?? staged.branch?.base_doc_id
    ?? null;
  return {
    ok: true,
    action,
    docId,
    changed: Boolean(staged.changed),
    refresh: { kind: 'node', docId, nodeId: (staged.node?.id as unknown) ?? null },
    node: plain(staged.node),
    editBranch: plain(staged.branch),
    skipDocsRefresh: true
  };
}

const STAGED_DETAIL_KEYS = [
  'nodeId',
  'sourceNodeId',
  'targetNodeId',
  'newParentId',
  'axiomId',
  'refId',
  'entityId',
  'entityIds',
  'kind',
  'status',
  'direction'
] as const;

function stagedDetails(staged: StagedShape = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of STAGED_DETAIL_KEYS) {
    if (staged[key] !== undefined) out[key] = staged[key];
  }
  return out;
}

function stagedDocResult(action: string, staged: StagedShape, extras: Record<string, unknown> = {}): MutationResult {
  const docId = staged.docId ?? staged.branch?.base_doc_id ?? null;
  return {
    ok: true,
    action,
    docId,
    changed: Boolean(staged.changed),
    refresh: { kind: 'doc', docId },
    editBranch: plain(staged.branch),
    skipDocsRefresh: true,
    ...stagedDetails(staged),
    ...extras
  };
}

function dispatchEditBranchStage(
  store: MutationStore,
  branch: EditBranchRow,
  action: string,
  payload: MutationPayload
): MutationResult {
  if (action.startsWith('entity.')) return stageEntityWrite(store, branch, payload, action) as unknown as MutationResult;
  switch (action) {
    case 'node.update':
      return stagedNodeUpdateResult(action, store.stageEditBranchNodeUpdate(branch, payload) as StagedShape);
    case 'node.insert': {
      const staged = store.stageEditBranchNodeInsert(branch, payload) as StagedShape;
      return stagedDocResult(action, staged, {
        insertedNodeId: staged.insertedNodeId,
        node: plain(staged.node)
      });
    }
    case 'node.delete':
      return stagedDocResult(action, store.stageEditBranchNodeDelete(branch, payload) as StagedShape);
    case 'node.move':
      return stagedDocResult(action, store.stageEditBranchNodeMove(branch, payload) as StagedShape);
    case 'node.promote':
      return stagedDocResult(action, store.stageEditBranchNodePromote(branch, payload) as StagedShape);
    case 'node.split':
      return stagedDocResult(action, store.stageEditBranchNodeSplit(branch, payload) as StagedShape);
    case 'node.mergeInto':
      return stagedDocResult(action, store.stageEditBranchNodeMergeInto(branch, payload) as StagedShape);
    case 'node.mergePrevious':
      return stagedDocResult(action, store.stageEditBranchNodeMergePrevious(branch, payload) as StagedShape);
    case 'node.reparent':
      return stagedDocResult(action, store.stageEditBranchNodeReparent(branch, payload) as StagedShape);
    case 'node.moveBefore':
      return stagedDocResult(action, store.stageEditBranchNodeMoveBefore(branch, payload) as StagedShape);
    case 'node.moveAfter':
      return stagedDocResult(action, store.stageEditBranchNodeMoveAfter(branch, payload) as StagedShape);
    case 'axiom.add': {
      const staged = store.stageEditBranchAxiomAdd(branch, payload) as StagedShape;
      return stagedDocResult(action, staged, {
        insertedAxiomId: staged.insertedAxiomId,
        axiom: plain(staged.axiom)
      });
    }
    case 'axiom.update': {
      const staged = store.stageEditBranchAxiomUpdate(branch, payload) as StagedShape;
      return stagedDocResult(action, staged, { axiom: plain(staged.axiom) });
    }
    case 'axiom.delete':
      return stagedDocResult(action, store.stageEditBranchAxiomDelete(branch, payload) as StagedShape);
    case 'axiom.move':
      return stagedDocResult(action, store.stageEditBranchAxiomMove(branch, payload) as StagedShape);
    case 'ref.addNodeToNode': {
      const staged = store.stageEditBranchRefAddNodeToNode(branch, payload) as StagedShape;
      return stagedDocResult(action, staged, { insertedRefId: staged.insertedRefId });
    }
    case 'ref.addAxiomToNode': {
      const staged = store.stageEditBranchRefAddAxiomToNode(branch, payload) as StagedShape;
      return stagedDocResult(action, staged, { insertedRefId: staged.insertedRefId });
    }
    case 'ref.delete':
      return stagedDocResult(action, store.stageEditBranchRefDelete(branch, payload) as StagedShape);
    default:
      throw new Error(`Edit branch staging not implemented for action: ${action}`);
  }
}

// 写操作落主库后需要重建 BM25 关键词的动作（直写主库的内容/结构变更；编辑分支 staging 不到这里、
// 在上方提前 return）。稠密向量零耦合、不在此维护。doc.delete / doc.refreshAddresses 形态特殊，
// 单独分支处理。stream.*（批量导入）不逐条维护、避免 O(N²)，由导入收尾统一处理。
const KEYWORD_REBUILD_ACTIONS = new Set([
  'node.insert', 'node.update', 'node.delete', 'node.move', 'node.promote', 'node.split',
  'node.mergePrevious', 'node.mergeInto', 'node.reparent', 'node.moveBefore', 'node.moveAfter',
  'doc.create', 'editBranch.save', 'editBranch.applyMerge',
  'history.restore', 'history.revert', 'history.certify', 'editorHistory.restore'
]);

// 写分发收尾的派生索引维护：主库只报告"哪篇文档怎么变了"，怎么维护派生索引交给向量模块
// （ctx.maintainDerivedAfterWrite）。失败不阻塞写返回——关键词可重建、检索入口有缺失补建兜底。
async function maintainDerivedIndexAfterWrite(
  ctx: MutationContext | undefined,
  store: MutationStore,
  action: string,
  result: MutationResult | null
): Promise<void> {
  if (typeof ctx?.maintainDerivedAfterWrite !== 'function') return;
  if (!result || result.changed === false || result.applied === false) return;
  try {
    if (action === 'stream.bulkEnd') {
      // 批量导入结束：对本批写过的每篇文档统一维护一次（BM25 整篇重建；embed 决定建不建向量）。
      const touched = Array.isArray(result.touchedDocIds) ? result.touchedDocIds : [];
      for (const docId of touched) {
        await ctx.maintainDerivedAfterWrite(docId, { embed: result.embed === true });
      }
      // 导入写了大量 lance 行、碎片增量大：按文档数累加脏度，触发后台回收（O(1) 计数，不阻塞写返回）。
      store?.maintenance?.markDirty?.(touched.length || 1);
      return;
    }
    if (action === 'stream.push') {
      // bulk 中：失活累积、留 bulkEnd 统一维护；非 bulk 单推：当场维护该文档。
      if (store?.hasActiveBulkImport?.()) return;
      if (result.docId) await ctx.maintainDerivedAfterWrite(result.docId, { embed: result.embed === true });
      return;
    }
    const docId = result.docId ?? result.baseDocId ?? null;
    if (action === 'doc.delete') {
      if (docId) await ctx.maintainDerivedAfterWrite(docId, { deleted: true });
    } else if (action === 'doc.refreshAddresses') {
      await ctx.maintainDerivedAfterWrite(docId || null, { allDocs: !docId });
    } else if (KEYWORD_REBUILD_ACTIONS.has(action) && docId) {
      // merge/save 带 derivedSync（受影响节点集）→ BM25 增量同步；其余（doc.create/history.* 无 hint）整篇重建。
      const sync = result.derivedSync as { touchedNodeIds?: unknown; deletedNodeIds?: unknown } | null;
      await ctx.maintainDerivedAfterWrite(docId, sync
        ? { touchedNodeIds: sync.touchedNodeIds, deletedNodeIds: sync.deletedNodeIds }
        : {});
      // 派生写产生 lance 碎片，计一次脏度（O(1)），由后台调度器低频回收。
      store?.maintenance?.markDirty?.();
    }
  } catch (error) {
    if (Array.isArray(result.sideEffects)) {
      result.sideEffects.push({
        effect: 'derived.maintain',
        ok: false,
        error: (error as { message?: string } | null | undefined)?.message || String(error)
      });
    }
  }
}

export async function runDatabaseWrite(
  store: MutationStore,
  payload: MutationPayload = {},
  ctx: MutationContext = {}
): Promise<MutationResult> {
  const action = normalizeMutationAction(payload.action || payload.type);
  if (!action) throw new Error(`Unknown database_write action: ${payload.action || payload.type || ''}`);
  if (action === 'mutation.actions') return { actions: databaseWriteActions() };
  requireStore(store);
  // 对象库 GC（运维动词）：不针对某文档、不进 edit branch、不受编辑模式约束——在分支路由前直接处理。
  if (action === 'objects.gc') return { ok: true, action, ...store.gcHistoryObjects() };
  guardEditMode(store, action, payload);

  const routeOwner = requestedEditBranchOwner(payload, ctx);
  if (routeOwner) {
    if (!shouldRouteToEditBranch(action)) {
      throw new Error(`database_write action cannot be routed to an edit branch: ${action}`);
    }
    // 显式 branchId 精确定位（多草稿并存时不靠 (baseDocId, owner) 唯一性）；缺省回退 beginEditBranch 的找/建。
    const routeBranchId = requestedEditBranchId(payload, ctx);
    const branch = routeBranchId != null
      ? (store.findEditBranch({ branchId: routeBranchId }) as EditBranchRow | null)
      : (store.beginEditBranch(
          requestedEditBranchBaseDocId(payload, ctx) ?? store.docIdForMutationPayload(payload),
          routeOwner
        ) as EditBranchRow | null);
    if (!branch) throw new Error(`edit branch not found: branchId=${routeBranchId}`);
    return dispatchEditBranchStage(store, branch, action, payload);
  }

  const activeBranch = shouldRouteToEditBranch(action) ? activeEditBranchForMutation(store, payload) : null;
  if (activeBranch) {
    return dispatchEditBranchStage(store, activeBranch, action, payload);
  }

  const effects: EffectList = [];
  let result: MutationResult | null = null;
  // store / ctx 直传：MutationStore 现在是 IftreeStore alias，handlers/* 也都签 IftreeStore + WriteContext，
  // 不再需要每处 `as unknown as Parameters<...>[0]` 中转。
  if (action.startsWith('docFolder.')) result = handleDocFolderMutation(store, payload, action, effects) as MutationResult;
  else if (action.startsWith('doc.') || action === 'treeView.update' || action.startsWith('editBranch.')) result = await handleDocMutation(store, payload, ctx, action, effects) as MutationResult;
  else if (action.startsWith('node.')) result = await handleNodeMutation(store, payload, ctx, action, effects) as MutationResult;
  else if (action.startsWith('axiom.')) result = handleAxiomMutation(store, payload, action, effects) as MutationResult;
  else if (action.startsWith('ref.')) result = handleRefMutation(store, payload, action, effects) as MutationResult;
  else if (action.startsWith('editorHistory.')) result = await handleEditorHistoryMutation(store, payload, ctx, action, effects) as MutationResult;
  else if (action.startsWith('history.')) result = await handleHistoryMutation(store, payload, ctx, action, effects) as MutationResult;
  else if (action.startsWith('entity.')) result = runEntityWrite(store, payload, action) as unknown as MutationResult;
  else if (action.startsWith('stream.')) result = await handleStreamMutation(store, payload, ctx, action, effects) as MutationResult;
  else if (action.startsWith('memory.')) result = await handleMemoryMutation(store, payload, ctx, action, effects) as MutationResult;
  else throw new Error(`Unhandled database_write action: ${action}`);

  // 派生索引维护（BM25 增量 / 碎片回收）对 KEYWORD_REBUILD_ACTIONS 后台执行——
  // 避免 merge/save 等大文档操作的维护耗时阻塞写返回、超出 MCP 客户端超时窗口
  // （主库事务已提交，客户端不知成功会重试 → 幂等灾难）。维护失败非致命：关键词
  // 可重建、检索入口有缺失补建兜底。stream/delete/refreshAddresses 保持同步。
  if (KEYWORD_REBUILD_ACTIONS.has(action)) {
    maintainDerivedIndexAfterWrite(ctx, store, action, result).catch(() => {});
  } else {
    await maintainDerivedIndexAfterWrite(ctx, store, action, result);
  }
  // derivedSync 是给派生索引维护的内部 hint（merge/save 的受影响节点集），不进响应。
  // fire-and-forget 路径：maintainDerivedIndexAfterWrite 在首个 await 前同步读取了
  // derivedSync，此处删除不竞争。
  if (result && typeof result === 'object' && 'derivedSync' in result) delete (result as Record<string, unknown>).derivedSync;
  return result ?? {};
}
