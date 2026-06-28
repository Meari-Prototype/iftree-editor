import { callIftree, hasIftreeMethod } from './iftree-api.js';
import { readDatabase } from './database-client.js';

type OperationPayload = Record<string, unknown>;

export const importService = {
  canImportLibraryDocument() {
    return hasIftreeMethod('importLibraryDocument');
  },

  importLibraryDocument(payload: OperationPayload) {
    return callIftree('importLibraryDocument', payload);
  },

  // 智能导入：后端只回「发给 agent 的任务」（prompt + 建议档位），调用方据此发起 agent 会话。
  smartImportTask(payload: OperationPayload) {
    return callIftree('smartImportTask', payload);
  },

  chooseImportFile(payload: OperationPayload) {
    return callIftree('chooseImportFile', payload);
  }
};

export const vectorService = {
  chooseLocalModelRoot() {
    return callIftree('chooseLocalModelRoot');
  },

  downloadVectorModel() {
    return callIftree('downloadVectorModel');
  },

  async searchContentByVector(payload: OperationPayload) {
    const result = await readDatabase({ action: 'content.search', searchMode: 'vector', ...(payload || {}) });
    const rows = ((result as { rows?: Array<Record<string, unknown>> } | null | undefined)?.rows || []);
    return rows.map((row) => ({
      node_id: row.id,
      doc_id: row.docId,
      text: row.text || row.textPreview || '',
      score: row.score,
      address: row.address || null
    }));
  }
};

export const summaryService = {
  canGenerateNodeSummary() {
    return hasIftreeMethod('generateNodeSummary');
  },

  generateNodeSummary(payload: OperationPayload) {
    return callIftree('generateNodeSummary', payload);
  },

  cancelNodeSummary(payload: OperationPayload) {
    return callIftree('cancelNodeSummary', payload);
  }
};
