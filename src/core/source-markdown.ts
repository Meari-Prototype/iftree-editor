import { splitSentenceSpans } from './sentence-split.js';
import { appendSpans } from './source-spans.js';

export function normalizeSourceMarkdown(markdown: unknown) {
  return String(markdown || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\uFEFF/, '');
}

export function normalizeImportBaseName(fileName: unknown) {
  let name = String(fileName || '').split(/[\\/]/).pop() || '';
  name = name.replace(/\.[^.]+$/i, '');
  let previous: string | null = null;
  while (previous !== name) {
    previous = name;
    name = name.replace(/_(sentences|with_vectors|structured|fixed)$/i, '');
  }
  return name || String(fileName || '');
}

export function buildSourceDocument({ sourcePath = null, sourceType = 'md', rawMarkdown = '' }: { sourcePath?: string | null; sourceType?: string; rawMarkdown?: string } = {}) {
  const normalized = normalizeSourceMarkdown(rawMarkdown);
  const blocks = parseSourceMarkdownBlocks(normalized);
  return {
    sourcePath,
    sourceType,
    rawMarkdown: normalized,
    blocks,
    spans: sourceSpansFromMarkdown(normalized, { blocks })
  };
}

export function inspectMarkdownStructure(sourceDocumentOrMarkdown: any) {
  const sourceDocument = typeof sourceDocumentOrMarkdown === 'string'
    ? buildSourceDocument({ rawMarkdown: sourceDocumentOrMarkdown })
    : sourceDocumentOrMarkdown;
  const rawMarkdown = normalizeSourceMarkdown(sourceDocument?.rawMarkdown || sourceDocument?.raw_markdown || '');
  const blocks = sourceDocument?.blocks || parseSourceMarkdownBlocks(rawMarkdown);
  const headings = blocks.filter((block: any) => block.type === 'heading');
  const hasContentStructure = blocks.some((block: any) => block.type !== 'heading');
  return {
    blockCount: blocks.length,
    headingCount: headings.length,
    hasStructure: headings.length > 1 || (headings.length === 1 && hasContentStructure)
  };
}

