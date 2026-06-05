import { handleAxiomMutation, handleRefMutation } from './handlers/write/axiom-ref.mjs';
import { handleDocFolderMutation, handleDocMutation } from './handlers/write/doc.mjs';
import { handleEditorHistoryMutation, handleHistoryMutation } from './handlers/write/history.mjs';
import { handleNodeMutation } from './handlers/write/node.mjs';
import { plain } from './handlers/write/shared.mjs';
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
  'editBranch.begin',
  'editBranch.rebase',
  'editBranch.cherryPick',
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
  return store.activeEditBranchForBaseDoc(docId, 'human')
    || store.activeEditBranchForBaseDoc(docId, 'llm')
    || null;
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
    case 'node.reparent':
      return stagedDocResult(action, store.stageEditBranchNodeReparent(branch, payload));
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
  else throw new Error(`Unhandled database_write action: ${action}`);

  return result;
}
