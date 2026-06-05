import { writeDatabase } from './database-client.js';
import { documentRepository } from './document-repository.js';

export const nodeRepository = {
  getNode(payload) {
    return documentRepository.getNode(payload);
  },

  listNodeChildren(payload) {
    return documentRepository.getNodeChildren(payload);
  },

  insertNode(payload) {
    return writeDatabase({ action: 'node.insert', ...(payload || {}) });
  },

  updateNode(payload) {
    return writeDatabase({ action: 'node.update', ...(payload || {}) });
  },

  deleteNode(payload) {
    return writeDatabase({ action: 'node.delete', ...(payload || {}) });
  },

  moveNode(payload) {
    return writeDatabase({ action: 'node.move', ...(payload || {}) });
  },

  promoteNode(payload) {
    return writeDatabase({ action: 'node.promote', ...(payload || {}) });
  },

  splitNode(payload) {
    return writeDatabase({ action: 'node.split', ...(payload || {}) });
  },

  mergePreviousNode(payload) {
    return writeDatabase({ action: 'node.mergePrevious', ...(payload || {}) });
  },

  mergeNodeIntoTarget(payload) {
    return writeDatabase({ action: 'node.mergeInto', ...(payload || {}) });
  },

  moveNodeToParent(payload) {
    return writeDatabase({ action: 'node.reparent', ...(payload || {}) });
  },

  moveNodeBeforeSibling(payload) {
    return writeDatabase({ action: 'node.moveBefore', ...(payload || {}) });
  },

  moveNodeAfterSibling(payload) {
    return writeDatabase({ action: 'node.moveAfter', ...(payload || {}) });
  }
};
