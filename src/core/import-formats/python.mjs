import { readPythonStructureRecords } from '../importers.mjs';

export async function importPythonDocument(filePath) {
  const structured = await readPythonStructureRecords(filePath);
  return {
    structured,
    records: structured,
    sourceDocument: null
  };
}
