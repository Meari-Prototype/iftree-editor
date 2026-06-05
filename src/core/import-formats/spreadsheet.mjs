import {
  readSentenceRecords,
  readStructuredRecords
} from '../importers.mjs';

export async function importSpreadsheetDocument(filePath) {
  const sheet = await readStructuredRecords(filePath);
  if (sheet.structure) {
    return {
      structured: sheet.structure,
      records: sheet.sentences,
      sourceDocument: null
    };
  }
  const records = await readSentenceRecords(filePath);
  return {
    structured: null,
    records,
    sourceDocument: null
  };
}

export async function importFlatTableDocument(filePath) {
  const records = await readSentenceRecords(filePath);
  return {
    structured: null,
    records,
    sourceDocument: null
  };
}
