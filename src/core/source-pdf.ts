import { readFileSync } from 'node:fs';

import { getDocument, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { normalizeSourceMarkdown, sourceSpansFromMarkdown } from './source-markdown.js';

// ---- PDF.js thin types ----

interface PdfViewport {
  width: number;
  height: number;
  transform: number[];
}

interface PdfTextContentItem {
  str?: string;
  fontName?: string;
  transform: number[];
  width?: number;
  height?: number;
}

interface PdfPageProxy {
  getViewport(args: { scale: number }): PdfViewport;
  getTextContent(): Promise<{ items: PdfTextContentItem[] }>;
  getOperatorList(): Promise<unknown>;
  commonObjs: { has(key: string): boolean; get(key: string): { name?: string } | undefined };
}

interface PdfOutlineItem {
  title?: string;
  dest?: string | unknown[];
  items?: PdfOutlineItem[];
}

interface PdfDocumentProxy {
  numPages: number;
  getPage(n: number): Promise<PdfPageProxy>;
  getOutline(): Promise<PdfOutlineItem[]>;
  getDestination(dest: string): Promise<unknown>;
  getPageIndex(ref: unknown): Promise<number>;
}

// ---- Project data types ----

interface PdfRect {
  x: number;
  y0: number;
  y1: number;
  width: number;
  height: number;
}

interface PdfPageItem {
  text: string;
  rect: PdfRect;
  pageNumber: number;
  bold: boolean;
}

interface PdfBuiltLine {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  centerY: number;
  height: number;
  segments: PdfPageItem[];
  columnBreak?: boolean;
}

interface PdfTextLine {
  start: number;
  end: number;
  text: string;
  height: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  bold: boolean;
  pageNumber?: number;
}

interface PdfChar {
  charOffset: number;
  pageNumber: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  charText: string;
}

interface PdfBlock {
  type: string;
  start: number;
  end: number;
  level?: number;
  contentStart?: number;
  contentEnd?: number;
  text?: string;
  lines?: { start: number; end: number }[];
}

// ---- Functions ----

export async function readPdfSourceDocument(filePath: string) {
  const data = new Uint8Array(readFileSync(filePath));
  const pdf = await getDocument({ data, useSystemFonts: true }).promise as unknown as PdfDocumentProxy;
  const pages: { pageNumber: number; width: number; height: number }[] = [];
  const chars: PdfChar[] = [];
  const lines: PdfTextLine[] = [];
  let raw = '';

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page: PdfPageProxy = await pdf.getPage(pageNumber);
    const viewport: PdfViewport = page.getViewport({ scale: 1 });
    pages.push({ pageNumber, width: viewport.width, height: viewport.height });

    const content = await page.getTextContent();
    const boldByFont = await pdfBoldByFont(page, content);
    const pageItems: PdfPageItem[] = [];
    for (const item of content.items || []) {
      const text = String((item as unknown as Record<string, unknown>).str || '');
      if (!text) continue;
      const rect = textItemRect(item, viewport);
      if (!rect) continue;
      pageItems.push({ text, rect, pageNumber, bold: boldByFont.get(String((item as unknown as Record<string, unknown>).fontName || '')) === true });
    }

    const pageText = pdfPageText(pageItems, viewport);
    if (pageText.text) {
      if (raw && !raw.endsWith('\n\n')) raw += '\n\n';
      const pageStartOffset = raw.length;
      raw += pageText.text;
      for (const line of pageText.lines) {
        lines.push({
          ...line,
          pageNumber,
          start: pageStartOffset + line.start,
          end: pageStartOffset + line.end
        });
      }
      for (const item of pageText.chars) {
        chars.push({ ...item, charOffset: pageStartOffset + item.charOffset });
      }
    }
    if (pageNumber < pdf.numPages && raw && !raw.endsWith('\n\n')) raw += '\n\n';
  }

  const normalized = normalizePdfTextLayer(raw, chars);
  const rawMarkdown = normalizeSourceMarkdown(normalized.text);
  if (isImageOnlyPdf(rawMarkdown, pdf.numPages)) {
    throw new Error('该 PDF 似乎是纯图片 PDF，当前导入只支持可抽取文本的 PDF。请先 OCR 成文本或使用 Markdown/TXT 源文件。');
  }
  const blocks = await buildPdfSourceBlocks(pdf, rawMarkdown, lines, normalized);
  return {
    sourcePath: filePath,
    sourceType: 'pdf',
    rawMarkdown,
    blocks,
    spans: sourceSpansFromMarkdown(rawMarkdown, { blocks }),
    pdfPages: pages,
    pdfChars: normalized.chars
  };
}

