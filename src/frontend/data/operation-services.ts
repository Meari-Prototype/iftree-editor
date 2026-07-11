import { callIftree, hasIftreeMethod } from './iftree-api.js';
import { readDatabase } from './database-client.js';
import type { ContentSearchResult } from '../../backend/query-api.js';

type OperationPayload = Record<string, unknown>;

export interface VectorContentSearchPayload {
  docId: string;
  query: string;
  limit?: number;
}

export interface VectorContentSearchItem {
  node_id: string;
  doc_id: string;
  text: string;
  score: number;
  address: string | null;
}

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

  async searchContentByVector(payload: VectorContentSearchPayload): Promise<VectorContentSearchItem[]> {
    const result: ContentSearchResult = await readDatabase({
      action: 'content.search',
      searchMode: 'vector',
      ...payload
    });
    return result.rows.map((row) => ({
      node_id: row.id,
      doc_id: row.docId,
      text: row.textPreview || row.text || '',
      score: row.score ?? 0,
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
