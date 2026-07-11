// source 四表的通用持久化（L2）：只负责替换写入与文档绑定，不含格式解析、PDF 几何或导入策略。

import { normalizePositiveId } from '../db/normalizers.js';
import { parseJsonObject } from '../shared.js';
import type Database from 'better-sqlite3';
import type {
  DocRow, NodeRow, SourceDocBlockRow, SourceDocumentRow, SourcePdfCharRow, SourcePdfPageRow, SourceSpanRow
} from '../db/schema.js';

export interface SourceStore {
  db: Database | null;
  touchDoc(docId: unknown): void;
  withTransaction<T>(fn: () => T): T;
}

type SpanInput = Partial<SourceSpanRow> & { sentenceIndex?: unknown; index?: unknown; startOffset?: unknown; endOffset?: unknown };
type PageInput = Partial<SourcePdfPageRow> & { pageNumber?: unknown };
type CharInput = Partial<SourcePdfCharRow> & { charOffset?: unknown; pageNumber?: unknown; charText?: unknown };
type BlockInput = Partial<SourceDocBlockRow> & { blockIndex?: unknown; startOffset?: unknown; endOffset?: unknown };
type NodeMap = Map<unknown, unknown> | unknown[] | Record<string, unknown> | null;

export interface SourceDocumentInput {
  docId: unknown;
  sourcePath?: unknown;
  sourceType?: unknown;
  rawMarkdown?: unknown;
  spans?: unknown;
  pdfPages?: unknown;
  pdfChars?: unknown;
  docBlocks?: unknown;
  nodeIdsBySentenceIndex?: NodeMap;
}

export interface SourceBindingInput {
  docId?: unknown;
  sourcePath?: unknown;
  sourceType?: unknown;
  rawMarkdown?: unknown;
}

export interface SourceDocumentReferenceInput {
  docId?: unknown;
  originalPath?: unknown;
  sourceType?: unknown;
  rawMarkdown?: unknown;
}

export interface SourceWindowPayload {
  docId?: unknown;
  nodeId?: unknown;
  startOffset?: unknown;
  limit?: unknown;
  before?: unknown;
  spansLimit?: unknown;
}

type SourceWindowRow = SourceDocumentRow & { raw_length: number };

