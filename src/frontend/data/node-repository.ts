import { writeDatabase } from './database-client.js';
import { documentRepository } from './document-repository.js';

// 字段全 unknown：IPC 边界，AppBody 传 IPC 来的 unknown id 直接成立；writeDatabase 内部自己 narrow/forward。
interface NodePayload {
  docId?: unknown;
  nodeId?: unknown;
  targetNodeId?: unknown;
  parentId?: unknown;
  patch?: Record<string, unknown>;
  [key: string]: unknown;
}

export const nodeRepository = {
  getNode(payload: NodePayload) {
    return documentRepository.getNode(payload);
  },

  listNodeChildren(payload: NodePayload) {
    return documentRepository.getNodeChildren(payload);
  },

  insertNode(payload: NodePayload) {
    return writeDatabase({ action: 'node.insert', ...(payload || {}) });
  },

  updateNode(payload: NodePayload) {
    return writeDatabase({ action: 'node.update', ...(payload || {}) });
  },

  deleteNode(payload: NodePayload) {
    return writeDatabase({ action: 'node.delete', ...(payload || {}) });
  },

  moveNode(payload: NodePayload) {
    return writeDatabase({ action: 'node.move', ...(payload || {}) });
  },

  promoteNode(payload: NodePayload) {
    return writeDatabase({ action: 'node.promote', ...(payload || {}) });
  },

  splitNode(payload: NodePayload) {
    return writeDatabase({ action: 'node.split', ...(payload || {}) });
  },

  mergePreviousNode(payload: NodePayload) {
    return writeDatabase({ action: 'node.mergePrevious', ...(payload || {}) });
  },

  mergeNodeIntoTarget(payload: NodePayload) {
    return writeDatabase({ action: 'node.mergeInto', ...(payload || {}) });
  },

  moveNodeToParent(payload: NodePayload) {
    return writeDatabase({ action: 'node.reparent', ...(payload || {}) });
  },

  moveNodeBeforeSibling(payload: NodePayload) {
    return writeDatabase({ action: 'node.moveBefore', ...(payload || {}) });
  },

  moveNodeAfterSibling(payload: NodePayload) {
    return writeDatabase({ action: 'node.moveAfter', ...(payload || {}) });
  }
};
