import { parseInline } from './markdown.js';
import { normalizeSourceMarkdown, parseSourceMarkdownBlocks } from './source-markdown.js';

interface SourceRange {
  start: number;
  end: number;
}

interface SourceCell {
  text?: string;
  start: number;
  end: number;
}

interface SourceCodeBlock {
  type: string;
  start: number;
  end: number;
}

interface SourceHeadingBlock {
  type: string;
  level: unknown;
  text: string;
}

interface SourceParagraphBlock {
  type: string;
  lines: SourceRange[];
}

interface SourceBlockquoteBlock {
  type: string;
  lines: SourceRange[];
}

interface SourceListBlock {
  type: string;
  start: number;
  items: SourceRange[];
}

interface SourceTableBlock {
  type: string;
  rows: Array<{
    separator?: boolean;
    cells?: SourceCell[];
  }>;
}

interface SourceTableCellBlock {
  type: string;
  language: unknown;
}

interface SourceMathBlock {
  type: string;
  text: string;
}

interface SourceImageBlock {
  type: string;
  src: string;
  alt: string;
}

type SourceBlock =
  | SourceHeadingBlock
  | SourceParagraphBlock
  | SourceBlockquoteBlock
  | SourceListBlock
  | SourceTableBlock
  | SourceTableCellBlock
  | SourceMathBlock
  | SourceImageBlock
  | SourceCodeBlock;

export interface RichInline {
  [key: string]: unknown;
  type: string;
  text?: string;
  href?: string;
  src?: string;
  alt?: string;
}

export interface RichBlock {
  type: string;
  level?: number;
  inline?: RichInline[];
  ordered?: boolean;
  items?: Array<{ inline: RichInline[] }>;
  rows?: RichInline[][][];
  header?: RichInline[][] | null;
  language?: string;
  text?: string;
  src?: string;
  alt?: string;
}

function inlineFromRange(raw: string, start: number, end: number): RichInline[] {
  return parseInline(raw.slice(start, end).trim()) as unknown as RichInline[];
}

function inlineFromLines(raw: string, lines: SourceRange[]): RichInline[] {
  const text = (lines || [])
    .map((line) => raw.slice(line.start, line.end).trim())
    .filter(Boolean)
    .join(' ');
  return parseInline(text) as unknown as RichInline[];
}

function cellInline(raw: string, cell: SourceCell): RichInline[] {
  const text = typeof cell.text === 'string' ? cell.text : raw.slice(cell.start, cell.end);
  return parseInline(String(text).trim()) as unknown as RichInline[];
}

function richTableFromSource(block: SourceTableBlock, raw: string): RichBlock {
  const rows = Array.isArray(block.rows) ? block.rows : [];
  const hasHeader = rows[1]?.separator === true;
  const headerRow = hasHeader ? rows[0] : null;
  const bodyRows = (hasHeader ? rows.slice(2) : rows).filter((row) => !row.separator);
  const toCells = (row: typeof rows[0]) => (row?.cells || []).map((cell) => cellInline(raw, cell));
  return {
    type: 'table',
    header: headerRow ? toCells(headerRow) : null,
    rows: bodyRows.map(toCells)
  };
}

function codeBlockText(raw: string, block: SourceCodeBlock): string {
  const lines = raw.slice(block.start, block.end).split('\n');
  if (lines.length > 0 && /^(```|~~~)/.test(lines[0].trim())) lines.shift();
  if (lines.length > 0 && /^(```|~~~)/.test(lines[lines.length - 1].trim())) lines.pop();
  return lines.join('\n');
}

function listOrdered(raw: string, block: SourceListBlock): boolean {
  const first = block.items?.[0];
  if (!first) return false;
  return /\d+[.)]\s*$/.test(raw.slice(block.start, first.start));
}

export function parseRichMarkdown(markdown: unknown): RichBlock[] {
  const raw = normalizeSourceMarkdown(markdown);
  const result: RichBlock[] = [];
  for (const block of parseSourceMarkdownBlocks(raw) as SourceBlock[]) {
    if (block.type === 'heading') {
      result.push({
        type: 'heading',
        level: Math.min(Math.max(Number((block as SourceHeadingBlock).level) || 1, 1), 6),
        inline: parseInline(String((block as SourceHeadingBlock).text || '')) as unknown as RichInline[]
      });
    } else if (block.type === 'paragraph') {
      const inline = inlineFromLines(raw, (block as SourceParagraphBlock).lines);
      if (inline.length > 0) result.push({ type: 'paragraph', inline });
    } else if (block.type === 'blockquote') {
      const inline = inlineFromLines(raw, (block as SourceBlockquoteBlock).lines);
      if (inline.length > 0) result.push({ type: 'blockquote', inline });
    } else if (block.type === 'list') {
      const listBlock = block as SourceListBlock;
      const items = (listBlock.items || [])
        .map((item) => ({ inline: inlineFromRange(raw, item.start, item.end) }))
        .filter((item) => item.inline.length > 0);
      if (items.length > 0) result.push({ type: 'list', ordered: listOrdered(raw, listBlock), items });
    } else if (block.type === 'table' || block.type === 'html_table') {
      const table = richTableFromSource(block as SourceTableBlock, raw);
      if (table.rows!.length > 0 || table.header) result.push(table);
    } else if (block.type === 'code') {
      result.push({ type: 'code', language: String((block as SourceTableCellBlock).language || '').trim(), text: codeBlockText(raw, block as SourceCodeBlock) });
    } else if (block.type === 'math') {
      result.push({ type: 'math', text: String((block as SourceMathBlock).text || '') });
    } else if (block.type === 'image') {
      result.push({ type: 'image', src: String((block as SourceImageBlock).src || ''), alt: String((block as SourceImageBlock).alt || '') });
    }
  }
  return result;
}

export function richMarkdownImageSources(blocks: RichBlock[]): string[] {
  const sources: string[] = [];
  const pushInline = (tokens: RichInline[]) => {
    for (const token of tokens || []) {
      if (token?.type === 'image' && token.src) sources.push(token.src);
    }
  };
  for (const block of blocks || []) {
    if (block.type === 'image' && block.src) sources.push(block.src);
    else if (Array.isArray(block.inline)) pushInline(block.inline);
    else if (block.type === 'list') for (const item of block.items || []) pushInline(item.inline);
    else if (block.type === 'table') {
      for (const cell of block.header || []) pushInline(cell);
      for (const row of block.rows || []) for (const cell of row) pushInline(cell);
    }
  }
  return [...new Set(sources)];
}