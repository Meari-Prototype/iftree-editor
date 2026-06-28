import {
  docRefresh,
  maybeRefreshDoc,
  nodeRefresh,
  ownPatch,
  plain,
  requireDocId,
  requireId,
  rowById,
  type WriteContext
} from './shared.js';
import type { IftreeStore } from '../../store/index.js';

type WritePayload = Record<string, unknown>;
type EffectList = Array<Record<string, unknown>>;

type NodeMutationStore = IftreeStore;
type NodeMutationContext = WriteContext;

function hasTrustField(source: unknown = {}): boolean {
  return ['trust_level', 'trustLevel', 'trust'].some((key) => (
    Object.prototype.hasOwnProperty.call(source || {}, key)
  ));
}

function assertNoNodeTrustField(source: unknown = {}, context = 'node mutation'): void {
  if (hasTrustField(source)) {
    throw new Error(`${context} no longer supports trust_level; use human certify to set trust_level`);
  }
}

function nodeInsertPayload(payload: WritePayload = {}): WritePayload {
  assertNoNodeTrustField(payload, 'node.insert payload');
  return {
    ...payload,
    docId: payload.docId ?? payload.doc_id,
    parentId: payload.parentId ?? payload.parent_id ?? null,
    afterNodeId: payload.afterNodeId ?? payload.after_node_id ?? null,
    nodeType: payload.nodeType ?? payload.node_type ?? 'TEXT',
    nodeTitle: payload.nodeTitle ?? payload.node_title ?? '',
    nodeNote: payload.nodeNote ?? payload.node_note ?? '',
    sourcePosition: payload.sourcePosition ?? payload.source_position ?? null
  };
}

export async function handleNodeMutation(store: NodeMutationStore, payload: WritePayload, ctx: NodeMutationContext, action: string, effects: EffectList) {
  if (action === 'node.insert') {
    const docId = requireDocId(payload);
    const node = store.insertNode(nodeInsertPayload(payload));
    const doc = maybeRefreshDoc(store, ctx, docId, payload.refreshOptions || {});
    return docRefresh(action, docId, {
      doc,
      node: plain(node),
      insertedNodeId: node.id,
      sideEffects: effects
    });
  }

  if (action === 'node.update') {
    const nodeId = requireId(payload, 'nodeId', 'node_id');
    assertNoNodeTrustField(payload, 'node.update payload');
    const patch = ownPatch(payload);
    assertNoNodeTrustField(patch, 'node.update patch');
    const node = store.updateNode(nodeId, patch);
    if (!node) throw new Error(`node.update: node not found: ${nodeId}`);
    return nodeRefresh(action, node.doc_id, node.id, { node: plain(node), sideEffects: effects });
  }

  const nodeId = requireId(payload, 'nodeId', 'node_id');
  const before = rowById(store, 'nodes', nodeId);
  const docId = payload.docId ?? payload.doc_id ?? before?.doc_id;
  if (!docId) throw new Error(`${action} requires docId or an existing nodeId`);

  let changed = false;
  let sourceNodeId: unknown = null;
  let targetNodeId: unknown = null;
  let newParentId: unknown = null;
  let direction: unknown = null;
  if (action === 'node.delete') changed = store.deleteNodeSubtree(nodeId);
  else if (action === 'node.move') {
    direction = payload.direction === 'up' ? 'up' : 'down';
    changed = store.moveNode(nodeId, direction);
  }
  else if (action === 'node.promote') changed = store.promoteNode(nodeId);
  else if (action === 'node.split') changed = store.splitNodeIntoChildren(nodeId, {
    splitAsciiPunctuation: payload.splitAsciiPunctuation === true || payload.split_ascii_punctuation === true
  });
  else if (action === 'node.mergePrevious') changed = store.mergeNodeIntoPreviousSibling(nodeId);
  else if (action === 'node.mergeInto') {
    targetNodeId = requireId(payload, 'targetNodeId', 'target_node_id');
    sourceNodeId = nodeId;
    changed = store.mergeNodeIntoTarget({ nodeId, targetNodeId });
  }
  else if (action === 'node.reparent') {
    newParentId = requireId(payload, 'newParentId', 'new_parent_id');
    changed = store.moveNodeToParent({ nodeId, newParentId });
  }
  else if (action === 'node.moveBefore') {
    targetNodeId = requireId(payload, 'targetNodeId', 'target_node_id');
    changed = store.moveNodeBeforeSibling({ nodeId, targetNodeId });
  }
  else if (action === 'node.moveAfter') {
    targetNodeId = requireId(payload, 'targetNodeId', 'target_node_id');
    changed = store.moveNodeAfterSibling({ nodeId, targetNodeId });
  }
  else throw new Error(`Unhandled database_write action: ${action}`);

  const after = rowById(store, 'nodes', nodeId);
  const doc = maybeRefreshDoc(store, ctx, docId, payload.refreshOptions || {});
  return docRefresh(action, docId, {
    changed: Boolean(changed),
    doc,
    nodeId,
    ...(sourceNodeId ? { sourceNodeId } : {}),
    ...(targetNodeId ? { targetNodeId } : {}),
    ...(newParentId ? { newParentId } : {}),
    ...(direction ? { direction } : {}),
    ...(after ? { node: plain(after) } : {}),
    sideEffects: effects
  });
}
