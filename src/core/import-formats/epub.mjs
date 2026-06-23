import { readEpubSourceDocument } from '../source-epub.mjs';
import { normalizeImportMode } from './shared.mjs';

export async function importEpubDocument(filePath, options = {}) {
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