// 加粗判据 = 字体名含 Bold。getTextContent 不填 commonObjs，需先 getOperatorList 触发字体加载。
async function pdfBoldByFont(page: PdfPageProxy, content: { items: PdfTextContentItem[] }) {
  const map = new Map<string, boolean>();
  const refs = [...new Set((content.items || []).map((item) => item.fontName).filter((f): f is string => f != null))];
  if (refs.length === 0) return map;
  await page.getOperatorList();
  for (const ref of refs) {
    let bold = false;
    try {
      if (page.commonObjs.has(ref)) bold = /bold/i.test(page.commonObjs.get(ref)?.name || '');
    } catch {
      bold = false;
    }
    map.set(ref, bold);
  }
  return map;
}

function pdfLineBold(line: PdfBuiltLine) {
  let boldChars = 0;
  let total = 0;
  for (const segment of line.segments || []) {
    const count = [...String(segment.text || '')].length;
    total += count;
    if (segment.bold) boldChars += count;
  }
  return total > 0 && boldChars / total >= 0.6;
}

function pdfPageText(items: PdfPageItem[], viewport: PdfViewport) {
  const lines = orderPdfLines(buildPdfLines(items, viewport.width), viewport.width);
  let text = '';
  const chars: PdfChar[] = [];
  const textLines: PdfTextLine[] = [];
  let previousLine: PdfBuiltLine | null = null;

  for (const line of lines) {
    if (text) text += pdfLineSeparator(previousLine, line);
    const start = text.length;
    appendPdfLine(line);
    const end = text.length;
    if (end > start) {
      textLines.push({
        start,
        end,
        text: text.slice(start, end),
        height: line.height,
        x0: line.x0,
        x1: line.x1,
        y0: line.y0,
        y1: line.y1,
        bold: pdfLineBold(line)
      });
    }
    previousLine = line;
  }

  return { text: text.trimEnd(), chars, lines: textLines };

  function appendPdfLine(line: PdfBuiltLine) {
    let previousSegment: PdfPageItem | null = null;
    for (const segment of line.segments) {
      if (previousSegment && needsPdfSegmentSpace(previousSegment, segment)) text += ' ';
      const startOffset = text.length;
      text += segment.text;
      for (let index = 0; index < segment.text.length; index += 1) {
        const charRect = charRectForItem(segment.rect, index, segment.text.length);
        chars.push({
          charOffset: startOffset + index,
          pageNumber: segment.pageNumber,
          x0: charRect.x0,
          y0: charRect.y0,
          x1: charRect.x1,
          y1: charRect.y1,
          charText: segment.text[index]
        });
      }
      previousSegment = segment;
    }
  }
}

function buildPdfLines(items: PdfPageItem[], pageWidth: number = 0) {
  const lines: PdfBuiltLine[] = [];
  const sorted = [...items].sort((a, b) => (
    a.rect.y0 - b.rect.y0 || a.rect.x - b.rect.x
  ));

  for (const item of sorted) {
    const centerY = (item.rect.y0 + item.rect.y1) / 2;
    const previous = lines.at(-1);
    const tolerance = Math.max(2, Math.max(previous?.height || 0, item.rect.height) * 0.55);
    const separateColumn = shouldSeparatePdfColumnLine(previous, item, pageWidth);
    if (previous && Math.abs(centerY - previous.centerY) <= tolerance && !separateColumn) {
      addPdfLineSegment(previous, item);
    } else {
      lines.push(createPdfLine(item));
    }
  }

  return lines.map((line) => ({
    ...line,
    segments: line.segments.sort((a, b) => a.rect.x - b.rect.x)
  }));
}

