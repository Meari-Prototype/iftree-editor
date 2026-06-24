import { readDocxSourceDocument } from '../source-docx.js';
import { normalizeImportMode } from './shared.js';
import type { ImportOptions } from '../source-types.js';

export async function importDocxDocument(filePath: string, options: ImportOptions = {}) {
  const importMode = normalizeImportMode(options.mode);
  const sourceDocument = readDocxSourceDocument(filePath, {
    granularity: importMode === 'complete' ? 'sentence' : 'paragraph'
  });
  const structured = sourceDocument.records;
  return {
    structured,
    records: structured,
    sourceDocument
  };
}
