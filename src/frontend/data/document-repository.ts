// @ts-nocheck
import { callIftree } from './iftree-api.js';
import { canReadDatabase, readDatabase, writeDatabase } from './database-client.js';

function read(action, payload?: Record<string, unknown>) {
  return readDatabase({ action, ...(payload || {}) });
}

async function readRows(action, payload) {
  const result = await read(action, payload);
  return Array.isArray(result) ? result : (Array.isArray(result?.rows) ? result.rows : []);
}

async function write(action, payload, key) {
  const result = await writeDatabase({ action, ...(payload || {}) });
  return key ? (result?.[key] || result) : result;
}

export const documentRepository = {
  canRead: canReadDatabase,

  listDocs() { return read('doc.list'); },
  listDocFolders() { return read('docFolder.list'); },
  listContentDocs(payload) { return read('content.listDocs', payload); },
  getLibraryNavigation(payload?: Record<string, unknown>) { return read('library.getNavigation', payload); },
  getContentIndex(payload) { return read('content.getIndex', payload); },
  getContentNode(payload) { return read('content.getNode', payload); },
  getContentSubtree(payload) { return read('content.getSubtree', payload); },
  getContentDepth(payload) { return read('content.getDepth', payload); },
  getContentArticle(payload) { return read('content.getArticle', payload); },
  searchContent(payload) { return read('content.search', payload); },
  getDocInfo(payload) { return read('doc.getInfo', payload); },
  getNode(payload) { return read('node.get', payload); },
  hasDocTreeDepth(payload) { return read('doc.hasTreeDepth', payload); },
  getNodeChildren(payload) { return read('node.listChildren', payload); },
  getDocNodesPage(payload) { return read('node.listPage', payload); },
  getSubtreeTextWindow(payload) { return read('subtree.getTextWindow', payload); },
  getSourceWindow(payload) { return read('source.getWindow', payload); },
  getPendingEditBranches(payload?: Record<string, unknown>) { return read('editBranch.listPending', payload); },

  getDoc(request) {
    return read('doc.get', typeof request === 'object' ? request : { docId: request });
  },

  getDocStructureRows(payload) { return readRows('node.listStructureRows', { ...payload, limit: 0 }); },
  getNodeTextBatch(payload) { return readRows('node.getTextBatch', payload); },
  getSubtreeSlotRange(payload) { return readRows('subtree.getSlotRange', payload); },
  getAncestorChain(payload) { return readRows('node.getAncestorChain', payload); },
  getEditBranchDiffView(payload) { return read('editBranch.diffView', payload); },
  getThreeWayMerge(payload) { return read('editBranch.threeWayMerge', payload); },

  createDoc(payload) { return write('doc.create', payload, 'doc'); },
  deleteDoc(payload) { return write('doc.delete', payload, 'docs'); },
  moveDocToFolder(payload) { return write('doc.moveToFolder', payload, 'docs'); },
  createDocFolder(payload) { return write('docFolder.create', payload, 'folder'); },
  updateDocFolder(payload) { return write('docFolder.update', payload, 'folder'); },
  deleteDocFolder(payload) { return write('docFolder.delete', payload, 'folders'); },
  refreshAddresses(payload) { return writeDatabase({ action: 'doc.refreshAddresses', ...(payload || {}) }); },
  beginEditBranch(payload) { return writeDatabase({ action: 'editBranch.begin', ...(payload || {}) }); },
  applyEditBranchMerge(payload) { return writeDatabase({ action: 'editBranch.applyMerge', ...(payload || {}) }); },
  discardEditBranch(payload) { return writeDatabase({ action: 'editBranch.discard', ...(payload || {}) }); },
  undoEditBranch(payload) { return writeDatabase({ action: 'editBranch.undo', ...(payload || {}) }); },
  redoEditBranch(payload) { return writeDatabase({ action: 'editBranch.redo', ...(payload || {}) }); },

  async updateDocAxiomsCollapsed(payload) {
    const result = await write('doc.updateAxiomsCollapsed', payload, 'doc');
    return result?.doc ? result : { doc: result };
  },

  readLibraryTree() { return callIftree('readLibraryTree'); },
  moveLibraryEntry(payload) { return callIftree('moveLibraryEntry', payload); }
};
