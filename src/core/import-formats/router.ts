import { extname } from 'node:path';

import { readChmSourceDocument } from '../source-chm.js';
import { readDocxSourceDocument } from '../source-docx.js';
import { readEpubSourceDocument } from '../source-epub.js';
import { readPdfSourceDocument } from '../source-pdf.js';
import { readSourceDocument } from '../source-text.js';
import { importChmDocument } from './chm.js';
import { importDocxDocument } from './docx.js';
import { importEpubDocument } from './epub.js';
import { importPdfDocument } from './pdf.js';
import { normalizeImportMode } from './shared.js';
import { importTextDocument } from './text.js';
import { chunkTextByChars } from './vector.js';
import type { ImportOptions } from '../source-types.js';

// 读源文全文 + 源文档层（direct 与 vector 共用）：各格式取其纯文本载体（rawMarkdown / rawText），
// 返回 { text, sourceDocument }。text 即后续切分所依据的权威文本。
async function readFullTextSourceDocument(filePath: string, extension: string) {
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
    text = sourceDocument.rawText || sourceDocument.rawMarkdown || '';
  } else if (extension === '.epub') {
    sourceDocument = await readEpubSourceDocument(filePath, { granularity: 'paragraph' });
    text = sourceDocument.rawText || sourceDocument.rawMarkdown || '';
  } else {
    throw new Error(`不支持的导入格式：${extension || '未知格式'}`);
  }
  return { text, sourceDocument };
}

async function importDirectDocument(filePath: string, extension: string) {
  const { text, sourceDocument } = await readFullTextSourceDocument(filePath, extension);
  return {
    direct: true,
    records: [{ index: 1, text, vector: null }],
    structured: null,
    sourceDocument
  };
}

// 向量式导入：读全文 → 定长切块 → 每块一节点平铺（走 createDocFromSentenceRecords）。
// 源文档层 spans 按块边界重建，让块节点获得选区高亮 / 原文回溯能力。
// rawMarkdown / rawText 统一回写成切块所依据的全文，确保 spans 偏移与落库的源文严格一致
// （抹平不同 reader 的 rawText / rawMarkdown 取值差异，否则偏移会错位）。
async function importVectorDocument(filePath: string, extension: string, options: ImportOptions) {
  const { text, sourceDocument } = await readFullTextSourceDocument(filePath, extension);
  const chunks = chunkTextByChars(text, options);
  const records = chunks.map((chunk) => ({ index: chunk.index, text: chunk.text, vector: null }));
  const spans = chunks.map((chunk) => ({
    sentence_index: chunk.index,
    start_offset: chunk.start,
    end_offset: chunk.end,
    text: chunk.text
  }));
  return {
    records,
    structured: null,
    sourceDocument: sourceDocument
      ? { ...sourceDocument, rawMarkdown: text, rawText: text, spans }
      : null
  };
}

export async function importRecordsForFile(filePath: string, options: ImportOptions = {}) {
  const extension = extname(filePath).toLowerCase();
  const mode = normalizeImportMode(options.mode);
  if (mode === 'smart') throw new Error('智能导入入口未接入');
  if (mode === 'direct') return importDirectDocument(filePath, extension);
  if (mode === 'vector') return importVectorDocument(filePath, extension, options);
  if (extension === '.md' || extension === '.txt') return importTextDocument(filePath, options);
  if (extension === '.pdf') return importPdfDocument(filePath, options);
  if (extension === '.chm') return importChmDocument(filePath, options);
  if (extension === '.docx') return importDocxDocument(filePath, options);
  if (extension === '.epub') return importEpubDocument(filePath, options);
  if (extension === '.xlsx' || extension === '.csv') {
    throw new Error(`${extension} 是数据库导出中继格式，不支持普通文档导入。`);
  }
  throw new Error(`Unsupported import file: ${extension || '(none)'}`);
}
