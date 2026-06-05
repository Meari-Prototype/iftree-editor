import { extname } from 'node:path';

import { readChmSourceDocument, readDocxSourceDocument, readPdfSourceDocument, readSourceDocument } from '../importers.mjs';
import { importChmDocument } from './chm.mjs';
import { importDocxDocument } from './docx.mjs';
import { importPdfDocument } from './pdf.mjs';
import { normalizeImportMode } from './shared.mjs';
import { importTextDocument } from './text.mjs';

async function importDirectDocument(filePath, extension) {
  let text = '';
  let sourceDocument = null;
  if (extension === '.md' || extension === '.txt') {
    sourceDocument = readSourceDocument(filePath);
    text = sourceDocument.rawMarkdown || '';
  } else if (extension === '.pdf') {
    sourceDocument = await readPdfSourceDocument(filePath);
    text = sourceDocument.rawMarkdown || '';
  } else if (extension === '.chm') {
    sourceDocument = await readChmSourceDocument(filePath, { granularity: 'paragraph' });
    text = sourceDocument.rawText || sourceDocument.rawMarkdown || '';
  } else if (extension === '.docx') {
    sourceDocument = readDocxSourceDocument(filePath);
    text = sourceDocument.rawMarkdown || '';
  } else {
    throw new Error(`不支持直接导入格式：${extension || '未知格式'}`);
  }
  return {
    direct: true,
    records: [{ index: 1, text, vector: null }],
    structured: null,
    sourceDocument
  };
}

export async function importRecordsForFile(filePath, options = {}) {
  const extension = extname(filePath).toLowerCase();
  const mode = normalizeImportMode(options.mode);
  if (mode === 'smart') throw new Error('智能导入入口未接入');
  if (mode === 'vector') throw new Error('向量导入入口未接入');
  if (mode === 'direct') return importDirectDocument(filePath, extension);
  if (extension === '.md' || extension === '.txt') return importTextDocument(filePath, options);
  if (extension === '.pdf') return importPdfDocument(filePath, options);
  if (extension === '.chm') return importChmDocument(filePath, options);
  if (extension === '.docx') return importDocxDocument(filePath, options);
  if (extension === '.xlsx' || extension === '.csv') {
    throw new Error(`${extension} 是数据库导出中继格式，不支持普通文档导入。`);
  }
  throw new Error(`Unsupported import file: ${extension || '(none)'}`);
}
