import { callIftree } from './iftree-api.js';
import { documentRepository } from './document-repository.js';

export function readSourcePdfData(docId) {
  return callIftree('readSourcePdfData', docId);
}

export function readSourcePdfHighlights(payload) {
  return callIftree('readSourcePdfHighlights', payload);
}

export function readSourcePdfSpanRects(docId) {
  return callIftree('readSourcePdfSpanRects', docId);
}

export const sourceRepository = {
  getSourceWindow(payload) {
    return documentRepository.getSourceWindow(payload);
  },
  readSourcePdfData,
  readSourcePdfHighlights,
  readSourcePdfSpanRects
};