export function buildMarkdownStructureRecords(sourceDocumentOrMarkdown: any, options: any = {}) {
  const sourceDocument = typeof sourceDocumentOrMarkdown === 'string'
    ? buildSourceDocument({ rawMarkdown: sourceDocumentOrMarkdown })
    : sourceDocumentOrMarkdown;
  const rawMarkdown = normalizeSourceMarkdown(sourceDocument?.rawMarkdown || sourceDocument?.raw_markdown || '');
  const blocks = sourceDocument?.blocks || parseSourceMarkdownBlocks(rawMarkdown);
  const spans = sourceDocument?.spans || sourceSpansFromMarkdown(rawMarkdown, { blocks });
  const spanReader = createSpanRangeReader(spans);
  const granularity = options.granularity === 'paragraph' ? 'paragraph' : 'sentence';
  const records: any[] = [];
  const counters = new Map<string, number>();
  const headingStack: { level: number; address: string }[] = [];

  function nextAddress(parentAddress: string) {
    const key = parentAddress || '';
    const next = (counters.get(key) || 0) + 1;
    counters.set(key, next);
    return key ? `${key}-${next}` : String(next);
  }

  function addRecord(parentAddress: string, patch: any) {
    const address = nextAddress(parentAddress);
    const record: any = {
      address,
      text: patch.text || '',
      nodeType: patch.nodeType || 'TEXT',
      trustLevel: patch.trustLevel || null,
      sourcePosition: patch.sourcePosition ?? null,
      role: patch.role || 'text',
      skipVector: patch.skipVector === true,
      vector: patch.vector || null
    };
    if (patch.index != null) record.index = patch.index;
    if (Array.isArray(patch.indexes)) record.indexes = patch.indexes;
    records.push(record);
    return record;
  }

  function currentParentAddress() {
    return headingStack.at(-1)?.address || '';
  }

  function addHeading(block: any) {
    const level = Math.max(1, Number(block.level) || 1);
    while (headingStack.length > 0 && headingStack.at(-1)!.level >= level) headingStack.pop();
    const headingSpans = spanReader(block.contentStart, block.contentEnd);
    const firstSpan = headingSpans[0] || null;
    const record = addRecord(currentParentAddress(), {
      text: headingText(block, rawMarkdown),
      index: firstSpan?.sentence_index ?? null,
      sourcePosition: firstSpan?.sentence_index ?? null,
      role: 'heading'
    });
    headingStack.push({ level, address: record.address });
  }

  function addParagraphFromRange(start: number, end: number) {
    const paragraphSpans = spanReader(start, end);
    if (paragraphSpans.length === 0) return;
    const firstIndex = Number(paragraphSpans[0].sentence_index);
    if (granularity === 'paragraph') {
      addRecord(currentParentAddress(), {
        text: rawMarkdown.slice(start, end).trim(),
        index: Number.isFinite(firstIndex) ? firstIndex : null,
        indexes: paragraphSpans.map((span: any) => span.sentence_index),
        sourcePosition: Number.isFinite(firstIndex) ? firstIndex - 0.5 : null,
        role: 'paragraph'
      });
      return;
    }
    const paragraph = addRecord(currentParentAddress(), {
      text: '',
      index: Number.isFinite(firstIndex) ? firstIndex : null,
      indexes: paragraphSpans.map((span: any) => span.sentence_index),
      sourcePosition: Number.isFinite(firstIndex) ? firstIndex - 0.5 : null,
      role: 'paragraph',
      skipVector: true
    });
    for (const span of paragraphSpans) {
      addRecord(paragraph.address, {
        text: span.text || rawMarkdown.slice(span.start_offset, span.end_offset),
        index: span.sentence_index,
        sourcePosition: span.sentence_index,
        role: 'sentence'
      });
    }
  }

  for (const block of blocks) {
    if (block.type === 'heading') {
      addHeading(block);
    } else if (block.type === 'math') {
      addRecord(currentParentAddress(), {
        text: rawMarkdown.slice(block.start, block.end).trim(),
        role: 'math',
        skipVector: true
      });
    } else if (block.type === 'paragraph' || block.type === 'blockquote') {
      const lines = block.lines || [];
      if (lines.length > 0) addParagraphFromRange(lines[0].start, lines[lines.length - 1].end);
    } else if (block.type === 'list') {
      for (const item of block.items || []) addParagraphFromRange(item.start, item.end);
    } else if (block.type === 'table' || block.type === 'html_table') {
      const hasHeaderSeparator = block.rows[1]?.separator === true;
      const rows = hasHeaderSeparator ? block.rows.slice(2) : block.rows;
      for (const row of rows) {
        if (row.separator) continue;
        const cells = row.cells || [];
        if (cells.length > 0) addParagraphFromRange(cells[0].start, cells[cells.length - 1].end);
      }
    } else if (block.type === 'image') {
      addRecord(currentParentAddress(), {
        text: rawMarkdown.slice(block.start, block.end),
        role: 'media',
        skipVector: true
      });
    } else if (block.type === 'code' && isPlainTextCodeBlock(block)) {
      addTextCodeParagraphs(block);
    } else if (block.type === 'code') {
      addRecord(currentParentAddress(), {
        text: fencedCodeText(block),
        role: 'code',
        skipVector: true
      });
    }
  }

  return records;

  function addTextCodeParagraphs(block: any) {
    let group: any[] = [];
    function flush() {
      if (group.length > 0) {
        addParagraphFromRange(group[0].start, group.at(-1).end);
        group = [];
      }
    }
    for (const line of block.lines || []) {
      if (!line) {
        flush();
        continue;
      }
      group.push(line);
    }
    flush();
  }
}

