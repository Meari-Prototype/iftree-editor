import { canWriteDatabase, writeDatabase } from './database-client.js';

interface TreeViewStatePayload {
  docId: string;
  state: unknown;
}

function normalizeTreeViewResult(result: Awaited<ReturnType<typeof writeDatabase>>) {
  if (!result) return result;
  return result.doc ? result : { doc: result };
}

export const treeViewRepository = {
  canSaveTreeViewState() {
    return canWriteDatabase();
  },

  async saveTreeViewState(payload: TreeViewStatePayload) {
    const result = await writeDatabase({ action: 'treeView.update', ...(payload || {}) });
    return normalizeTreeViewResult(result);
  }
};