function shouldSeparatePdfColumnLine(previous: PdfBuiltLine | undefined, item: PdfPageItem, pageWidth: number = 0) {
  if (!previous || !(pageWidth > 0)) return false;
  const current = { x0: item.rect.x, x1: item.rect.x + item.rect.width };
  const gap = Math.max(previous.x0, current.x0) - Math.min(previous.x1, current.x1);
  const lineHeight = Math.max(previous.height || 0, item.rect.height || 0, 1);
  if (gap <= lineHeight) return false;

  const middle = pageWidth / 2;
  const previousCenter = (previous.x0 + previous.x1) / 2;
  const currentCenter = (current.x0 + current.x1) / 2;
  return (previousCenter < middle && currentCenter > middle) ||
    (previousCenter > middle && currentCenter < middle);
}

function createPdfLine(item: PdfPageItem) {
  const line: PdfBuiltLine = {
    x0: item.rect.x,
    x1: item.rect.x + item.rect.width,
    y0: item.rect.y0,
    y1: item.rect.y1,
    centerY: (item.rect.y0 + item.rect.y1) / 2,
    height: item.rect.height,
    segments: []
  };
  addPdfLineSegment(line, item);
  return line;
}

function addPdfLineSegment(line: PdfBuiltLine, item: PdfPageItem) {
  line.segments.push(item);
  line.x0 = Math.min(line.x0, item.rect.x);
  line.x1 = Math.max(line.x1, item.rect.x + item.rect.width);
  line.y0 = Math.min(line.y0, item.rect.y0);
  line.y1 = Math.max(line.y1, item.rect.y1);
  line.centerY = (line.y0 + line.y1) / 2;
  line.height = Math.max(line.height, item.rect.height);
}

function orderPdfLines(lines: PdfBuiltLine[], pageWidth: number) {
  const sorted = [...lines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  if (!isTwoColumnPage(sorted, pageWidth)) return sorted;

  const columnLines = sorted.filter((line) => !isPdfFullWidthLine(line, pageWidth));
  if (columnLines.length === 0) return sorted;

  const firstColumnY = Math.min(...columnLines.map((line) => line.y0));
  const lastColumnY = Math.max(...columnLines.map((line) => line.y0));
  const fullBefore = sorted.filter((line) => isPdfFullWidthLine(line, pageWidth) && line.y0 < firstColumnY);
  const fullAfter = sorted.filter((line) => isPdfFullWidthLine(line, pageWidth) && line.y0 > lastColumnY);
  const fullMiddle = sorted.filter((line) => (
    isPdfFullWidthLine(line, pageWidth) &&
    line.y0 >= firstColumnY &&
    line.y0 <= lastColumnY
  ));
  const middle = pageWidth / 2;
  const left = columnLines.filter((line) => (line.x0 + line.x1) / 2 < middle);
  const right = columnLines.filter((line) => (line.x0 + line.x1) / 2 >= middle);
  if (right[0]) right[0] = { ...right[0], columnBreak: true };

  return [...fullBefore, ...left, ...right, ...fullMiddle, ...fullAfter];
}

function isTwoColumnPage(lines: PdfBuiltLine[], pageWidth: number) {
  if (lines.length < 12) return false;
  const middle = pageWidth / 2;
  const left = lines.filter((line) => line.x1 < middle * 1.12);
  const right = lines.filter((line) => line.x0 > middle * 0.88);
  const full = lines.filter((line) => isPdfFullWidthLine(line, pageWidth));
  return left.length >= 4 && right.length >= 4 && left.length + right.length > full.length * 2;
}

function isPdfFullWidthLine(line: PdfBuiltLine, pageWidth: number) {
  const width = line.x1 - line.x0;
  const crossesMiddle = line.x0 < pageWidth * 0.38 && line.x1 > pageWidth * 0.62;
  return width > pageWidth * 0.58 || crossesMiddle;
}

function pdfLineSeparator(previousLine: PdfBuiltLine | null, line: PdfBuiltLine) {
  if (!previousLine) return '';
  if (line.columnBreak) return '\n\n';
  const gap = Math.max(0, line.y0 - previousLine.y0);
  const lineHeight = Math.max(previousLine.height || 0, line.height || 0, 8);
  return gap > lineHeight * 2.3 ? '\n\n' : '\n';
}

function needsPdfSegmentSpace(previous: PdfPageItem, next: PdfPageItem) {
  const gap = next.rect.x - (previous.rect.x + previous.rect.width);
  if (gap <= Math.max(1, previous.rect.height * 0.18)) return false;
  const previousChar = previous.text.at(-1) || '';
  const nextChar = next.text[0] || '';
  if (isCjk(previousChar) && isCjk(nextChar)) return false;
  if (/^[，。？！；：、）】》」』,.!?;:%)]$/u.test(nextChar)) return false;
  return true;
}

