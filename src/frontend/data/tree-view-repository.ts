// @ts-nocheck
import { canWriteDatabase, writeDatabase } from './database-client.js';

function normalizeTreeViewResult(result) {
  if (!result) return result;
  return result.doc ? result : { doc: result };
}

export const treeViewRepository = {
  canSaveTreeViewState() {
    return canWriteDatabase();
  },

  async saveTreeViewState(payload) {
    const result = await writeDatabase({ action: 'treeView.update', ...(payload || {}) });
    return normalizeTreeViewResult(result);
  }
};
