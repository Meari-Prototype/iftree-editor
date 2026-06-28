import { callIftree } from './iftree-api.js';
import { documentRepository } from './document-repository.js';

interface SourceWindowPayload {
  docId: string;
  [key: string]: unknown;
}

interface SourcePdfHighlightsPayload {
  docId: string;
  [key: string]: unknown;
}

export function readSourcePdfData(docId: string) {
  return callIftree('readSourcePdfData', docId);
}

export function readSourcePdfHighlights(payload: SourcePdfHighlightsPayload) {
  return callIftree('readSourcePdfHighlights', payload);
}

export function readSourcePdfSpanRects(docId: string) {
  return callIftree('readSourcePdfSpanRects', docId);
}

export const sourceRepository = {
  getSourceWindow(payload: SourceWindowPayload) {
    return documentRepository.getSourceWindow(payload);
  },
  readSourcePdfData,
  readSourcePdfHighlights,
  readSourcePdfSpanRects
};