function isImageOnlyPdf(text: string, pageCount: number) {
  const visible = String(text || '').replace(/\s+/gu, '');
  const letters = visible.match(/[\p{L}\p{N}]/gu)?.length || 0;
  return letters < Math.max(40, Number(pageCount || 1) * 8);
}

async function buildPdfSourceBlocks(pdf: PdfDocumentProxy, rawMarkdown: string, rawLines: PdfTextLine[], normalized: { offsetMap: Map<number, number>; chars: PdfChar[] }) {
  const lines = normalizePdfLines(rawMarkdown, rawLines, normalized.offsetMap);
  const outlineBlocks = await pdfOutlineBlocks(pdf, rawMarkdown, normalized.chars);
  const headingBlocks = outlineBlocks.length > 0 ? outlineBlocks : inferredPdfHeadingBlocks(lines);
  const headingKeys = new Set(headingBlocks.map((block) => `${block.start}:${block.end}`));
  const blocks: PdfBlock[] = [];
  let group: PdfTextLine[] = [];

  function flushGroup() {
    if (group.length === 0) return;
    blocks.push({
      type: 'paragraph',
      start: group[0].start,
      end: group.at(-1)!.end,
      lines: group.map((line) => ({ start: line.start, end: line.end }))
    });
    group = [];
  }

  for (const line of lines) {
    const heading = headingBlocks.find((block) => block.start === line.start && block.end === line.end);
    if (heading) {
      flushGroup();
      blocks.push(heading);
      continue;
    }
    if (headingKeys.has(`${line.start}:${line.end}`) || isPdfPageNumberLine(line.text)) continue;
    if (group.length > 0 && rawMarkdown.slice(group.at(-1)!.end, line.start).includes('\n\n')) flushGroup();
    group.push(line);
  }
  flushGroup();

  for (const heading of headingBlocks) {
    if (!blocks.includes(heading)) blocks.push(heading);
  }
  return blocks.sort((left, right) => left.start - right.start || headingLevel(left) - headingLevel(right));
}

function normalizePdfLines(rawMarkdown: string, rawLines: PdfTextLine[], offsetMap: Map<number, number>) {
  return (rawLines || [])
    .map((line) => {
      const start = mappedOffset(offsetMap, line.start, line.end, 1);
      const end = mappedOffset(offsetMap, line.end - 1, line.start - 1, -1);
      if (start == null || end == null || end < start) return null;
      const blockEnd = Math.min(rawMarkdown.length, end + 1);
      const text = rawMarkdown.slice(start, blockEnd).trim();
      if (!text) return null;
      return { ...line, start, end: blockEnd, text };
    })
    .filter(Boolean) as PdfTextLine[];
}

