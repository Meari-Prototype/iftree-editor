import { callIftree } from './iftree-api.js';
import { canReadDatabase, readDatabase, writeDatabase } from './database-client.js';

type RepositoryPayload = Record<string, unknown>;

function read(action: string, payload?: RepositoryPayload | null) {
  return readDatabase({ action, ...(payload || {}) });
}

async function readRows(action: string, payload?: RepositoryPayload | null): Promise<unknown[]> {
  const result = await read(action, payload);
  const rows = (result as { rows?: unknown[] } | null | undefined)?.rows;
  return Array.isArray(result) ? result : (Array.isArray(rows) ? rows : []);
}

async function write(action: string, payload: RepositoryPayload | null | undefined, key?: string) {
  const result = await writeDatabase({ action, ...(payload || {}) });
  return key ? ((result as Record<string, unknown> | null | undefined)?.[key] || result) : result;
}

export const documentRepository = {
  canRead: canReadDatabase,

  listDocs() { return read('doc.list'); },
  listDocFolders() { return read('docFolder.list'); },
  listContentDocs(payload: RepositoryPayload) { return read('content.listDocs', payload); },
  getLibraryNavigation(payload?: Record<string, unknown>) { return read('library.getNavigation', payload); },
  getContentIndex(payload: RepositoryPayload) { return read('content.getIndex', payload); },
  getContentNode(payload: RepositoryPayload) { return read('content.getNode', payload); },
  getContentSubtree(payload: RepositoryPayload) { return read('content.getSubtree', payload); },
  getContentDepth(payload: RepositoryPayload) { return read('content.getDepth', payload); },
  getContentArticle(payload: RepositoryPayload) { return read('content.getArticle', payload); },
  searchContent(payload: RepositoryPayload) { return read('content.search', payload); },
  getDocInfo(payload: RepositoryPayload) { return read('doc.getInfo', payload); },
  getNode(payload: RepositoryPayload) { return read('node.get', payload); },
  hasDocTreeDepth(payload: RepositoryPayload) { return read('doc.hasTreeDepth', payload); },
  getNodeChildren(payload: RepositoryPayload) { return read('node.listChildren', payload); },
  getDocNodesPage(payload: RepositoryPayload) { return read('node.listPage', payload); },
  getSubtreeTextWindow(payload: RepositoryPayload) { return read('subtree.getTextWindow', payload); },
  getSourceWindow(payload: RepositoryPayload) { return read('source.getWindow', payload); },
  getPendingEditBranches(payload?: Record<string, unknown>) { return read('editBranch.listPending', payload); },

  getDoc(request: RepositoryPayload | string | null) {
    return read('doc.get', typeof request === 'object' ? request : { docId: request });
  },

  getDocStructureRows(payload: RepositoryPayload) { return readRows('node.listStructureRows', { ...payload, limit: 0 }); },
  getNodeTextBatch(payload: RepositoryPayload) { return readRows('node.getTextBatch', payload); },
  getSubtreeSlotRange(payload: RepositoryPayload) { return readRows('subtree.getSlotRange', payload); },
  getAncestorChain(payload: RepositoryPayload) { return readRows('node.getAncestorChain', payload); },
  getEditBranchDiffView(payload: RepositoryPayload) { return read('editBranch.diffView', payload); },
  getThreeWayMerge(payload: RepositoryPayload) { return read('editBranch.threeWayMerge', payload); },

  createDoc(payload: RepositoryPayload) { return write('doc.create', payload, 'doc'); },
  deleteDoc(payload: RepositoryPayload) { return write('doc.delete', payload, 'docs'); },
  moveDocToFolder(payload: RepositoryPayload) { return write('doc.moveToFolder', payload, 'docs'); },
  createDocFolder(payload: RepositoryPayload) { return write('docFolder.create', payload, 'folder'); },
  updateDocFolder(payload: RepositoryPayload) { return write('docFolder.update', payload, 'folder'); },
  deleteDocFolder(payload: RepositoryPayload) { return write('docFolder.delete', payload, 'folders'); },
  refreshAddresses(payload: RepositoryPayload) { return writeDatabase({ action: 'doc.refreshAddresses', ...(payload || {}) }); },
  beginEditBranch(payload: RepositoryPayload) { return writeDatabase({ action: 'editBranch.begin', ...(payload || {}) }); },
  applyEditBranchMerge(payload: RepositoryPayload) { return writeDatabase({ action: 'editBranch.applyMerge', ...(payload || {}) }); },
  discardEditBranch(payload: RepositoryPayload) { return writeDatabase({ action: 'editBranch.discard', ...(payload || {}) }); },
  undoEditBranch(payload: RepositoryPayload) { return writeDatabase({ action: 'editBranch.undo', ...(payload || {}) }); },
  redoEditBranch(payload: RepositoryPayload) { return writeDatabase({ action: 'editBranch.redo', ...(payload || {}) }); },

  async updateDocAxiomsCollapsed(payload: RepositoryPayload) {
    const result = await write('doc.updateAxiomsCollapsed', payload, 'doc');
    return (result as { doc?: unknown } | null | undefined)?.doc ? result : { doc: result };
  },

  readLibraryTree() { return callIftree('readLibraryTree'); },
  moveLibraryEntry(payload: RepositoryPayload) { return callIftree('moveLibraryEntry', payload); }
};
