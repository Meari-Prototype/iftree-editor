// 统一 markdown 富文本渲染的「值型」解析（无版面格式——树 / 码 / 富 md / agent——共用一处渲染）。
//
// 块边界识别复用 source-markdown 的 parseSourceMarkdownBlocks（单一来源，不再另写一套表格 / 列表 /
// 代码 / 引用识别）；这里把它的「坐标型」block（只记原文偏移、为句子 span 映射服务）适配成「值型」block
// （自带可渲染的 inline tokens），不依赖 sourceSpans / 虚拟滚动。inline 走 markdown.mjs 的 parseInline
// （同一套语法）。坐标型那条（SourceBlocks + span）只为 PDF / Word 这类有版面位置的源保留。
import { parseInline } from './markdown.mjs';
import { normalizeSourceMarkdown, parseSourceMarkdownBlocks } from './source-markdown.mjs';

function inlineFromRange(raw, start, end) {
  return parseInline(raw.slice(start, end).trim());
}

// 段落 / 引用的多物理行：逐行 trim 后用单空格连接（与 SourceBlocks 段内换行处理一致）。
// 不对整体压空白——否则 inline code 内的连续空格会被吞掉。
function inlineFromLines(raw, lines) {
  const text = (lines || [])
    .map((line) => raw.slice(line.start, line.end).trim())
    .filter(Boolean)
    .join(' ');
  return parseInline(text);
}

function cellInline(raw, cell) {
  const text = typeof cell.text === 'string' ? cell.text : raw.slice(cell.start, cell.end);
  return parseInline(String(text).trim());
}

function richTableFromSource(block, raw) {
  const rows = Array.isArray(block.rows) ? block.rows : [];
  const hasHeader = rows[1]?.separator === true;
  const headerRow = hasHeader ? rows[0] : null;
  const bodyRows = (hasHeader ? rows.slice(2) : rows).filter((row) => !row.separator);
  const toCells = (row) => (row?.cells || []).map((cell) => cellInline(raw, cell));
  return {
    type: 'table',
    header: headerRow ? toCells(headerRow) : null,
    rows: bodyRows.map(toCells)
  };
}

// source-markdown 的 code block.text 是逐行 trim 拼的、丢了行首缩进（它为句子边界服务）。
// 富文本渲染要保留缩进：从原文整段切、剥掉首尾围栏行。
function codeBlockText(raw, block) {
  const lines = raw.slice(block.start, block.end).split('\n');
  if (lines.length > 0 && /^(```|~~~)/.test(lines[0].trim())) lines.shift();
  if (lines.length > 0 && /^(```|~~~)/.test(lines[lines.length - 1].trim())) lines.pop();
  return lines.join('\n');
}

// 有序 / 无序：source-markdown 的 list 不存 marker，但 block.start..items[0].start 之间就是首行
// 「缩进 + marker + 空格」，据此判断，无需改动共享 parser。
function listOrdered(raw, block) {
  const first = block.items?.[0];
  if (!first) return false;
  return /\d+[.)]\s*$/.test(raw.slice(block.start, first.start));
}

export function parseRichMarkdown(markdown) {
  const raw = normalizeSourceMarkdown(markdown);
  const result = [];
  for (const block of parseSourceMarkdownBlocks(raw)) {
    if (block.type === 'heading') {
      result.push({
        type: 'heading',
        level: Math.min(Math.max(Number(block.level) || 1, 1), 6),
        inline: parseInline(String(block.text || ''))
      });
    } else if (block.type === 'paragraph') {
      const inline = inlineFromLines(raw, block.lines);
      if (inline.length > 0) result.push({ type: 'paragraph', inline });
    } else if (block.type === 'blockquote') {
      const inline = inlineFromLines(raw, block.lines);
      if (inline.length > 0) result.push({ type: 'blockquote', inline });
    } else if (block.type === 'list') {
      const items = (block.items || [])
        .map((item) => ({ inline: inlineFromRange(raw, item.start, item.end) }))
        .filter((item) => item.inline.length > 0);
      if (items.length > 0) result.push({ type: 'list', ordered: listOrdered(raw, block), items });
    } else if (block.type === 'table' || block.type === 'html_table') {
      const table = richTableFromSource(block, raw);
      if (table.rows.length > 0 || table.header) result.push(table);
    } else if (block.type === 'code') {
      result.push({ type: 'code', language: String(block.language || '').trim(), text: codeBlockText(raw, block) });
    } else if (block.type === 'math') {
      result.push({ type: 'math', text: String(block.text || '') });
    } else if (block.type === 'image') {
      result.push({ type: 'image', src: String(block.src || ''), alt: String(block.alt || '') });
    }
  }
  return result;
}

// 提取全部图片源（顶层 image 块 + 段落 / 表格 / 列表内的 inline image），供 asset 解析预取。
export function richMarkdownImageSources(blocks) {
  const sources = [];
  const pushInline = (tokens) => {
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