export function getSourceWindow(store: SourceStore, {
  docId, nodeId = null, startOffset = null, limit = 5000, before = null, spansLimit = 8000
}: SourceWindowPayload = {}) {
  const normalizedDocId = normalizePositiveId(docId);
  if (!normalizedDocId) return null;

  const source = store.db!.prepare(`
    SELECT doc_id, source_type, original_path, created_at, LENGTH(raw_markdown) AS raw_length
    FROM source_documents
    WHERE doc_id = ?
  `).get<SourceWindowRow>(normalizedDocId);
  if (!source) return null;

  const totalLength = Math.max(0, Number(source.raw_length) || 0);
  // limit 是总上下文窗口（默认 5000、上限 50000）。往前量未显式给 before 时自动分配：
  // min(⌊limit/5⌋, 1000)——limit≤5000 时前后 1:4，limit>5000 时往前封顶 1000、其余全归往后。
  // 显式给 before 则覆盖自动值（夹到 [0, limit]，用于需要多看上文的场景）。
  const safeLimit = Math.min(50000, Math.max(1, Math.floor(Number(limit) || 5000)));
  const hasExplicitBefore = before !== null && before !== undefined && Number.isFinite(Number(before));
  const safeBefore = hasExplicitBefore
    ? Math.max(0, Math.min(safeLimit, Math.floor(Number(before))))
    : Math.min(1000, Math.floor(safeLimit / 5));
  const safeSpansLimit = Math.min(20000, Math.max(100, Math.floor(Number(spansLimit) || 8000)));
  // 显式 offset 仅当真给了有限数字才算——startOffset 默认 null 而 Number(null)===0、isFinite(0)===true，
  // 若直接 Number(startOffset) 判定，未传 offset 会被误当成「显式 offset 0」，从而跳过下面的 nodeId 锚点
  // 解析、让所有按 nodeId 取窗口都静默退回文档开头（含叶子节点）。这里显式排除 null/undefined。
  const hasExplicitStartOffset = startOffset !== null && startOffset !== undefined && Number.isFinite(Number(startOffset));
  let anchor = hasExplicitStartOffset ? Number(startOffset) : NaN;
  // 锚点是否落到了真实原文出处。仅当传了 nodeId 却最终没解析到任何 source span 时为 false——
  // 据此让出口提示「该节点无原文出处、已从开头返回」，把容器节点静默退回 offset 0 变成可见。
  let anchorResolved = true;

  const finiteOffset = (row: { start_offset?: unknown } | undefined) =>
    row?.start_offset !== null && row?.start_offset !== undefined && Number.isFinite(Number(row.start_offset));

  const normalizedNodeId = nodeId === null || nodeId === undefined ? null : normalizePositiveId(nodeId);
  if (!hasExplicitStartOffset && normalizedNodeId) {
    const directSpan = store.db!.prepare(`
      SELECT MIN(start_offset) AS start_offset
      FROM source_spans
      WHERE doc_id = ? AND node_id = ?
    `).get<{ start_offset: number | null }>(normalizedDocId, normalizedNodeId);
    if (finiteOffset(directSpan)) {
      anchor = Number(directSpan!.start_offset);
    } else {
      const node = store.db!.prepare('SELECT address, source_position FROM nodes WHERE doc_id = ? AND id = ?')
        .get<Pick<NodeRow, 'address' | 'source_position'>>(normalizedDocId, normalizedNodeId);
      // source_position 为 NULL（容器/标题节点）时不能走 nearSpan：Number(null)===0、Math.floor(0)===0、
      // Number.isInteger(0)===true，会让 sentence_index>=0 命中全文首句而把锚点钉死在 offset 0。显式判空后
      // 跳过 nearSpan、落到下面的子树下钻。
      const rawSourcePosition = node?.source_position;
      const sourcePosition = rawSourcePosition !== null && rawSourcePosition !== undefined && Number.isFinite(Number(rawSourcePosition))
        ? Math.floor(Number(rawSourcePosition))
        : null;
      let resolved = false;
      if (sourcePosition !== null) {
        const nearSpan = store.db!.prepare(`
          SELECT start_offset
          FROM source_spans
          WHERE doc_id = ? AND sentence_index >= ?
          ORDER BY sentence_index, id
          LIMIT 1
        `).get<{ start_offset: number | null }>(normalizedDocId, sourcePosition);
        if (finiteOffset(nearSpan)) {
          anchor = Number(nearSpan!.start_offset);
          resolved = true;
        }
      }
      // 容器节点（章/卷级包裹，自身无直接 span 且无 source_position）：下钻到子树里第一个有
      // 原文出处的后代，用其 start_offset 当锚点——子树原文区间连续，MIN(start_offset) 即该
      // 子树的原文起点。避免「拿第一回当锚点却静默返回版权页」。
      if (!resolved) {
        const nodeAddress = String(node?.address || '').trim();
        if (nodeAddress) {
          const subtreeSpan = store.db!.prepare(`
            SELECT MIN(ss.start_offset) AS start_offset
            FROM source_spans ss
            JOIN nodes n ON n.id = ss.node_id AND n.doc_id = ss.doc_id
            WHERE ss.doc_id = ? AND (n.address = ? OR n.address LIKE ?)
          `).get<{ start_offset: number | null }>(normalizedDocId, nodeAddress, `${nodeAddress}-%`);
          if (finiteOffset(subtreeSpan)) {
            anchor = Number(subtreeSpan!.start_offset);
            resolved = true;
          }
        }
      }
      if (!resolved) anchorResolved = false;
    }
  }

  if (!Number.isFinite(anchor)) anchor = 0;
  anchor = Math.min(totalLength, Math.max(0, Math.floor(anchor)));
  // 往前最多 safeBefore；撞文档头时往前用不满的额度并入往后、凑满 limit；
  // 撞文档尾时往后到底为止、往前不补（总窗口可能不足 limit）。
  const windowStart = Math.max(0, anchor - safeBefore);
  const actualBefore = anchor - windowStart;
  const windowEnd = Math.min(totalLength, anchor + (safeLimit - actualBefore));
  const rawMarkdown = windowEnd > windowStart
    ? store.db!.prepare('SELECT substr(raw_markdown, ?, ?) AS text FROM source_documents WHERE doc_id = ?')
      .get(windowStart + 1, windowEnd - windowStart, normalizedDocId)?.text || ''
    : '';

  const sourceSpans = store.db!.prepare(`
    SELECT *
    FROM source_spans
    WHERE doc_id = ? AND end_offset > ? AND start_offset < ?
    ORDER BY sentence_index, id
    LIMIT ?
  `).all<SourceSpanRow>(normalizedDocId, windowStart, windowEnd, safeSpansLimit).map((span) => ({
    ...span,
    absolute_start_offset: span.start_offset,
    absolute_end_offset: span.end_offset,
    start_offset: Math.max(0, Number(span.start_offset) - windowStart),
    end_offset: Math.min(windowEnd - windowStart, Number(span.end_offset) - windowStart)
  }));

  return {
    docId: normalizedDocId,
    anchorNodeId: normalizedNodeId,
    anchorResolved,
    startOffset: windowStart,
    endOffset: windowEnd,
    totalLength,
    hasBefore: windowStart > 0,
    hasAfter: windowEnd < totalLength,
    raw_markdown: rawMarkdown,
    sourceDocument: {
      doc_id: source.doc_id,
      source_type: source.source_type,
      original_path: source.original_path,
      raw_markdown: '',
      created_at: source.created_at
    },
    sourceSpans
  };
}

