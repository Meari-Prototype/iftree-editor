import { readChmSourceDocument } from '../importers.mjs';
import { normalizeImportMode } from './shared.mjs';

export async function importChmDocument(filePath, options = {}) {
  const importMode = normalizeImportMode(options.mode);
  const sourceDocument = await readChmSourceDocument(filePath, {
    granularity: importMode === 'complete' ? 'sentence' : 'paragraph'
  });
  const structured = sourceDocument.records;
  return {
    structured,
    records: structured,
    sourceDocument
  };
}
