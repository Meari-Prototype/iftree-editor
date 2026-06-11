import { readDocxSourceDocument } from '../source-docx.mjs';
import { importSourceDocumentForMode } from './shared.mjs';

export async function importDocxDocument(filePath, options = {}) {
  const sourceDocument = readDocxSourceDocument(filePath);
  return importSourceDocumentForMode(sourceDocument, options.mode, filePath);
}