export function saveSourceDocument(store: SourceStore, {
  docId, sourcePath = null, sourceType = 'md', rawMarkdown = '', spans = [], pdfPages = [],
  pdfChars = [], docBlocks = [], nodeIdsBySentenceIndex = null
}: SourceDocumentInput) {
  const doc = store.db!.prepare('SELECT id FROM docs WHERE id = ?').get<Pick<DocRow, 'id'>>(docId);
  if (!doc) throw new Error(`Document not found: ${docId}`);
  const nodeIdForSentence = (sentenceIndex: unknown) => {
    const index = Number(sentenceIndex);
    if (!nodeIdsBySentenceIndex) return null;
    if (nodeIdsBySentenceIndex instanceof Map) {
      return nodeIdsBySentenceIndex.get(index) ?? nodeIdsBySentenceIndex.get(String(index)) ?? null;
    }
    if (Array.isArray(nodeIdsBySentenceIndex)) return nodeIdsBySentenceIndex[index - 1] ?? null;
    return nodeIdsBySentenceIndex[index] ?? nodeIdsBySentenceIndex[String(index)] ?? null;
  };
  return store.withTransaction(() => {
    store.db!.prepare('DELETE FROM source_spans WHERE doc_id = ?').run(docId);
    store.db!.prepare('DELETE FROM source_pdf_chars WHERE doc_id = ?').run(docId);
    store.db!.prepare('DELETE FROM source_pdf_pages WHERE doc_id = ?').run(docId);
    store.db!.prepare('DELETE FROM source_doc_blocks WHERE doc_id = ?').run(docId);
    store.db!.prepare('DELETE FROM source_documents WHERE doc_id = ?').run(docId);
    store.db!.prepare(`INSERT INTO source_documents (doc_id, source_type, original_path, raw_markdown) VALUES (?, ?, ?, ?)`)
      .run(docId, sourceType || 'md', sourcePath, rawMarkdown || '');

    const insertSpan = store.db!.prepare(`
      INSERT INTO source_spans (doc_id, node_id, sentence_index, start_offset, end_offset, text)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const span of (Array.isArray(spans) ? spans : []) as SpanInput[]) {
      const sentenceIndex = Number(span.sentence_index ?? span.sentenceIndex ?? span.index);
      const start = Number(span.start_offset ?? span.startOffset);
      const end = Number(span.end_offset ?? span.endOffset);
      if (!Number.isFinite(sentenceIndex) || sentenceIndex <= 0 || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
      insertSpan.run(docId, nodeIdForSentence(sentenceIndex), sentenceIndex, start, end, span.text || '');
    }

    const insertPage = store.db!.prepare(`INSERT INTO source_pdf_pages (doc_id, page_number, width, height) VALUES (?, ?, ?, ?)`);
    for (const page of (Array.isArray(pdfPages) ? pdfPages : []) as PageInput[]) {
      const values = [Number(page.page_number ?? page.pageNumber), Number(page.width), Number(page.height)];
      if (!values.every(Number.isFinite)) continue;
      insertPage.run(docId, ...values);
    }

    const insertChar = store.db!.prepare(`
      INSERT INTO source_pdf_chars (doc_id, char_offset, page_number, x0, y0, x1, y1, char_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of (Array.isArray(pdfChars) ? pdfChars : []) as CharInput[]) {
      const values = [
        Number(item.char_offset ?? item.charOffset), Number(item.page_number ?? item.pageNumber),
        Number(item.x0), Number(item.y0), Number(item.x1), Number(item.y1)
      ];
      if (!values.every(Number.isFinite)) continue;
      insertChar.run(docId, ...values, item.char_text ?? item.charText ?? '');
    }

    const insertBlock = store.db!.prepare(`INSERT INTO source_doc_blocks (doc_id, block_index, start_offset, end_offset) VALUES (?, ?, ?, ?)`);
    for (const block of (Array.isArray(docBlocks) ? docBlocks : []) as BlockInput[]) {
      const index = Number(block.block_index ?? block.blockIndex);
      const start = Number(block.start_offset ?? block.startOffset);
      const end = Number(block.end_offset ?? block.endOffset);
      if (!Number.isFinite(index) || !Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
      insertBlock.run(docId, index, start, end);
    }
    store.touchDoc(docId);
    return store.db!.prepare('SELECT * FROM source_documents WHERE doc_id = ?').get<SourceDocumentRow>(docId);
  });
}

export function updateSourceBinding(store: SourceStore, {
  docId, sourcePath, sourceType = 'file', rawMarkdown = ''
}: SourceBindingInput) {
  const normalizedDocId = normalizePositiveId(docId);
  const path = String(sourcePath || '').trim();
  if (!normalizedDocId || !path) throw new Error('Source binding requires docId and sourcePath');
  return store.withTransaction(() => {
    const doc = store.db!.prepare('SELECT id, meta FROM docs WHERE id = ?').get<Pick<DocRow, 'id' | 'meta'>>(normalizedDocId);
    if (!doc) throw new Error(`Document not found: ${normalizedDocId}`);
    store.db!.prepare('UPDATE docs SET meta = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(JSON.stringify({ ...parseJsonObject(doc.meta), sourcePath: path }), normalizedDocId);
    const existing = store.db!.prepare('SELECT doc_id FROM source_documents WHERE doc_id = ?')
      .get<Pick<SourceDocumentRow, 'doc_id'>>(normalizedDocId);
    if (existing) {
      store.db!.prepare('UPDATE source_documents SET source_type = ?, original_path = ? WHERE doc_id = ?')
        .run(sourceType || 'file', path, normalizedDocId);
    } else {
      store.db!.prepare(`INSERT INTO source_documents (doc_id, source_type, original_path, raw_markdown) VALUES (?, ?, ?, ?)`)
        .run(normalizedDocId, sourceType || 'file', path, rawMarkdown || '');
    }
    return store.db!.prepare('SELECT * FROM source_documents WHERE doc_id = ?').get<SourceDocumentRow>(normalizedDocId);
  });
}

export function setSourceDocumentReference(store: SourceStore, {
  docId, originalPath, sourceType = 'file', rawMarkdown = ''
}: SourceDocumentReferenceInput) {
  if (!docId || !originalPath) throw new Error('Source document reference requires docId and originalPath');
  return store.withTransaction(() => {
    store.db!.prepare('DELETE FROM source_documents WHERE doc_id = ?').run(docId);
    store.db!.prepare(`
      INSERT INTO source_documents (doc_id, source_type, original_path, raw_markdown)
      VALUES (?, ?, ?, ?)
    `).run(docId, sourceType, originalPath, rawMarkdown);
    return true;
  });
}
