import {
  docRefresh,
  maybeRefreshDoc,
  nodeRefresh,
  ownPatch,
  plain,
  requireDocId,
  requireId,
  rowById,
  runOptionalEffect
} from './shared.mjs';

function nodeInsertPayload(payload = {}) {
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

export async function handleNodeMutation(store, payload, ctx, action, effects) {
  if (action === 'node.insert') {
    const docId = requireDocId(payload);
    const node = store.insertNode(nodeInsertPayload(payload));
    await runOptionalEffect(effects, 'keyword.upsert_node', () => ctx.upsertKeywordForNode?.(node));
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
    const patch = ownPatch(payload);
    const node = store.updateNode(nodeId, patch);
    if (Object.prototype.hasOwnProperty.call(patch, 'text')) {
      await runOptionalEffect(effects, 'vector.upsert_node', () => ctx.upsertVectorForNode?.(node));
    }
    if (
      Object.prototype.hasOwnProperty.call(patch, 'text')
      || Object.prototype.hasOwnProperty.call(patch, 'node_title')
      || Object.prototype.hasOwnProperty.call(patch, 'nodeTitle')
      || Object.prototype.hasOwnProperty.call(patch, 'node_note')
      || Object.prototype.hasOwnProperty.call(patch, 'nodeNote')
    ) {
      await runOptionalEffect(effects, 'keyword.upsert_node', () => ctx.upsertKeywordForNode?.(node));
    }
    return nodeRefresh(action, node.doc_id, node.id, { node: plain(node), sideEffects: effects });
  }

  const nodeId = requireId(payload, 'nodeId', 'node_id');
  const before = rowById(store, 'nodes', nodeId);
  const docId = payload.docId ?? payload.doc_id ?? before?.doc_id;
  if (!docId) throw new Error(`${action} requires docId or an existing nodeId`);

  let changed = false;
  if (action === 'node.delete') changed = store.deleteNodeSubtree(nodeId);
  else if (action === 'node.move') changed = store.moveNode(nodeId, payload.direction);
  else if (action === 'node.promote') changed = store.promoteNode(nodeId);
  else if (action === 'node.split') changed = store.splitNodeIntoChildren(nodeId);
  else if (action === 'node.mergePrevious') changed = store.mergeNodeIntoPreviousSibling(nodeId);
  else if (action === 'node.mergeInto') changed = store.mergeNodeIntoTarget({
    nodeId,
    targetNodeId: requireId(payload, 'targetNodeId', 'target_node_id')
  });
  else if (action === 'node.reparent') changed = store.moveNodeToParent({
    nodeId,
    newParentId: requireId(payload, 'newParentId', 'new_parent_id')
  });
  else if (action === 'node.moveBefore') changed = store.moveNodeBeforeSibling({
    nodeId,
    targetNodeId: requireId(payload, 'targetNodeId', 'target_node_id')
  });
  else if (action === 'node.moveAfter') changed = store.moveNodeAfterSibling({
    nodeId,
    targetNodeId: requireId(payload, 'targetNodeId', 'target_node_id')
  });
  else throw new Error(`Unhandled database_write action: ${action}`);

  if (changed) {
    await runOptionalEffect(effects, 'keyword.rebuild_doc', () => ctx.rebuildKeywordIndexForDoc?.(docId));
  }
  const doc = maybeRefreshDoc(store, ctx, docId, payload.refreshOptions || {});
  return docRefresh(action, docId, {
    changed: Boolean(changed),
    doc,
    sideEffects: effects
  });
}
