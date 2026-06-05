import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { unzipSync } from 'fflate';

import {
  buildMarkdownStructureRecords,
  buildSourceDocument,
  inspectMarkdownStructure
} from './source-doc.mjs';
import { readPdfSourceDocument } from './pdf-source.mjs';
import { splitSentences } from './tree.mjs';

const execFileAsync = promisify(execFile);

export function readTextFile(filePath) {
  const buffer = readFileSync(filePath);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le');
  }
  const charset = detectTextCharset(buffer);
  return decodeBuffer(buffer, charset).replace(/^\uFEFF/, '');
}

function detectTextCharset(buffer) {
  const head = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('ascii');
  const meta = head.match(/charset\s*=\s*["']?([a-z0-9._-]+)/i);
  if (meta) return normalizeCharset(meta[1]);
  const utf8 = buffer.toString('utf8');
  const replacementCount = (utf8.match(/\uFFFD/g) || []).length;
  return replacementCount > Math.max(2, utf8.length * 0.01) ? 'gb18030' : 'utf-8';
}

function normalizeCharset(value) {
  const normalized = String(value || '').toLowerCase();
  if (['gb2312', 'gbk', 'gb18030'].includes(normalized)) return 'gb18030';
  if (['shift_jis', 'sjis', 'cp932'].includes(normalized)) return 'shift_jis';
  return normalized || 'utf-8';
}

function decodeBuffer(buffer, charset) {
  try {
    return new TextDecoder(charset || 'utf-8').decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      if (row.some((item) => String(item).trim())) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((item) => String(item).trim())) rows.push(row);
  return rows;
}

export function readSourceDocument(filePath) {
  const extension = extname(filePath).toLowerCase();
  if (!['.md', '.txt'].includes(extension)) {
    throw new Error(`Source document only supports .md/.txt, got ${extension}`);
  }
  return buildSourceDocument({
    sourcePath: filePath,
    sourceType: extension.slice(1),
    rawMarkdown: readTextFile(filePath)
  });
}

export function sentencesFromTxt(filePath) {
  return splitSentences(readTextFile(filePath));
}

export function recordsFromTxt(filePath) {
  return sentencesFromTxt(filePath).map((text) => ({ text, vector: null }));
}

export function recordsFromCsv(filePath) {
  const rows = parseCsvRows(readTextFile(filePath));
  const hasHeader = rows[0]?.some((cell) => /^(id|index|text|sentence|content|正文|句子|内容)$/i.test(String(cell || '').trim()));
  return rows
    .slice(hasHeader ? 1 : 0)
    .map((row) => {
      const text = String(row[1] || row[0] || '').trim();
      const vectorValues = row.slice(3).filter((value) => String(value || '').trim() !== '').map((value) => Number(value));
      const vector = vectorValues.length > 0 && vectorValues.every((value) => Number.isFinite(value))
        ? vectorValues
        : null;
      return { text, vector };
    })
    .filter((record) => record.text);
}

export function recordsFromMarkdown(filePath) {
  return readSourceDocument(filePath).spans.map((span) => ({
    index: span.sentence_index,
    text: span.text,
    vector: null
  }));
}

export function recordsFromMarkdownStructure(filePath) {
  return buildMarkdownStructureRecords(readSourceDocument(filePath));
}

export { readPdfSourceDocument };

export function recordsFromSourceDocument(sourceDocument, options = {}) {
  return buildMarkdownStructureRecords(sourceDocument, options);
}

export function inspectSourceDocumentStructure(sourceDocument) {
  return inspectMarkdownStructure(sourceDocument);
}

export async function readChmSourceDocument(filePath, options = {}) {
  const absoluteFilePath = resolve(filePath);
  const outputDir = join(tmpdir(), `iftree-chm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(outputDir, { recursive: true });
  try {
    await execFileAsync(chmDecompilerPath(), ['-decompile', outputDir, absoluteFilePath], { windowsHide: true, timeout: 60000 });
    const files = listFiles(outputDir);
    const hhcPath = files.find((item) => extname(item).toLowerCase() === '.hhc');
    if (!hhcPath) throw new Error('CHM 内未找到 .hhc 目录文件');
    const tocItems = parseHhc(readTextFile(hhcPath));
    if (tocItems.length === 0) throw new Error('CHM .hhc 目录为空');
    return chmItemsToSourceDocument(tocItems, outputDir, absoluteFilePath, options);
  } catch (error) {
    throw new Error(`CHM 导入失败：${error.message || error}`);
  } finally {
    try {
      rmSync(outputDir, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup failures
    }
  }
}

function chmItemsToSourceDocument(items, outputDir, sourcePath, options = {}) {
  const granularity = options.granularity === 'sentence' ? 'sentence' : 'paragraph';
  const records = [];
  const spans = [];
  const rawParts = [];
  const counters = new Map();
  const stack = [];
  let rawOffset = 0;

  function appendRawText(text, spanTexts = null) {
    const normalized = String(text || '').trim();
    if (!normalized) return null;
    const start = rawOffset;
    rawParts.push(normalized);
    rawOffset += normalized.length;
    rawParts.push('\n\n');
    rawOffset += 2;
    const sourceTexts = Array.isArray(spanTexts) && spanTexts.length > 0 ? spanTexts : [normalized];
    const indexes = [];
    let searchStart = 0;
    for (const sourceText of sourceTexts) {
      const textPart = String(sourceText || '').trim();
      if (!textPart) continue;
      const localStart = normalized.indexOf(textPart, searchStart);
      const partStart = localStart >= 0 ? localStart : searchStart;
      const partEnd = Math.min(normalized.length, partStart + textPart.length);
      const index = spans.length + 1;
      spans.push({
        sentence_index: index,
        start_offset: start + partStart,
        end_offset: start + partEnd,
        text: normalized.slice(partStart, partEnd) || textPart
      });
      indexes.push(index);
      searchStart = partEnd;
    }
    if (indexes.length === 0) {
      const index = spans.length + 1;
      spans.push({
        sentence_index: index,
        start_offset: start,
        end_offset: start + normalized.length,
        text: normalized
      });
      indexes.push(index);
    }
    return indexes;
  }

  function nextAddress(parentAddress) {
    const key = parentAddress || '';
    const next = (counters.get(key) || 0) + 1;
    counters.set(key, next);
    return key ? `${key}-${next}` : String(next);
  }

  function addRecord(parentAddress, text, role, options = {}) {
    const indexes = Array.isArray(options.indexes) ? options.indexes : appendRawText(text, options.spanTexts);
    if (!indexes?.length) return null;
    const index = indexes[0];
    const address = nextAddress(parentAddress);
    const record = {
      address,
      text: String(text || '').trim(),
      nodeType: 'TEXT',
      sourcePosition: options.sourcePosition ?? index,
      index,
      role,
      vector: null
    };
    if (indexes.length > 1) record.indexes = indexes;
    if (options.skipVector) record.skipVector = true;
    records.push(record);
    return record;
  }

  for (const item of items) {
    const title = String(item.name || '').trim();
    if (!title) continue;
    const level = Math.max(1, Number(item.level) || 1);
    while (stack.length > 0 && stack.at(-1).level >= level) stack.pop();
    const parentAddress = stack.at(-1)?.address || '';
    const heading = addRecord(parentAddress, title, 'hhc-heading');
    if (!heading) continue;
    stack.push({ level, address: heading.address });

    const localPath = item.local ? resolve(outputDir, decodeChmLocal(item.local)) : null;
    if (!localPath || !existsSync(localPath)) continue;
    const htmlBlocks = htmlToTextBlocks(readTextFile(localPath));
    const htmlStack = [];
    for (const block of htmlBlocks) {
      if (block.text === title) continue;
      if (block.role === 'html-heading') {
        const blockLevel = Math.max(1, Number(block.level) || 1);
        while (htmlStack.length > 0 && htmlStack.at(-1).level >= blockLevel) htmlStack.pop();
        const parentAddressForHeading = htmlStack.at(-1)?.address || heading.address;
        const htmlHeading = addRecord(parentAddressForHeading, block.text, 'html-heading');
        if (htmlHeading) htmlStack.push({ level: blockLevel, address: htmlHeading.address });
        continue;
      }

      const parentAddressForBlock = htmlStack.at(-1)?.address || heading.address;
      if (granularity === 'sentence' && block.role === 'html-paragraph') {
        const sentences = splitSentences(block.text);
        const sentenceTexts = sentences.length > 0 ? sentences : [block.text];
        const indexes = appendRawText(block.text, sentenceTexts);
        if (!indexes?.length) continue;
        const paragraph = addRecord(parentAddressForBlock, '', 'html-paragraph', {
          indexes,
          sourcePosition: indexes[0] - 0.5,
          skipVector: true
        });
        if (!paragraph) continue;
        for (const [index, sentence] of sentenceTexts.entries()) {
          addRecord(paragraph.address, sentence, 'html-sentence', {
            indexes: [indexes[index] ?? indexes.at(-1)],
            sourcePosition: indexes[index] ?? indexes.at(-1)
          });
        }
      } else {
        addRecord(parentAddressForBlock, block.text, block.role);
      }
    }
  }

  const rawText = rawParts.join('').trim();

  return {
    sourcePath,
    sourceType: 'chm',
    structureSource: 'hhc',
    intermediateFormat: null,
    rawText,
    rawMarkdown: rawText,
    spans,
    records,
    tocItemCount: items.length
  };
}

function chmDecompilerPath() {
  const root = process.env.SystemRoot || process.env.windir;
  return root ? join(root, 'hh.exe') : 'hh.exe';
}

function listFiles(root) {
  const result = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile()) result.push(fullPath);
    }
  }
  return result;
}

function parseHhc(html) {
  const items = [];
  let level = 0;
  const tokenPattern = /<\/?ul\b[^>]*>|<object\b[\s\S]*?<\/object>/gi;
  for (const match of String(html || '').matchAll(tokenPattern)) {
    const token = match[0];
    if (/^<ul\b/i.test(token)) {
      level += 1;
      continue;
    }
    if (/^<\/ul/i.test(token)) {
      level = Math.max(0, level - 1);
      continue;
    }
    const name = hhcParam(token, 'Name');
    const local = hhcParam(token, 'Local');
    if (name || local) items.push({ name: decodeHtmlEntities(name || local), local, level: Math.max(1, level) });
  }
  return items;
}

function hhcParam(token, name) {
  const pattern = new RegExp(`<param\\b[^>]*name=["']?${name}["']?[^>]*>`, 'i');
  const param = String(token || '').match(pattern)?.[0] || '';
  const value = param.match(/\bvalue\s*=\s*"([^"]*)"/i)?.[1] ||
    param.match(/\bvalue\s*=\s*'([^']*)'/i)?.[1] ||
    param.match(/\bvalue\s*=\s*([^>\s]+)/i)?.[1] ||
    '';
  return value.trim();
}

function decodeChmLocal(local) {
  const clean = String(local || '').replace(/\\/g, '/').split('#')[0];
  try {
    return decodeURIComponent(clean);
  } catch {
    return clean;
  }
}

function htmlToTextBlocks(html) {
  const source = String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '\n');
  const blocks = [];
  const blockPattern = /<table\b[\s\S]*?<\/table>|<h([1-6])\b[\s\S]*?<\/h\1>|<p\b[\s\S]*?<\/p>|<li\b[\s\S]*?<\/li>|<textarea\b[\s\S]*?<\/textarea>|<fieldset\b[\s\S]*?<\/fieldset>|<v:textbox\b[\s\S]*?<\/v:textbox>/gi;
  let cursor = 0;

  for (const match of source.matchAll(blockPattern)) {
    pushPlain(source.slice(cursor, match.index));
    const block = match[0];
    if (/^<table\b/i.test(block)) {
      pushBlock(htmlTableToText(block), 'html-table');
    } else {
      const heading = block.match(/^<h([1-6])\b/i);
      const role = heading ? 'html-heading' : (/^<(textarea|fieldset|v:textbox)\b/i.test(block) ? 'html-box' : 'html-paragraph');
      pushBlock(htmlFragmentToText(block), role, heading ? Number(heading[1]) : null);
    }
    cursor = match.index + block.length;
  }
  pushPlain(source.slice(cursor));
  return blocks;

  function pushPlain(fragment) {
    const text = htmlFragmentToText(fragment);
    for (const paragraph of splitChmParagraphs(text)) pushBlock(paragraph, 'html-paragraph');
  }

  function pushBlock(text, role, level = null) {
    const normalized = String(text || '').trim();
    if (!normalized) return;
    blocks.push(level ? { text: normalized, role, level } : { text: normalized, role });
  }
}

function htmlTableToText(html) {
  const rows = [];
  for (const rowMatch of String(html || '').matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
    const cells = [];
    for (const cellMatch of rowMatch[0].matchAll(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi)) {
      const text = htmlFragmentToText(cellMatch[0]).replace(/\s+/g, ' ').trim();
      if (text) cells.push(text);
    }
    if (cells.length > 0) rows.push(cells.join(' | '));
  }
  if (rows.length > 0) return rows.join('\n');
  return htmlFragmentToText(html);
}

function htmlFragmentToText(html) {
  let text = String(html || '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|section|article|tr|table|h[1-6])>/gi, '\n\n');
  text = text.replace(/<li\b[^>]*>/gi, '\n- ');
  text = text.replace(/<\/li>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeHtmlEntities(text);
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitChmParagraphs(text) {
  return String(text || '')
    .split(/\n{2,}/g)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

export function recordsFromPy(filePath) {
  return recordsFromPythonSource(readTextFile(filePath));
}

export function recordsFromPythonSource(source) {
  const logicalLines = collectPythonLogicalLines(source);
  const outline = buildPythonOutline(logicalLines);
  const records = [];
  const counters = new Map();

  function nextAddress(parentAddress) {
    const siblingIndex = (counters.get(parentAddress) || 0) + 1;
    counters.set(parentAddress, siblingIndex);
    return parentAddress ? `${parentAddress}-${siblingIndex}` : String(siblingIndex);
  }

  function addRecord(parentAddress, text, nodeType, sourceNode = null) {
    const address = nextAddress(parentAddress);
    const record = {
      index: records.length + 1,
      address,
      text,
      nodeType,
      trustLevel: null,
      vector: null
    };
    records.push(record);
    if (sourceNode) emitPythonNodes(sourceNode.children, address);
    return record;
  }

  function emitPythonNodes(nodes, parentAddress) {
    let index = 0;
    let leadingTrivia = [];

    while (index < nodes.length) {
      const node = nodes[index];
      if (isSkippablePythonNode(node)) {
        index += 1;
        continue;
      }

      if (isPythonTrivia(node)) {
        leadingTrivia.push(node);
        index += 1;
        continue;
      }

      if (isPythonImportNode(node)) {
        const group = [...leadingTrivia];
        leadingTrivia = [];
        while (index < nodes.length && isPythonImportNode(nodes[index])) {
          group.push(nodes[index]);
          index += 1;
        }
        addRecord(parentAddress, formatPythonNodes(group), 'TEXT');
        continue;
      }

      if (isPythonSuiteHeader(node)) {
        emitPythonSuiteNode(node, parentAddress, leadingTrivia);
        leadingTrivia = [];
        index += 1;
        continue;
      }

      const group = [...leadingTrivia];
      leadingTrivia = [];
      while (
        index < nodes.length &&
        !isSkippablePythonNode(nodes[index]) &&
        !isPythonTrivia(nodes[index]) &&
        !isPythonImportNode(nodes[index]) &&
        !isPythonSuiteHeader(nodes[index])
      ) {
        group.push(nodes[index]);
        index += 1;
      }
      if (group.length > 0) addRecord(parentAddress, formatPythonNodes(group), inferPythonNodeType(group[0].item.code));
    }

    if (leadingTrivia.length > 0) {
      addRecord(parentAddress, formatPythonNodes(leadingTrivia), 'TEXT');
    }
  }

  function emitPythonSuiteNode(node, parentAddress, leadingTrivia = []) {
    const nodeType = inferPythonNodeType(node.item.code);
    const textNodes = [...leadingTrivia, node];
    if (shouldInlinePythonSuite(node)) {
      addRecord(parentAddress, formatPythonNodes(textNodes, { includeChildren: true }), nodeType);
      return;
    }
    addRecord(parentAddress, formatPythonNodes(textNodes), nodeType, node);
  }

  emitPythonNodes(outline.children, '');
  return records;
}

export async function sentencesFromXlsx(filePath) {
  return (await recordsFromXlsx(filePath)).map((record) => record.text);
}

export async function recordsFromXlsx(filePath) {
  const files = unzipSync(new Uint8Array(readFileSync(filePath)));
  const decoder = new TextDecoder('utf-8');
  const sharedStrings = parseSharedStrings(files, decoder);
  const sheetEntry = Object.keys(files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => a.localeCompare(b))[0];

  if (!sheetEntry) return [];

  const rows = new Map();
  const cellPattern = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
  const sheetXml = decoder.decode(files[sheetEntry]);

  for (const match of sheetXml.matchAll(cellPattern)) {
    const attrs = match[1];
    const body = match[2];
    const ref = attr(attrs, 'r');
    const parsedRef = parseCellRef(ref);
    if (!parsedRef) continue;
    const { column, rowNumber } = parsedRef;
    if (rowNumber < 2) continue;

    const type = attr(attrs, 't');
    const value = cellValue(body, type, sharedStrings);
    if (!rows.has(rowNumber)) rows.set(rowNumber, { text: '', vector: [] });
    const row = rows.get(rowNumber);

    if (column === 2) row.text = value;
    else if (column >= 4 && value !== '') row.vector[column - 4] = Number(value);
  }

  return [...rows.keys()]
    .sort((a, b) => a - b)
    .map((rowNumber) => rows.get(rowNumber))
    .filter((record) => record.text)
    .map((record) => ({
      text: record.text,
      vector: record.vector.length > 0 && record.vector.every((value) => Number.isFinite(value))
        ? record.vector
        : null
    }));
}

export async function readSentences(filePath) {
  return (await readSentenceRecords(filePath)).map((record) => record.text);
}

export async function readSentenceRecords(filePath) {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.md') return recordsFromMarkdown(filePath);
  if (extension === '.txt') return recordsFromTxt(filePath);
  if (extension === '.pdf') return (await readPdfSourceDocument(filePath)).spans.map((span) => ({
    index: span.sentence_index,
    text: span.text,
    vector: null
  }));
  if (extension === '.chm') return (await readChmSourceDocument(filePath, { granularity: 'sentence' })).records;
  if (extension === '.xlsx') return await recordsFromXlsx(filePath);
  if (extension === '.csv') return recordsFromCsv(filePath);
  throw new Error(`Unsupported import file: ${extension}`);
}

export async function readPythonStructureRecords(filePath) {
  const extension = extname(filePath).toLowerCase();
  if (extension !== '.py') throw new Error(`Python import only supports .py, got ${extension}`);
  return recordsFromPy(filePath);
}

export async function readStructuredRecords(filePath) {
  const extension = extname(filePath).toLowerCase();
  if (extension !== '.xlsx') throw new Error(`Structured import only supports .xlsx, got ${extension}`);

  const sentences = await recordsFromXlsx(filePath);
  const structure = await readStructureSheet(filePath);

  if (!structure || structure.length === 0) {
    // No structure sheet → fall back to flat import
    return { sentences, structure: null };
  }

  // Merge structure with sentences (by index)
  const validTypes = new Set(['TEXT', 'IF', 'ELSE', 'LOOP', 'FOREACH', 'BREAK', 'CONTINUE']);
  const validTrust = new Set(['受控', '不受控', '']);

  const merged = structure.map((item) => {
    const idx = Number(item.index) - 1;
    const sentence = sentences[idx];
    return {
      index: item.index,
      text: sentence ? sentence.text : '',
      vector: sentence ? sentence.vector : null,
      nodeType: validTypes.has(item.type) ? item.type : 'TEXT',
      address: String(item.address || ''),
      trustLevel: validTrust.has(item.trust) ? (item.trust || null) : null
    };
  });

  return { sentences, structure: merged };
}

function collectPythonLogicalLines(source) {
  const lines = String(source || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const items = [];
  let triple = null;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const lineNumber = index + 1;
    if (triple) {
      triple.lines.push(rawLine);
      if (lineHasTripleClose(rawLine, triple.quote)) {
        items.push({
          indent: triple.indent,
          startLine: triple.startLine,
          endLine: lineNumber,
          code: stripCommonIndent(triple.lines).trim()
        });
        triple = null;
      }
      continue;
    }

    if (!rawLine.trim()) continue;
    const indent = countPythonIndent(rawLine);
    const trimmed = rawLine.trim();
    const openingQuote = unmatchedTripleQuote(trimmed);
    if (openingQuote) {
      triple = {
        quote: openingQuote,
        indent,
        startLine: lineNumber,
        lines: [rawLine]
      };
      continue;
    }

    const logical = [rawLine];
    let endLine = lineNumber;
    let bracketDepth = Math.max(0, pythonBracketDelta(rawLine));
    let continued = rawLine.trimEnd().endsWith('\\');

    while ((bracketDepth > 0 || continued) && index + 1 < lines.length) {
      index += 1;
      const continuationLine = lines[index];
      logical.push(continuationLine);
      endLine = index + 1;
      bracketDepth = Math.max(0, bracketDepth + pythonBracketDelta(continuationLine));
      continued = continuationLine.trimEnd().endsWith('\\');
    }

    items.push({
      indent,
      startLine: lineNumber,
      endLine,
      code: stripCommonIndent(logical).trim()
    });
  }

  if (triple) {
    items.push({
      indent: triple.indent,
      startLine: triple.startLine,
      endLine: lines.length,
      code: stripCommonIndent(triple.lines).trim()
    });
  }

  return items;
}

function buildPythonOutline(items) {
  const root = { item: null, indent: -1, children: [] };
  const stack = [root];

  for (const item of items) {
    const node = { item, indent: item.indent, children: [] };
    while (stack.length > 1 && item.indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }

  return root;
}

function isSkippablePythonNode(node) {
  const code = node?.item?.code?.trim() || '';
  return /^#!\//.test(code) || /^#.*coding[:=]\s*[-\w.]+/i.test(code);
}

function isPythonTrivia(node) {
  const code = node?.item?.code?.trim() || '';
  return code.startsWith('#') || code.startsWith('@');
}

function isPythonImportNode(node) {
  const code = node?.item?.code?.trim() || '';
  return /^(import|from)\s+/.test(code);
}

function isPythonSuiteHeader(node) {
  const code = node?.item?.code?.trim() || '';
  return /^(async\s+def|def|class|if|elif|else|for|async\s+for|while|try|except|finally|with|async\s+with)\b/.test(code) && /:\s*(#.*)?$/.test(code);
}

function isPythonControlSuite(node) {
  const code = node?.item?.code?.trim() || '';
  return /^(if|elif|else|for|async\s+for|while|try|except|finally|with|async\s+with)\b/.test(code) && /:\s*(#.*)?$/.test(code);
}

function flattenPythonNodes(nodes) {
  const result = [];

  function visit(node) {
    result.push(node);
    for (const child of node.children || []) visit(child);
  }

  for (const node of nodes || []) visit(node);
  return result;
}

function hasNestedPythonSuite(nodes) {
  return flattenPythonNodes(nodes).some((node) => isPythonSuiteHeader(node));
}

function shouldInlinePythonSuite(node) {
  if (!node?.children?.length) return true;
  const code = node.item.code.trim();
  const isDefOrClass = /^(async\s+def|def|class)\b/.test(code);
  if (isDefOrClass && hasNestedPythonSuite(node.children)) return false;
  if (isPythonControlSuite(node) && hasNestedPythonSuite(node.children)) return false;
  return node.children.length <= (isDefOrClass ? 8 : 5);
}

function formatPythonNodes(nodes, options = {}) {
  const flat = options.includeChildren ? flattenPythonNodes(nodes) : nodes;
  if (!flat.length) return '';

  const startLine = Math.min(...flat.map((node) => node.item.startLine));
  const endLine = Math.max(...flat.map((node) => node.item.endLine));
  const lineLabel = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
  const minIndent = Math.min(...flat.map((node) => node.item.indent));
  const lines = [];

  for (const node of flat) {
    const relativeIndent = Math.max(0, node.item.indent - minIndent);
    const prefix = ' '.repeat(Math.floor(relativeIndent / 4) * 2);
    for (const codeLine of String(node.item.code || '').split('\n')) {
      lines.push(`${prefix}${codeLine}`);
    }
  }

  return `${lineLabel}\n${lines.join('\n')}`;
}

function pythonBracketDelta(line) {
  let delta = 0;
  let quote = null;
  let escaped = false;

  for (const char of String(line || '')) {
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '#') break;
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(' || char === '[' || char === '{') {
      delta += 1;
    } else if (char === ')' || char === ']' || char === '}') {
      delta -= 1;
    }
  }

  return delta;
}

function countPythonIndent(line) {
  let indent = 0;
  for (const char of String(line || '')) {
    if (char === ' ') indent += 1;
    else if (char === '\t') indent += 4;
    else break;
  }
  return indent;
}

function unmatchedTripleQuote(trimmedLine) {
  for (const quote of ['"""', "'''"]) {
    const count = countOccurrences(trimmedLine, quote);
    if (count % 2 === 1) return quote;
  }
  return null;
}

function lineHasTripleClose(line, quote) {
  return String(line || '').includes(quote);
}

function countOccurrences(value, needle) {
  let count = 0;
  let index = 0;
  while (index < value.length) {
    const next = value.indexOf(needle, index);
    if (next === -1) break;
    count += 1;
    index = next + needle.length;
  }
  return count;
}

function stripCommonIndent(lines) {
  const nonBlank = lines.filter((line) => line.trim());
  const minIndent = nonBlank.length > 0
    ? Math.min(...nonBlank.map((line) => countPythonIndent(line)))
    : 0;
  return lines.map((line) => line.slice(minIndent)).join('\n');
}

function inferPythonNodeType(code) {
  const trimmed = String(code || '').trim();
  if (/^(if|elif)\b/.test(trimmed)) return 'IF';
  if (/^(else|except|finally)\b/.test(trimmed)) return 'ELSE';
  if (/^(for|async\s+for)\b/.test(trimmed)) return 'FOREACH';
  if (/^while\b/.test(trimmed)) return 'LOOP';
  if (/^break\b/.test(trimmed)) return 'BREAK';
  if (/^continue\b/.test(trimmed)) return 'CONTINUE';
  return 'TEXT';
}

async function readStructureSheet(filePath) {
  const files = unzipSync(new Uint8Array(readFileSync(filePath)));
  const decoder = new TextDecoder('utf-8');

  // Find workbook.xml to get sheet names
  const wbXml = decoder.decode(files['xl/workbook.xml']);
  const sheetPattern = /<sheet\b[^>]*\bname="([^"]*)"[^>]*>/gi;
  let structureSheetId = null;
  for (const match of wbXml.matchAll(sheetPattern)) {
    if (match[1] === '结构') {
      // Extract sheetId from the r:id attribute
      const ridMatch = match[0].match(/r:id="([^"]+)"/i);
      if (ridMatch) {
        // Find the corresponding sheet in workbook.xml.rels
        const relsXml = decoder.decode(files['xl/_rels/workbook.xml.rels'] || new Uint8Array());
        // Match the whole <Relationship> element regardless of attribute order
        const relElem = relsXml.match(new RegExp(`<Relationship\\b[^>]*\\bId="${ridMatch[1]}"[^>]*/?>`, 'i'));
        if (relElem) {
          const targetMatch = relElem[0].match(/\bTarget="([^"]*)"/i);
          if (targetMatch) {
            structureSheetId = targetMatch[1]; // e.g., "worksheets/sheet2.xml" or "/xl/worksheets/sheet2.xml"
          }
        }
      }
      break;
    }
  }

  if (!structureSheetId) return null;
  const sheetPath = structureSheetId.startsWith('/') ? structureSheetId.slice(1) : `xl/${structureSheetId}`;
  if (!files[sheetPath]) return null;

  const sheetXml = decoder.decode(files[sheetPath]);
  return parseStructureSheet(sheetXml, decoder, files);
}

function parseStructureSheet(sheetXml, decoder, files) {
  const sharedStrings = parseSharedStrings(files, decoder);
  const rows = [];
  const cellPattern = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;

  for (const match of sheetXml.matchAll(cellPattern)) {
    const attrs = match[1];
    const body = match[2];
    const ref = attr(attrs, 'r');
    const parsedRef = parseCellRef(ref);
    if (!parsedRef) continue;
    const { column, rowNumber } = parsedRef;
    if (rowNumber < 2) continue; // skip header

    if (!rows[rowNumber]) rows[rowNumber] = {};
    const type = attr(attrs, 't');
    const value = cellValue(body, type, sharedStrings);

    if (column === 1) rows[rowNumber].index = value;
    else if (column === 2) rows[rowNumber].type = value;
    else if (column === 3) rows[rowNumber].address = value;
    else if (column === 4) rows[rowNumber].trust = value;
  }

  return rows.filter(Boolean).filter((r) => r.index != null);
}

function parseSharedStrings(files, decoder) {
  const entry = files['xl/sharedStrings.xml'];
  if (!entry) return [];

  const xml = decoder.decode(entry);
  const strings = [];
  const itemPattern = /<si\b[\s\S]*?<\/si>/g;

  for (const itemMatch of xml.matchAll(itemPattern)) {
    const item = itemMatch[0];
    const parts = [];
    for (const textMatch of item.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
      parts.push(xmlUnescape(textMatch[1]));
    }
    strings.push(parts.join(''));
  }

  return strings;
}

function cellValue(body, type, sharedStrings) {
  if (type === 's') {
    const index = Number(textOf(body, 'v'));
    return (sharedStrings[index] || '').trim();
  }

  if (type === 'inlineStr') {
    return textOf(body, 't').trim();
  }

  return xmlUnescape(textOf(body, 'v')).trim();
}

function attr(attrs, name) {
  const match = attrs.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return match ? match[1] : null;
}

function parseCellRef(ref) {
  const match = String(ref || '').match(/^([A-Z]+)(\d+)$/i);
  if (!match) return null;
  return {
    column: columnToNumber(match[1].toUpperCase()),
    rowNumber: Number(match[2])
  };
}

function columnToNumber(column) {
  let value = 0;
  for (const char of column) {
    value = value * 26 + (char.charCodeAt(0) - 64);
  }
  return value;
}

function textOf(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match ? xmlUnescape(match[1]) : '';
}

export function decodeXmlEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlUnescape(value) {
  return decodeXmlEntities(value);
}
