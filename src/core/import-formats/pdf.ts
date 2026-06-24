import { readPdfSourceDocument } from '../source-pdf.js';
import { importSourceDocumentForMode } from './shared.js';
import type { ImportOptions } from '../source-types.js';

export async function importPdfDocument(filePath: string, options: ImportOptions = {}) {
  const sourceDocument = await readPdfSourceDocument(filePath);
  return importSourceDocumentForMode(sourceDocument, options.mode, filePath);
}