function mappedOffset(offsetMap: Map<number, number>, start: number, stop: number, step: number) {
  for (let index = start; step > 0 ? index < stop : index > stop; index += step) {
    const mapped = offsetMap.get(index);
    if (Number.isInteger(mapped)) return mapped;
  }
  return null;
}

async function pdfOutlineBlocks(pdf: PdfDocumentProxy, rawMarkdown: string, chars: PdfChar[]) {
  const outline = await pdf.getOutline().catch(() => null);
  if (!Array.isArray(outline) || outline.length === 0) return [];
  const pageStarts = pdfPageStarts(chars);
  const blocks: PdfBlock[] = [];

  async function walk(items: PdfOutlineItem[], level: number) {
    for (const item of items || []) {
      const title = String(item?.title || '').trim();
      const pageNumber = await pdfOutlinePageNumber(pdf, item);
      const approx = pageStarts.get(pageNumber!) ?? 0;
      const range = findPdfTitleRange(rawMarkdown, title, approx);
      if (title && range) {
        blocks.push({
          type: 'heading',
          level,
          start: range.start,
          end: range.end,
          contentStart: range.start,
          contentEnd: range.end,
          text: title
        });
      }
      if (item?.items?.length) await walk(item.items, level + 1);
    }
  }

  await walk(outline, 1);
  return blocks;
}

function pdfPageStarts(chars: PdfChar[]) {
  const starts = new Map<number, number>();
  for (const item of chars || []) {
    const pageNumber = Number(item.pageNumber);
    const offset = Number(item.charOffset);
    if (!Number.isFinite(pageNumber) || !Number.isFinite(offset)) continue;
    starts.set(pageNumber, Math.min(starts.get(pageNumber) ?? offset, offset));
  }
  return starts;
}

async function pdfOutlinePageNumber(pdf: PdfDocumentProxy, item: PdfOutlineItem) {
  const dest = typeof item?.dest === 'string'
    ? await pdf.getDestination(item.dest).catch(() => null)
    : item?.dest;
  const ref: unknown = Array.isArray(dest) ? dest[0] : null;
  if (!ref) return null;
  const pageIndex = await pdf.getPageIndex(ref).catch(() => null);
  return pageIndex != null ? pageIndex + 1 : null;
}

function findPdfTitleRange(rawMarkdown: string, title: string, approx: number) {
  const text = String(title || '').trim();
  if (!text) return null;
  const start = Math.max(0, Number(approx) || 0);
  const local = rawMarkdown.indexOf(text, start);
  const index = local >= 0 && local < start + 8000 ? local : rawMarkdown.indexOf(text);
  if (index >= 0) return { start: index, end: index + text.length };

  const compactTitle = compactPdfText(text);
  let cursor = start;
  while (cursor < Math.min(rawMarkdown.length, start + 12000)) {
    const end = rawMarkdown.indexOf('\n', cursor);
    const lineEnd = end === -1 ? rawMarkdown.length : end;
    const line = rawMarkdown.slice(cursor, lineEnd);
    if (compactPdfText(line) === compactTitle) return { start: cursor, end: lineEnd };
    cursor = lineEnd + 1;
  }
  return null;
}

