import { readSourceDocument } from '../importers.mjs';
import { importSourceDocumentForMode } from './shared.mjs';

export async function importTextDocument(filePath, options = {}) {
  const sourceDocument = readSourceDocument(filePath);
  return importSourceDocumentForMode(sourceDocument, options.mode, filePath);
}
