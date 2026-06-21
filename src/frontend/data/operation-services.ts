import { callIftree, hasIftreeMethod } from './iftree-api.js';
import { readDatabase } from './database-client.js';

export const importService = {
  canImportLibraryDocument() {
    return hasIftreeMethod('importLibraryDocument');
  },

  importLibraryDocument(payload) {
    return callIftree('importLibraryDocument', payload);
  },

  chooseImportFile(payload) {
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

  async searchContentByVector(payload) {
    const result = await readDatabase({ action: 'content.search', searchMode: 'vector', ...(payload || {}) });
    return (result?.rows || []).map((row) => ({
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

  generateNodeSummary(payload) {
    return callIftree('generateNodeSummary', payload);
  },

  cancelNodeSummary(payload) {
    return callIftree('cancelNodeSummary', payload);
  }
};
