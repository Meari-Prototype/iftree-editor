// @ts-nocheck
import { writeDatabase } from './database-client.js';

export const historyRepository = {
  async saveDocumentSnapshot(payload) {
    const result = await writeDatabase({ action: 'history.save', ...(payload || {}) });
    return result?.doc || result;
  },

  async restoreDocumentSnapshot(payload) {
    const result = await writeDatabase({ action: 'history.restore', ...(payload || {}) });
    return result?.doc || result;
  },

  captureEditorHistoryToken(payload) {
    return writeDatabase({ action: 'editorHistory.capture', ...(payload || {}) });
  },

  restoreEditorHistoryToken(payload) {
    return writeDatabase({ action: 'editorHistory.restore', ...(payload || {}) });
  },

  discardEditorHistoryTokens(payload) {
    return writeDatabase({ action: 'editorHistory.discard', ...(payload || {}) });
  }
};
