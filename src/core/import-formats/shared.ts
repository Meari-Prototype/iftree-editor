import { parse } from 'node:path';

import {
  inspectSourceDocumentStructure,
  recordsFromSourceDocument
} from '../source-text.js';
import type { SourceDocument, SourceRecord, SourceStructure } from '../source-types.js';

const SIMPLE_AUTO_DIRECT_CHAR_LIMIT = 1000;

export function normalizeImportMode(mode: unknown) {
  const normalized = String(mode || '').trim();
  if (['simple', 'complete', 'direct', 'smart', 'vector'].includes(normalized)) return normalized;
  return 'simple';
}

function sourceDocumentText(sourceDocument: SourceDocument = {}) {
  return String(sourceDocument.rawMarkdown ?? sourceDocument.rawText ?? sourceDocument.raw_markdown ?? '');
}

function sourceDocumentCharCount(sourceDocument: SourceDocument = {}) {
  return Array.from(sourceDocumentText(sourceDocument)).length;
}

function recordAddressDepth(record: SourceRecord) {
  return String(record?.address || '').split('-').filter(Boolean).length;
}

function simpleImportFailureReason(structure: SourceStructure, records: SourceRecord[]) {
  if (structure.headingCount === 0) return '无可识别目录结构';

  const depths = records.map(recordAddressDepth).filter((depth) => depth > 0);
  const maxDepth = depths.length > 0 ? Math.max(...depths) : 0;
  if (maxDepth <= 1 && structure.headingCount <= 1) return '结构深度不足';

  const topLevelCount = records.filter((record) => recordAddressDepth(record) === 1).length;
  if (maxDepth === 2 && topLevelCount === 1) return '只识别出一个标题节点';

  return '';
}

function simpleImportRejectedError(sourceDocument: SourceDocument, filePath: string, reason: string) {
  const name = parse(filePath).base;
  const charCount = sourceDocumentCharCount(sourceDocument);
  return new Error(`未识别到“${name}”的可用目录结构：${reason}，源文件总字数 ${charCount} > ${SIMPLE_AUTO_DIRECT_CHAR_LIMIT}，请改用智能导入或直接导入。`);
}

function directImportResult(sourceDocument: SourceDocument, degraded: { from: string; reason: string } | null = null) {
  const text = sourceDocumentText(sourceDocument);
  return {
    direct: true,
    degraded,
    records: [{ index: 1, text, vector: null }],
    structured: null,
    sourceDocument
  };
}

export function importSourceDocumentForMode(sourceDocument: SourceDocument, mode: unknown, filePath: string) {
  const importMode = normalizeImportMode(mode);
  const structured = recordsFromSourceDocument(sourceDocument, {
    granularity: importMode === 'complete' ? 'sentence' : 'paragraph'
  });

  if (importMode === 'simple') {
    const structure = inspectSourceDocumentStructure(sourceDocument);
    const failureReason = simpleImportFailureReason(structure, structured);
    if (failureReason) {
      if (sourceDocumentCharCount(sourceDocument) <= SIMPLE_AUTO_DIRECT_CHAR_LIMIT) {
        // simple 结构不达标但文档够小：退化为整篇单节点（而非报错）；带上退化原因供回执提示，
        // 不静默——调用方能看到「没按标题切、是整篇导入」。
        return directImportResult(sourceDocument, { from: 'simple', reason: failureReason });
      }
      throw simpleImportRejectedError(sourceDocument, filePath, failureReason);
    }
  }

  return {
    structured,
    records: structured,
    sourceDocument
  };
}