export function sourceSpansFromMarkdown(markdown: string, options: any = {}) {
  const rawMarkdown = normalizeSourceMarkdown(markdown);
  const blocks = options.blocks || parseSourceMarkdownBlocks(rawMarkdown);
  const spans: any[] = [];

  function addRange(start: number, end: number) {
    const segment = rawMarkdown.slice(start, end);
    const segmentSpans = splitSentenceSpans(segment, { splitAsciiPunctuation: true, hardLineBreaks: options.hardLineBreaks === true });
    appendSpans(spans, start, segmentSpans);
  }

  function addExactRange(start: number, end: number) {
    const range = trimAbsoluteRange(rawMarkdown.slice(start, end), start, end);
    if (!range) return;
    spans.push({
      sentence_index: spans.length + 1,
      start_offset: range.start,
      end_offset: range.end,
      text: rawMarkdown.slice(range.start, range.end)
    });
  }

  for (const block of blocks) {
    if (block.type === 'heading') {
      addExactRange(block.contentStart, block.contentEnd);
    } else if (block.type === 'math') {
      addExactRange(block.contentStart, block.contentEnd);
    } else if (block.type === 'paragraph' || block.type === 'blockquote') {
      addLinesRange(block.lines);
    } else if (block.type === 'list') {
      for (const item of block.items || []) addRange(item.start, item.end);
    } else if (block.type === 'table' || block.type === 'html_table') {
      const hasHeaderSeparator = block.rows[1]?.separator === true;
      const rows = hasHeaderSeparator ? block.rows.slice(2) : block.rows;
      for (const row of rows) {
        if (row.separator) continue;
        for (const cell of row.cells) addRange(cell.start, cell.end);
      }
    } else if (block.type === 'code' && isPlainTextCodeBlock(block)) {
      for (const group of paragraphLineGroups(block.lines || [])) addLinesRange(group);
    }
  }

  return spans;

  function addLinesRange(lines: any) {
    if (!lines?.length) return;
    addRange(lines[0].start, lines[lines.length - 1].end);
  }
}

export function parseSourceMarkdownBlocks(markdown: string) {
  const rawMarkdown = normalizeSourceMarkdown(markdown);
  const lines = collectLines(rawMarkdown);
  const blocks: any[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.text.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    if (isFenceStart(trimmed)) {
      const fence = trimmed.slice(0, 3);
      const startLine = line;
      const codeLines: any[] = [];
      index += 1;
      while (index < lines.length && !lines[index].text.trim().startsWith(fence)) {
        codeLines.push(trimLineRange(lines[index]));
        index += 1;
      }
      const contentLines = codeLines.filter(Boolean);
      const endLine = index < lines.length ? lines[index] : (contentLines.at(-1) || startLine);
      blocks.push({
        type: 'code',
        start: startLine.start,
        end: endLine.end,
        contentStart: contentLines[0]?.start ?? startLine.end,
        contentEnd: contentLines.at(-1)?.end ?? startLine.end,
        language: trimmed.slice(3).trim(),
        lines: codeLines,
        text: codeLines.map((item) => item ? rawMarkdown.slice(item.start, item.end) : '').join('\n')
      });
      if (index < lines.length) index += 1;
      continue;
    }

    const math = mathBlock(lines, index, rawMarkdown);
    if (math) {
      blocks.push(math.block);
      index = math.nextIndex;
      continue;
    }

    const heading = headingBlock(line);
    if (heading) {
      blocks.push(heading);
      index += 1;
      continue;
    }

    if (isSeparatorLine(line.text)) {
      index += 1;
      continue;
    }

    const image = imageBlock(line);
    if (image) {
      blocks.push(image);
      index += 1;
      continue;
    }

    const htmlTable = htmlTableBlock(lines, index, rawMarkdown);
    if (htmlTable) {
      blocks.push(htmlTable.block);
      index = htmlTable.nextIndex;
      continue;
    }

    if (isTableStart(lines, index)) {
      const rows: any[] = [];
      const start = line.start;
      let end = line.end;
      while (index < lines.length && lines[index].text.trim() && lines[index].text.includes('|')) {
        const row = tableRow(lines[index]);
        rows.push(row);
        end = lines[index].end;
        index += 1;
      }
      blocks.push({ type: 'table', start, end, rows });
      continue;
    }

    if (listItemRange(line)) {
      const items: any[] = [];
      const start = line.start;
      let end = line.end;
      while (index < lines.length) {
        const item = listItemRange(lines[index]);
        if (!item) break;
        items.push(item);
        end = lines[index].end;
        index += 1;
      }
      blocks.push({ type: 'list', start, end, items });
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: any[] = [];
      const start = line.start;
      let end = line.end;
      while (index < lines.length && lines[index].text.trim().startsWith('>')) {
        const current = lines[index];
        const marker = current.text.indexOf('>');
        const range = trimAbsoluteRange(current.text, current.start + marker + 1, current.end);
        if (range) quoteLines.push(range);
        end = current.end;
        index += 1;
      }
      blocks.push({ type: 'blockquote', start, end, lines: quoteLines });
      continue;
    }

    const paragraphLines: any[] = [];
    const start = line.start;
    let end = line.end;
    while (index < lines.length && isParagraphLine(lines, index)) {
      const range = trimLineRange(lines[index]);
      if (range) paragraphLines.push(range);
      end = lines[index].end;
      index += 1;
    }
    blocks.push({ type: 'paragraph', start, end, lines: paragraphLines });
  }

  return blocks;
}

