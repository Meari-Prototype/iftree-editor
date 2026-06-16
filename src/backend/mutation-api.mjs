import { handleAxiomMutation, handleRefMutation } from './handlers/write/axiom-ref.mjs';
import { handleDocFolderMutation, handleDocMutation, handleStreamMutation } from './handlers/write/doc.mjs';
import { handleMemoryMutation } from './handlers/write/memory.mjs';
import { handleEditorHistoryMutation, handleHistoryMutation } from './handlers/write/history.mjs';
import { handleNodeMutation } from './handlers/write/node.mjs';
import { plain } from './handlers/write/shared.mjs';
import { editModeMismatchMessage } from './shared.mjs';
import { ENTITY_WRITE_ACTIONS, runEntityWrite, stageEntityWrite } from './entities/write.mjs';
import { NODE_TYPES, NODE_TYPE_LABELS } from '../core/node-model.mjs';

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
  ...ENTITY_WRITE_ACTIONS,
]);

const STABLE_ID_SCHEMA = Object.freeze({
  anyOf: [{ type: 'string' }, { type: 'number' }]
});

const NODE_TYPE_SCHEMA = Object.freeze({
  type: 'string',
  enum: NODE_TYPES,
  description: `节点类型。中文输入请在 db shell/MCP edit payload 中写 node_type，由后端归一为内部码；当前内部码：${NODE_TYPES.join(', ')}；中文标签：${Object.values(NODE_TYPE_LABELS).join(' / ')}。`
});

function normalizeMutationAction(value) {
  const action = String(value || '').trim();
  return ACTIONS.includes(action) ? action : '';
}

function requireStore(store) {
  if (!store?.db) throw new Error('database_write store is not available');
}

export function databaseWriteActions() {
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
      hostAnchor: { type: 'string', description: '宿主原始记录锚（路径+session id），允许悬空' },
      startedAt: { type: 'string', description: '卷起始时间 ISO 8601' },
      endedAt: { type: 'string', description: '卷结束时间 ISO 8601' },
      force: { type: 'boolean', description: 'memory.markDistilled：用户明确指示时跳过冷却期立即触发' },
      sourcePath: { type: 'string' },
      sourceType: { type: 'string' },
      rawMarkdown: { type: 'string' },
      spans: { type: 'array' },
      pdfPages: { type: 'array' },
      pdfChars: { type: 'array' },
      nodeIdsBySentenceIndex: { type: 'object' },
      refreshOptions: { type: 'object' }
    },
    required: ['action']
  };
}

function shouldRouteToEditBranch(action) {
  if (action.startsWith('node.')) return true;
  if (action.startsWith('axiom.')) return true;
  if (action.startsWith('ref.')) return true;
  if (action.startsWith('entity.')) return true;
  return false;
}

// 编辑模式互斥（projectneed 4-16-8）：增量编辑（流式写入）文档拒绝分支编辑/合并；只读文档拒绝一切编辑。
// 流式写入自身（stream.push）的模式校验在 store.pushStreamNodes 内（含首推自建文档）。
function guardEditMode(store, action, payload) {
  if (!(shouldRouteToEditBranch(action) || action.startsWith('editBranch.'))) return;
  const docId = store.docIdForMutationPayload(payload);
  if (!docId) return;
  const mode = store.getDocEditMode(docId);
  if (mode === 'incremental' || mode === 'readonly') {
    throw new Error(editModeMismatchMessage({ docId, current: mode, required: 'full', intent: '编辑分支/合并' }));
  }
}

function requestedEditBranchOwner(payload = {}, ctx = {}) {
  return ctx?.editBranchOwner || payload.editBranchOwner || payload.edit_branch_owner || '';
}

function requestedEditBranchBaseDocId(payload = {}, ctx = {}) {
  return ctx?.editBranchBaseDocId
    ?? payload.editBranchBaseDocId
    ?? payload.edit_branch_base_doc_id
    ?? null;
}

function activeEditBranchForMutation(store, payload = {}) {
  const docId = store.docIdForMutationPayload(payload);
  if (!docId) return null;
  // 无显式 owner 的 mutation = 人类在 GUI 直接编辑，路由到其 owner=human 分支；
  // llm 类写入必带 editBranchOwner（owner=llm:<会话>），不走此无主路径（A5-5 多分支）。
  return store.activeEditBranchForBaseDoc(docId, 'human') || null;
}

function stagedNodeUpdateResult(action, staged) {
  return {
    ok: true,
    action,
    docId: staged.node?.doc_id || staged.node?.docId || staged.branch?.base_doc_id || null,
    changed: Boolean(staged.changed),
    refresh: { kind: 'node', docId: staged.node?.doc_id || staged.branch?.base_doc_id || null, nodeId: staged.node?.id || null },
    node: plain(staged.node),
    editBranch: plain(staged.branch),
    skipDocsRefresh: true
  };
}

function stagedDocResult(action, staged, extras = {}) {
  return {
    ok: true,
    action,
    docId: staged.docId ?? staged.branch?.base_doc_id ?? null,
    changed: Boolean(staged.changed),
    refresh: { kind: 'doc', docId: staged.docId ?? staged.branch?.base_doc_id ?? null },
    editBranch: plain(staged.branch),
    skipDocsRefresh: true,
    ...extras
  };
}

