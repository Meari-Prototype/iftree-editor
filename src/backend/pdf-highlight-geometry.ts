// @ts-nocheck
// PDF 源文档高亮的屏幕几何计算——从主库存储类剥离（后端解耦第 1 步）。
// 职责：把节点的字符偏移区间映射成 PDF 页面上的高亮矩形。只读 source_pdf_chars / source_spans
// 两表，接收 db 句柄，不持有状态。
import { requireStableId } from './db/ids.js';
import { mergePdfCharRects } from './db/normalizers.js';

// PDF 高亮多区间入参清洗：去掉非法区间，按 start 排序并合并相邻/重叠段。
function mergeHighlightOffsetRanges(ranges) {
  const normalized = (Array.isArray(ranges) ? ranges : [])
    .map((range) => ({ start: Number(range?.start), end: Number(range?.end) }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const range of normalized) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push(range);
  }
  return merged;
}

// ranges 是 [start,end) 区间列表：多 span 节点的高亮不能用单一包络区间，
// 否则 spans 之间别的节点的正文也会被一起点亮。
export function pdfHighlightRects(db, docId, ranges) {
  const merged = mergeHighlightOffsetRanges(ranges);
  if (merged.length === 0) return [];
  const statement = db.prepare(`
    SELECT page_number, x0, y0, x1, y1
    FROM source_pdf_chars
    WHERE doc_id = ?
      AND char_offset >= ?
      AND char_offset < ?
    ORDER BY page_number, char_offset
  `);
  const rects = [];
  for (const range of merged) {
    rects.push(...mergePdfCharRects(statement.all(docId, range.start, range.end)));
  }
  return rects;
}

export function pdfSpanHitRects(db, docId) {
  const normalizedDocId = requireStableId(docId, 'docId');
  const spans = db.prepare(`
    SELECT id, node_id, sentence_index, start_offset, end_offset
    FROM source_spans
    WHERE doc_id = ?
    ORDER BY start_offset, end_offset, sentence_index, id
  `).all(normalizedDocId);
  if (spans.length === 0) return [];
  const chars = db.prepare(`
    SELECT char_offset, page_number, x0, y0, x1, y1
    FROM source_pdf_chars
    WHERE doc_id = ?
    ORDER BY char_offset
  `).all(normalizedDocId);
  const rows = [];
  const lowerBoundCharOffset = (target) => {
    let left = 0;
    let right = chars.length;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (Number(chars[middle].char_offset) < target) left = middle + 1;
      else right = middle;
    }
    return left;
  };
  for (const span of spans) {
    const start = Number(span.start_offset);
    const end = Number(span.end_offset);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const spanChars = [];
    let cursor = lowerBoundCharOffset(start);
    while (cursor < chars.length && Number(chars[cursor].char_offset) < end) {
      spanChars.push(chars[cursor]);
      cursor += 1;
    }
    for (const rect of mergePdfCharRects(spanChars)) {
      rows.push({
        span_id: span.id,
        node_id: span.node_id,
        sentence_index: span.sentence_index,
        start_offset: span.start_offset,
        end_offset: span.end_offset,
        ...rect
      });
    }
  }
  return rows;
}