function collectLines(markdown: string) {
  const lines: any[] = [];
  let start = 0;

  while (start <= markdown.length) {
    const newline = markdown.indexOf('\n', start);
    const end = newline === -1 ? markdown.length : newline;
    lines.push({ start, end, text: markdown.slice(start, end) });
    if (newline === -1) break;
    start = newline + 1;
    if (start === markdown.length) break;
  }

  return lines;
}

function isFenceStart(trimmed: string) {
  return trimmed.startsWith('```') || trimmed.startsWith('~~~');
}

function mathBlock(lines: any[], index: number, rawMarkdown: string) {
  const line = lines[index];
  const trimmed = line.text.trim();
  const open = trimmed.startsWith('$$') ? '$$' : (trimmed.startsWith('\\[') ? '\\[' : null);
  if (!open) return null;
  const close = open === '$$' ? '$$' : '\\]';

  const openAt = line.text.indexOf(open);
  const closeAt = line.text.indexOf(close, openAt + open.length);
  if (closeAt > openAt) {
    const contentStart = line.start + openAt + open.length;
    const contentEnd = line.start + closeAt;
    const range = trimAbsoluteRange(rawMarkdown.slice(contentStart, contentEnd), contentStart, contentEnd);
    return {
      nextIndex: index + 1,
      block: {
        type: 'math',
        start: line.start,
        end: line.end,
        contentStart: range?.start ?? contentStart,
        contentEnd: range?.end ?? contentEnd,
        text: range ? rawMarkdown.slice(range.start, range.end) : ''
      }
    };
  }

  let closeIndex = index + 1;
  while (closeIndex < lines.length && !lines[closeIndex].text.trim().endsWith(close)) closeIndex += 1;
  const hasClose = closeIndex < lines.length;
  const contentLines = lines.slice(index + 1, hasClose ? closeIndex : lines.length);
  const firstContent = contentLines[0];
  const lastContent = contentLines.at(-1);
  const contentStart = firstContent?.start ?? (line.start + openAt + open.length);
  const contentEnd = lastContent?.end ?? contentStart;
  const range = trimAbsoluteRange(rawMarkdown.slice(contentStart, contentEnd), contentStart, contentEnd);
  const endLine = hasClose ? lines[closeIndex] : (lastContent || line);

  return {
    nextIndex: hasClose ? closeIndex + 1 : lines.length,
    block: {
      type: 'math',
      start: line.start,
      end: endLine.end,
      contentStart: range?.start ?? contentStart,
      contentEnd: range?.end ?? contentEnd,
      text: range ? rawMarkdown.slice(range.start, range.end) : ''
    }
  };
}

