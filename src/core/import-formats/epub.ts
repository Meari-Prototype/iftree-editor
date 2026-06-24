import { readEpubSourceDocument } from '../source-epub.js';
import { normalizeImportMode } from './shared.js';
import type { ImportOptions } from '../source-types.js';

export async function importEpubDocument(filePath: string, options: ImportOptions = {}) {
  const importMode = normalizeImportMode(options.mode);
  const sourceDocument = await readEpubSourceDocument(filePath, {
    granularity: importMode === 'complete' ? 'sentence' : 'paragraph'
  });
  const structured = sourceDocument.records;
  return {
    structured,
    records: structured,
    sourceDocument
  };
}