// 没有原生 outline 时的兜底：先字号、字号没区分度再加粗+缩进，全程不看文字内容（删了 ◆ / 第X章 / Chapter 文字 pattern）。
// 字号穷举分级——论文字号种类有限，按字符加权取众数即正文，比众数大的字号从大到小直接排 L1/L2/…（无 1.3 阈值）；
// 与正文同字号的行再看「加粗 + 顶格（缩进信号）+ 短」，不纯靠加粗，加粗档排在字号档之后。逆天结构交智能导入收拾。
function inferredPdfHeadingBlocks(lines: PdfTextLine[]) {
  const candidates = (lines || []).filter((line) => {
    const text = String(line?.text || '').trim();
    return text && !isPdfPageNumberLine(text) && text.length <= 80;
  });
  if (candidates.length === 0) return [];

  const weights = new Map<number, number>();
  for (const line of candidates) {
    const height = Math.round(Number(line.height));
    if (Number.isFinite(height)) weights.set(height, (weights.get(height) || 0) + [...line.text].length);
  }
  const bodyHeight = dominantPdfHeight(weights);
  const headingSizes = bodyHeight == null ? [] : [...new Set(candidates
    .map((line) => Math.round(Number(line.height)))
    .filter((height) => Number.isFinite(height) && height > bodyHeight))]
    .sort((a, b) => b - a);
  const leftMargin = modePdfLeft(candidates);
  const boldLevel = headingSizes.length + 1;

  const headings: PdfBlock[] = [];
  for (const line of candidates) {
    const height = Math.round(Number(line.height));
    let level = 0;
    if (bodyHeight != null && height > bodyHeight) {
      level = headingSizes.indexOf(height) + 1;
    } else if (line.bold && isPdfTopAligned(line, leftMargin) && line.text.length <= 40) {
      level = boldLevel;
    }
    if (level > 0) {
      headings.push({
        type: 'heading',
        level,
        start: line.start,
        end: line.end,
        contentStart: line.start,
        contentEnd: line.end,
        text: line.text.replace(/\s+/gu, '')
      });
    }
  }
  return headings;
}

function dominantPdfHeight(weights: Map<number, number>) {
  let best: number | null = null;
  let bestWeight = -1;
  for (const [height, weight] of weights) {
    if (weight > bestWeight) { bestWeight = weight; best = height; }
  }
  return best;
}

function modePdfLeft(lines: PdfTextLine[]) {
  const counts = new Map<number, number>();
  for (const line of lines) {
    const x0 = Math.round(Number(line.x0));
    if (Number.isFinite(x0)) counts.set(x0, (counts.get(x0) || 0) + 1);
  }
  let best: number | null = null;
  let bestCount = -1;
  for (const [x0, count] of counts) {
    if (count > bestCount) { bestCount = count; best = x0; }
  }
  return best;
}

function isPdfTopAligned(line: PdfTextLine, leftMargin: number | null) {
  if (leftMargin == null) return true;
  const tolerance = Math.max(2, (Number(line.height) || 10) * 0.6);
  return Math.abs(Number(line.x0) - leftMargin) <= tolerance;
}

function isPdfPageNumberLine(text: string) {
  const compact = String(text || '').replace(/\s+/gu, '');
  return /^\d{1,4}$/.test(compact) || /^第?\d{1,4}页$/.test(compact);
}

function compactPdfText(text: string) {
  return String(text || '').replace(/\s+/gu, '').toLowerCase();
}

function headingLevel(block: PdfBlock | undefined) {
  return block?.type === 'heading' ? Math.max(1, Number(block.level) || 1) : 99;
}

export function normalizePdfTextLayer(rawText: string, chars: PdfChar[] = []) {
  const input = normalizeSourceMarkdown(rawText);
  const offsetMap = new Map<number, number>();
  let output = '';
  let lineStartHard = true;

  function appendMappedChar(index: number, char: string = input[index]) {
    offsetMap.set(index, output.length);
    output += char;
  }

  function appendSeparator(separator: string) {
    if (!separator) return;
    if (separator === '\n\n') {
      output = output.replace(/[ \t]+$/u, '').replace(/\n*$/u, '') + '\n\n';
      return;
    }
    if (separator === '\n') {
      output = output.replace(/[ \t]+$/u, '');
      if (!output.endsWith('\n')) output += '\n';
      return;
    }
    if (!/[ \n]$/u.test(output)) output += separator;
  }

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (char === '\n') {
      let next = index + 1;
      while (next < input.length && input[next] === '\n') next += 1;
      if (next - index > 1) {
        appendSeparator('\n\n');
        lineStartHard = true;
        index = next - 1;
        continue;
      }
      const nextIndex = nextNonSpaceIndex(input, next);
      const nextLine = lineTextAfter(input, nextIndex);
      const separator = pdfLineBreakSeparator(
        lastVisibleChar(output),
        input[nextIndex] || '',
        lineTextBefore(input, index),
        lineStartHard,
        nextLine
      );
      appendSeparator(separator);
      lineStartHard = separator.includes('\n');
      index = (nextIndex || next) - 1;
      continue;
    }

    if (char === ' ' || char === '\t') {
      const previous = lastVisibleChar(output);
      const nextIndex = nextNonSpaceIndex(input, index + 1, true);
      const next = input[nextIndex] || '';
      if (isCjk(previous) && isCjk(next)) continue;
      if (!/[ \n]$/u.test(output)) appendMappedChar(index, ' ');
      continue;
    }

    appendMappedChar(index);
  }

  const normalizedChars = (chars || [])
    .map((item) => {
      const offset = offsetMap.get(Number(item.charOffset));
      return Number.isInteger(offset) ? { ...item, charOffset: offset } : null;
    })
    .filter(Boolean) as PdfChar[];

  return { text: output.trimEnd(), chars: normalizedChars, offsetMap };
}