function headingBlock(line: any) {
  const match = line.text.match(/^(\s*)(#{1,6})(\s+)(.+?)\s*$/);
  if (!match) return null;
  const markerLength = match[1].length + match[2].length + match[3].length;
  const contentStart = line.start + markerLength;
  const range = trimAbsoluteRange(line.text, contentStart, line.end);
  if (!range) return null;
  return {
    type: 'heading',
    level: match[2].length,
    start: line.start,
    end: line.end,
    text: line.text.slice(range.start - line.start, range.end - line.start),
    contentStart: range.start,
    contentEnd: range.end
  };
}

function createSpanRangeReader(spans: any[]) {
  const sorted = [...(spans || [])].sort((a: any, b: any) => a.start_offset - b.start_offset || a.sentence_index - b.sentence_index);
  let cursor = 0;
  return (start: number, end: number) => {
    while (cursor < sorted.length && sorted[cursor].end_offset <= start) cursor += 1;
    const result: any[] = [];
    let idx = cursor;
    while (idx < sorted.length && sorted[idx].start_offset < end) {
      const span = sorted[idx];
      if (span.end_offset > start) result.push(span);
      idx += 1;
    }
    return result;
  };
}

function isPlainTextCodeBlock(block: any) {
  const language = String(block?.language || '').trim().toLowerCase();
  return language === 'text' || language === 'txt' || language === 'plain' || language === 'plaintext';
}

function paragraphLineGroups(lines: any[]) {
  const groups: any[][] = [];
  let group: any[] = [];
  for (const line of lines || []) {
    if (!line) {
      if (group.length > 0) groups.push(group);
      group = [];
      continue;
    }
    group.push(line);
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

function headingText(block: any, rawMarkdown: string) {
  if (block.text) return block.text;
  if (block.contentStart != null && block.contentEnd != null) {
    return rawMarkdown.slice(block.contentStart, block.contentEnd).trim();
  }
  return rawMarkdown.slice(block.start, block.end).trim();
}

function fencedCodeText(block: any) {
  const fence = block.language ? `\`\`\`${block.language}` : '```';
  return `${fence}\n${block.text || ''}\n\`\`\``;
}

function imageBlock(line: any) {
  const trimmed = line.text.trim();
  const match = trimmed.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
  if (!match) return null;
  return {
    type: 'image',
    start: line.start,
    end: line.end,
    alt: match[1],
    src: match[2].trim()
  };
}

function htmlTableBlock(lines: any[], index: number, rawMarkdown: string) {
  const line = lines[index];
  if (!/^<table\b/i.test(line.text.trim())) return null;
  let endIndex = index;
  while (endIndex < lines.length && !/<\/table>/i.test(lines[endIndex].text)) endIndex += 1;
  if (endIndex >= lines.length) endIndex = index;
  const start = line.start;
  const end = lines[endIndex].end;
  const rows = htmlTableRows(rawMarkdown, start, end);
  return {
    nextIndex: endIndex + 1,
    block: { type: 'html_table', start, end, rows }
  };
}

function htmlTableRows(rawMarkdown: string, start: number, end: number) {
  const html = rawMarkdown.slice(start, end);
  const rows: any[] = [];
  const rowPattern = /<tr\b[^>]*>[\s\S]*?<\/tr>/gi;
  for (const rowMatch of html.matchAll(rowPattern)) {
    const rowStart = start + rowMatch.index;
    const rowEnd = rowStart + rowMatch[0].length;
    const cells = htmlCellsForRange(rawMarkdown, rowStart, rowEnd);
    rows.push({ start: rowStart, end: rowEnd, separator: false, cells });
  }
  if (rows.length === 0) {
    const cells = htmlCellsForRange(rawMarkdown, start, end);
    if (cells.length > 0) rows.push({ start, end, separator: false, cells });
  }
  return rows;
}

function htmlCellsForRange(rawMarkdown: string, start: number, end: number) {
  const html = rawMarkdown.slice(start, end);
  const cells: any[] = [];
  const cellPattern = /<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi;
  for (const cellMatch of html.matchAll(cellPattern)) {
    const opening = cellMatch[0].match(/^<t[dh]\b[^>]*>/i)?.[0] || '';
    const contentStart = start + cellMatch.index + opening.length;
    const contentEnd = start + cellMatch.index + cellMatch[0].length - (cellMatch[0].match(/<\/t[dh]>\s*$/i)?.[0]?.length || 0);
    const range = trimAbsoluteRange(rawMarkdown.slice(contentStart, contentEnd), contentStart, contentEnd);
    if (range) cells.push({ start: range.start, end: range.end });
  }
  return cells;
}

function isTableStart(lines: any[], index: number) {
  const current = lines[index]?.text || '';
  const next = lines[index + 1]?.text || '';
  return current.includes('|') && isTableSeparatorLine(next);
}

function isTableSeparatorLine(line: string) {
  const cells = splitTableCells(String(line || ''));
  return cells.length > 0 && cells.every((cell: any) => /^:?-{3,}:?$/.test(cell.text.trim()));
}

function tableRow(line: any) {
  const cells = splitTableCells(line.text).map((cell: any) => ({
    ...cell,
    start: line.start + cell.start,
    end: line.start + cell.end
  }));
  return {
    start: line.start,
    end: line.end,
    separator: cells.length > 0 && cells.every((cell: any) => /^:?-{3,}:?$/.test(cell.text.trim())),
    cells
  };
}

function splitTableCells(lineText: string) {
  const raw = String(lineText || '');
  const cells: any[] = [];
  let segmentStart = 0;
  for (let idx = 0; idx <= raw.length; idx += 1) {
    if (idx !== raw.length && raw[idx] !== '|') continue;
    const segmentEnd = idx;
    const range = trimRelativeRange(raw, segmentStart, segmentEnd);
    if (range && !(segmentStart === 0 && segmentEnd === 0)) {
      cells.push({ ...range, text: raw.slice(range.start, range.end) });
    }
    segmentStart = idx + 1;
  }
  return cells;
}

function listItemRange(line: any) {
  const match = line.text.match(/^(\s*)(?:[-*+•]\s+|\d+[.)]\s+)(.*)$/);
  if (!match) return null;
  const contentStart = line.start + match[0].length - match[2].length;
  const range = trimAbsoluteRange(line.text, contentStart, line.end);
  return range ? { start: range.start, end: range.end } : null;
}

function isParagraphLine(lines: any[], index: number) {
  const line = lines[index];
  const trimmed = line.text.trim();
  if (!trimmed) return false;
  if (isFenceStart(trimmed)) return false;
  if (trimmed.startsWith('$$')) return false;
  if (/^<table\b/i.test(trimmed)) return false;
  if (headingBlock(line)) return false;
  if (isSeparatorLine(line.text)) return false;
  if (imageBlock(line)) return false;
  if (listItemRange(line)) return false;
  if (trimmed.startsWith('>')) return false;
  if (isTableStart(lines, index)) return false;
  return true;
}

function trimLineRange(line: any) {
  return trimAbsoluteRange(line.text, line.start, line.end);
}

function trimAbsoluteRange(lineText: string, absoluteStart: number, absoluteEnd: number) {
  const relativeStart = absoluteStart - (absoluteEnd - String(lineText || '').length);
  const range = trimRelativeRange(lineText, relativeStart, String(lineText || '').length);
  if (!range) return null;
  const lineStart = absoluteEnd - String(lineText || '').length;
  return { start: lineStart + range.start, end: lineStart + range.end };
}

function trimRelativeRange(text: string, start: number, end: number) {
  const raw = String(text || '');
  let left = Math.max(0, start);
  let right = Math.min(raw.length, end);
  while (left < right && /\s/.test(raw[left])) left += 1;
  while (right > left && /\s/.test(raw[right - 1])) right -= 1;
  if (right <= left) return null;
  return { start: left, end: right };
}

function isSeparatorLine(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /^[⸻—–]+$/.test(trimmed) || /^[-*=_]{3,}$/.test(trimmed);
}
