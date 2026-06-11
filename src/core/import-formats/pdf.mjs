import { readPdfSourceDocument } from '../source-pdf.mjs';
import { importSourceDocumentForMode } from './shared.mjs';

export async function importPdfDocument(filePath, options = {}) {
  const sourceDocument = await readPdfSourceDocument(filePath);
  return importSourceDocumentForMode(sourceDocument, options.mode, filePath);
}