function dispatchEditBranchStage(store, branch, action, payload) {
  if (action.startsWith('entity.')) return stageEntityWrite(store, branch, payload, action);
  switch (action) {
    case 'node.update':
      return stagedNodeUpdateResult(action, store.stageEditBranchNodeUpdate(branch, payload));
    case 'node.insert': {
      const staged = store.stageEditBranchNodeInsert(branch, payload);
      return stagedDocResult(action, staged, {
        insertedNodeId: staged.insertedNodeId,
        node: plain(staged.node)
      });
    }
    case 'node.delete':
      return stagedDocResult(action, store.stageEditBranchNodeDelete(branch, payload));
    case 'node.move':
      return stagedDocResult(action, store.stageEditBranchNodeMove(branch, payload));
    case 'node.promote':
      return stagedDocResult(action, store.stageEditBranchNodePromote(branch, payload));
    case 'node.split':
      return stagedDocResult(action, store.stageEditBranchNodeSplit(branch, payload));
    case 'node.mergeInto':
      return stagedDocResult(action, store.stageEditBranchNodeMergeInto(branch, payload));
    case 'node.mergePrevious':
      return stagedDocResult(action, store.stageEditBranchNodeMergePrevious(branch, payload));
    case 'node.reparent':
      return stagedDocResult(action, store.stageEditBranchNodeReparent(branch, payload));
    case 'node.moveBefore':
      return stagedDocResult(action, store.stageEditBranchNodeMoveBefore(branch, payload));
    case 'node.moveAfter':
      return stagedDocResult(action, store.stageEditBranchNodeMoveAfter(branch, payload));
    case 'axiom.add': {
      const staged = store.stageEditBranchAxiomAdd(branch, payload);
      return stagedDocResult(action, staged, {
        insertedAxiomId: staged.insertedAxiomId,
        axiom: plain(staged.axiom)
      });
    }
    case 'axiom.update': {
      const staged = store.stageEditBranchAxiomUpdate(branch, payload);
      return stagedDocResult(action, staged, { axiom: plain(staged.axiom) });
    }
    case 'axiom.delete':
      return stagedDocResult(action, store.stageEditBranchAxiomDelete(branch, payload));
    case 'axiom.move':
      return stagedDocResult(action, store.stageEditBranchAxiomMove(branch, payload));
    case 'ref.addNodeToNode': {
      const staged = store.stageEditBranchRefAddNodeToNode(branch, payload);
      return stagedDocResult(action, staged, { insertedRefId: staged.insertedRefId });
    }
    case 'ref.addAxiomToNode': {
      const staged = store.stageEditBranchRefAddAxiomToNode(branch, payload);
      return stagedDocResult(action, staged, { insertedRefId: staged.insertedRefId });
    }
    case 'ref.delete':
      return stagedDocResult(action, store.stageEditBranchRefDelete(branch, payload));
    default:
      throw new Error(`Edit branch staging not implemented for action: ${action}`);
  }
}

export async function runDatabaseWrite(store, payload = {}, ctx = {}) {
  const action = normalizeMutationAction(payload.action || payload.type);
  if (!action) throw new Error(`Unknown database_write action: ${payload.action || payload.type || ''}`);
  if (action === 'mutation.actions') return { actions: databaseWriteActions() };
  requireStore(store);
  guardEditMode(store, action, payload);

  const routeOwner = requestedEditBranchOwner(payload, ctx);
  if (routeOwner) {
    if (!shouldRouteToEditBranch(action)) {
      throw new Error(`database_write action cannot be routed to an edit branch: ${action}`);
    }
    const branch = store.beginEditBranch(
      requestedEditBranchBaseDocId(payload, ctx) ?? store.docIdForMutationPayload(payload),
      routeOwner
    );
    return dispatchEditBranchStage(store, branch, action, payload);
  }

  const activeBranch = shouldRouteToEditBranch(action) ? activeEditBranchForMutation(store, payload) : null;
  if (activeBranch) {
    return dispatchEditBranchStage(store, activeBranch, action, payload);
  }

  const effects = [];
  let result = null;
  if (action.startsWith('docFolder.')) result = handleDocFolderMutation(store, payload, action, effects);
  else if (action.startsWith('doc.') || action === 'treeView.update' || action.startsWith('editBranch.')) result = await handleDocMutation(store, payload, ctx, action, effects);
  else if (action.startsWith('node.')) result = await handleNodeMutation(store, payload, ctx, action, effects);
  else if (action.startsWith('axiom.')) result = handleAxiomMutation(store, payload, action, effects);
  else if (action.startsWith('ref.')) result = handleRefMutation(store, payload, action, effects);
  else if (action.startsWith('editorHistory.')) result = await handleEditorHistoryMutation(store, payload, ctx, action, effects);
  else if (action.startsWith('history.')) result = await handleHistoryMutation(store, payload, ctx, action, effects);
  else if (action.startsWith('entity.')) result = runEntityWrite(store, payload, action);
  else if (action.startsWith('stream.')) result = await handleStreamMutation(store, payload, ctx, action, effects);
  else if (action.startsWith('memory.')) result = await handleMemoryMutation(store, payload, ctx, action, effects);
  else throw new Error(`Unhandled database_write action: ${action}`);

  return result;
}