function nextNonSpaceIndex(text: string, start: number, stopAtNewline: boolean = false) {
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (stopAtNewline && char === '\n') return index;
    if (char !== ' ' && char !== '\t') return index;
    index += 1;
  }
  return text.length;
}

function lastVisibleChar(text: string) {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (!/\s/u.test(text[index])) return text[index];
  }
  return '';
}

function lineTextBefore(text: string, end: number) {
  const start = text.lastIndexOf('\n', end - 1) + 1;
  return text.slice(start, end).trim();
}

function lineTextAfter(text: string, start: number) {
  const end = text.indexOf('\n', start);
  return text.slice(start, end === -1 ? text.length : end).trim();
}

function pdfLineBreakSeparator(previous: string, next: string, previousLine: string, lineStartHard: boolean, nextLine: string = '') {
  if (isPdfShortHeading(nextLine)) return '\n\n';
  if (lineStartHard && isPdfShortHeading(previousLine)) return '\n\n';
  if (!previous || !next) return '\n';
  if (/[。！？!?；;：:]$/u.test(previous)) return '\n';
  if (/^[、，。！？!?；;：:）)】》〉」』"”'’]/u.test(next)) return '';
  if (isCjk(previous) && isCjk(next)) return '';
  return ' ';
}

function isCjk(char: string) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char || '');
}

function isPdfShortHeading(text: string) {
  const raw = String(text || '');
  const trimmed = raw.replace(/[ \t]+/gu, '');
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}][ \t]+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/u.test(raw) && trimmed.length <= 12) {
    return !/[。！？；，、,.!?;:"""''()[\]【】《》]/u.test(trimmed);
  }
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}][ \t]+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])/u.test(raw)) {
    return false;
  }
  return trimmed.length > 0 &&
    trimmed.length <= 32 &&
    !/[。！？!?；;：:，、,.()[\]【】《》]/u.test(trimmed);
}

function textItemRect(item: PdfTextContentItem, viewport: PdfViewport): PdfRect | null {
  const text = String(item.str || '');
  if (!text) return null;
  const transform = Util.transform(viewport.transform, item.transform);
  const x = Number(transform[4]);
  const baselineY = Number(transform[5]);
  const width = Math.abs(Number(item.width)) || Math.hypot(transform[0], transform[1]) * text.length;
  const height = Math.abs(Number(item.height)) || Math.hypot(transform[2], transform[3]) || 10;
  if (![x, baselineY, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return {
    x,
    y0: baselineY - height * 0.82,
    y1: baselineY + height * 0.18,
    width,
    height
  };
}

function charRectForItem(rect: PdfRect, index: number, total: number) {
  const count = Math.max(1, total);
  const charWidth = rect.width / count;
  const x0 = rect.x + charWidth * index;
  return {
    x0,
    y0: rect.y0,
    x1: x0 + charWidth,
    y1: rect.y1
  };
}
