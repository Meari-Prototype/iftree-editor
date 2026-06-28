import { writeDatabase } from './database-client.js';

interface HistoryPayload {
  docId?: string | null;
  historyId?: string | number | null;
  token?: string | number | null;
  effect?: unknown;
  [key: string]: unknown;
}

export const historyRepository = {
  async saveDocumentSnapshot(payload: HistoryPayload) {
    const result = await writeDatabase({ action: 'history.save', ...(payload || {}) }) as { doc?: unknown } | null | undefined;
    return result?.doc || result;
  },

  async restoreDocumentSnapshot(payload: HistoryPayload) {
    const result = await writeDatabase({ action: 'history.restore', ...(payload || {}) }) as { doc?: unknown } | null | undefined;
    return result?.doc || result;
  },

  captureEditorHistoryToken(payload: HistoryPayload) {
    return writeDatabase({ action: 'editorHistory.capture', ...(payload || {}) });
  },

  restoreEditorHistoryToken(payload: HistoryPayload) {
    return writeDatabase({ action: 'editorHistory.restore', ...(payload || {}) });
  },

  discardEditorHistoryTokens(payload: HistoryPayload) {
    return writeDatabase({ action: 'editorHistory.discard', ...(payload || {}) });
  }
};
