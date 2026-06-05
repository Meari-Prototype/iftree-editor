import { readPdfSourceDocument } from '../importers.mjs';
import { importSourceDocumentForMode } from './shared.mjs';

export async function importPdfDocument(filePath, options = {}) {
  const sourceDocument = await readPdfSourceDocument(filePath);
  return importSourceDocumentForMode(sourceDocument, options.mode, filePath);
}
