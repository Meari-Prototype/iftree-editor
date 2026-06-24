import { readSourceDocument } from '../source-text.js';
import { importSourceDocumentForMode } from './shared.js';
import type { ImportOptions } from '../source-types.js';

export async function importTextDocument(filePath: string, options: ImportOptions = {}) {
  const sourceDocument = readSourceDocument(filePath) as Record<string, unknown>;
  return importSourceDocumentForMode(sourceDocument, options.mode, filePath);
}