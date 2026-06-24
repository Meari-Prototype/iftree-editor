import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { unzipSync } from 'fflate';

import { readChmSourceDocument } from './source-chm.js';
import { readDocxSourceDocument } from './source-docx.js';
import {
  buildMarkdownStructureRecords,
  buildSourceDocument,
  inspectMarkdownStructure
} from './source-markdown.js';
import { readPdfSourceDocument } from './source-pdf.js';
import { splitSentences } from './tree.js';
import { attr, readTextFile, xmlUnescape } from './source-text-utils.js';
import type { SourceDocument, SourceRecord, ImportOptions } from './source-types.js';

interface PythonItem {
  indent: number;
  startLine: number;
  endLine: number;
  code: string;
}

interface PythonOutlineNode {
  item: PythonItem | null;
  indent: number;
  children: PythonOutlineNode[];
}

// re-export 底层文本/XML 工具（已抽到 source-text-utils 以拆 source-chm/docx 循环依赖）：旧 importer
// （tests 取 decodeXmlEntities 等）仍可从 source-text 拿；新代码直接 import source-text-utils。
export { attr, decodeXmlEntities, readTextFile, xmlUnescape } from './source-text-utils.js';

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
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
      if (row.some((item: string) => String(item).trim())) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((item: string) => String(item).trim())) rows.push(row);
  return rows;
}

export function readSourceDocument(filePath: string) {
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

export function sentencesFromTxt(filePath: string) {
  return splitSentences(readTextFile(filePath));
}

export function recordsFromTxt(filePath: string) {
  return sentencesFromTxt(filePath).map((text: string) => ({ text, vector: null }));
}

export function recordsFromCsv(filePath: string) {
  const rows = parseCsvRows(readTextFile(filePath));
  const hasHeader = rows[0]?.some((cell: string) => /^(id|index|text|sentence|content|正文|句子|内容)$/i.test(String(cell || '').trim()));
  return rows
    .slice(hasHeader ? 1 : 0)
    .map((row: string[]) => {
      const text = String(row[1] || row[0] || '').trim();
      const vectorValues = row.slice(3).filter((value: string) => String(value || '').trim() !== '').map((value: string) => Number(value));
      const vector = vectorValues.length > 0 && vectorValues.every((value: number) => Number.isFinite(value))
        ? vectorValues
        : null;
      return { text, vector };
    })
    .filter((record: { text: string; vector: number[] | null }) => record.text);
}

export function recordsFromMarkdown(filePath: string) {
  return readSourceDocument(filePath).spans.map((span: { sentence_index: number; text: string }) => ({
    index: span.sentence_index,
    text: span.text,
    vector: null
  }));
}

export function recordsFromMarkdownStructure(filePath: string) {
  return buildMarkdownStructureRecords(readSourceDocument(filePath));
}

export { readPdfSourceDocument };

export function recordsFromSourceDocument(sourceDocument: SourceDocument, options: ImportOptions = {}) {
  return buildMarkdownStructureRecords(sourceDocument, options);
}

export function inspectSourceDocumentStructure(sourceDocument: SourceDocument) {
  return inspectMarkdownStructure(sourceDocument);
}

export function recordsFromPythonSource(source: string) {
  const logicalLines = collectPythonLogicalLines(source);
  const outline = buildPythonOutline(logicalLines);
  const records: SourceRecord[] = [];
  const counters = new Map<string, number>();

  function nextAddress(parentAddress: string) {
    const siblingIndex = (counters.get(parentAddress) || 0) + 1;
    counters.set(parentAddress, siblingIndex);
    return parentAddress ? `${parentAddress}-${siblingIndex}` : String(siblingIndex);
  }

  function addRecord(parentAddress: string, text: string, nodeType: string, sourceNode: PythonOutlineNode | null = null) {
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

  function emitPythonNodes(nodes: PythonOutlineNode[], parentAddress: string) {
    let index = 0;
    let leadingTrivia: PythonOutlineNode[] = [];

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
      if (group.length > 0) addRecord(parentAddress, formatPythonNodes(group), inferPythonNodeType(group[0].item!.code));
    }

    if (leadingTrivia.length > 0) {
      addRecord(parentAddress, formatPythonNodes(leadingTrivia), 'TEXT');
    }
  }

  function emitPythonSuiteNode(node: PythonOutlineNode, parentAddress: string, leadingTrivia: PythonOutlineNode[] = []) {
    const nodeType = inferPythonNodeType(node.item!.code);
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

export async function sentencesFromXlsx(filePath: string) {
  const extension = extname(filePath).toLowerCase() || '.xlsx';
  throw new Error(`${extension} 是数据库导出中继格式，不支持句子/文档导入。`);
}

export async function recordsFromXlsx(filePath: string) {
  const files = unzipSync(new Uint8Array(readFileSync(filePath)));
  const decoder = new TextDecoder('utf-8');
  const sharedStrings = parseSharedStrings(files, decoder);
  const sheetEntry = Object.keys(files)
    .filter((name: string) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a: string, b: string) => a.localeCompare(b))[0];

  if (!sheetEntry) return [];

  const rows: Map<number, { text: string; vector: number[] }> = new Map();
  const cellPattern = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
  const sheetXml = decoder.decode(files[sheetEntry]);

  for (const match of sheetXml.matchAll(cellPattern)) {
    const attrs = match[1];
    const body = match[2];
    const ref = attr(attrs, 'r');
    const parsedRef = parseCellRef(ref || '');
    if (!parsedRef) continue;
    const { column, rowNumber } = parsedRef;
    if (rowNumber < 2) continue;

    const type = attr(attrs, 't') || '';
    const value = cellValue(body, type, sharedStrings);
    if (!rows.has(rowNumber)) rows.set(rowNumber, { text: '', vector: [] });
    const row = rows.get(rowNumber)!;

    if (column === 2) row.text = value;
    else if (column >= 4 && value !== '') row.vector[column - 4] = Number(value);
  }

  return [...rows.keys()]
    .sort((a: number, b: number) => a - b)
    .map((rowNumber: number) => rows.get(rowNumber))
    .filter((record: { text: string; vector: number[] } | undefined) => record && record.text)
    .map((record) => ({
      text: record!.text,
      vector: record!.vector.length > 0 && record!.vector.every((value: number) => Number.isFinite(value))
        ? record!.vector
        : null
    }));
}

export async function readSentences(filePath: string) {
  return (await readSentenceRecords(filePath)).map((record: { text: string; vector: number[] | null }) => record.text);
}

export async function readSentenceRecords(filePath: string) {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.md') return recordsFromMarkdown(filePath);
  if (extension === '.txt') return recordsFromTxt(filePath);
  if (extension === '.pdf') return (await readPdfSourceDocument(filePath)).spans.map((span: { sentence_index: number; text: string }) => ({
    index: span.sentence_index,
    text: span.text,
    vector: null
  }));
  if (extension === '.docx') return readDocxSourceDocument(filePath).spans.map((span: { sentence_index: number; text: string }) => ({
    index: span.sentence_index,
    text: span.text,
    vector: null
  }));
  if (extension === '.chm') return (await readChmSourceDocument(filePath, { granularity: 'sentence' })).records;
  if (extension === '.xlsx' || extension === '.csv') {
    throw new Error(`${extension} 是数据库导出中继格式，不支持句子/文档导入。`);
  }
  throw new Error(`Unsupported import file: ${extension}`);
}

export async function readStructuredRecords(filePath: string) {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.xlsx' || extension === '.csv') {
    throw new Error(`${extension} 是数据库导出中继格式，不支持结构化文档导入。`);
  }
  throw new Error(`Structured import is not supported for ${extension}`);
}

function collectPythonLogicalLines(source: string) {
  const lines = String(source || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const items: PythonItem[] = [];
  let triple: { quote: string; indent: number; startLine: number; lines: string[] } | null = null;

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

function buildPythonOutline(items: PythonItem[]) {
  const root: PythonOutlineNode = { item: null, indent: -1, children: [] };
  const stack = [root];

  for (const item of items) {
    const node: PythonOutlineNode = { item, indent: item.indent, children: [] };
    while (stack.length > 1 && item.indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }

  return root;
}

function isSkippablePythonNode(node: PythonOutlineNode) {
  const code = node?.item?.code?.trim() || '';
  return /^#!\//.test(code) || /^#.*coding[:=]\s*[-\w.]+/i.test(code);
}

function isPythonTrivia(node: PythonOutlineNode) {
  const code = node?.item?.code?.trim() || '';
  return code.startsWith('#') || code.startsWith('@');
}

function isPythonImportNode(node: PythonOutlineNode) {
  const code = node?.item?.code?.trim() || '';
  return /^(import|from)\s+/.test(code);
}

function isPythonSuiteHeader(node: PythonOutlineNode) {
  const code = node?.item?.code?.trim() || '';
  return /^(async\s+def|def|class|if|elif|else|for|async\s+for|while|try|except|finally|with|async\s+with)\b/.test(code) && /:\s*(#.*)?$/.test(code);
}

function isPythonControlSuite(node: PythonOutlineNode) {
  const code = node?.item?.code?.trim() || '';
  return /^(if|elif|else|for|async\s+for|while|try|except|finally|with|async\s+with)\b/.test(code) && /:\s*(#.*)?$/.test(code);
}

function flattenPythonNodes(nodes: PythonOutlineNode[]) {
  const result: PythonOutlineNode[] = [];

  function visit(node: PythonOutlineNode) {
    result.push(node);
    for (const child of node.children || []) visit(child);
  }

  for (const node of nodes || []) visit(node);
  return result;
}

function hasNestedPythonSuite(nodes: PythonOutlineNode[]) {
  return flattenPythonNodes(nodes).some((node: PythonOutlineNode) => isPythonSuiteHeader(node));
}

function shouldInlinePythonSuite(node: PythonOutlineNode) {
  if (!node?.children?.length) return true;
  const code = node.item!.code.trim();
  const isDefOrClass = /^(async\s+def|def|class)\b/.test(code);
  if (isDefOrClass && hasNestedPythonSuite(node.children)) return false;
  if (isPythonControlSuite(node) && hasNestedPythonSuite(node.children)) return false;
  return node.children.length <= (isDefOrClass ? 8 : 5);
}

function formatPythonNodes(nodes: PythonOutlineNode[], options: { includeChildren?: boolean } = {}) {
  const flat = options.includeChildren ? flattenPythonNodes(nodes) : nodes;
  if (!flat.length) return '';

  const startLine = Math.min(...flat.map((node: PythonOutlineNode) => node.item!.startLine));
  const endLine = Math.max(...flat.map((node: PythonOutlineNode) => node.item!.endLine));
  const lineLabel = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
  const minIndent = Math.min(...flat.map((node: PythonOutlineNode) => node.item!.indent));
  const lines: string[] = [];

  for (const node of flat) {
    const relativeIndent = Math.max(0, node.item!.indent - minIndent);
    const prefix = ' '.repeat(Math.floor(relativeIndent / 4) * 2);
    for (const codeLine of String(node.item!.code || '').split('\n')) {
      lines.push(`${prefix}${codeLine}`);
    }
  }

  return `${lineLabel}\n${lines.join('\n')}`;
}

function pythonBracketDelta(line: string) {
  let delta = 0;
  let quote: string | null = null;
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

function countPythonIndent(line: string) {
  let indent = 0;
  for (const char of String(line || '')) {
    if (char === ' ') indent += 1;
    else if (char === '\t') indent += 4;
    else break;
  }
  return indent;
}

function unmatchedTripleQuote(trimmedLine: string) {
  for (const quote of ['"""', "'''"]) {
    const count = countOccurrences(trimmedLine, quote);
    if (count % 2 === 1) return quote;
  }
  return null;
}

function lineHasTripleClose(line: string, quote: string) {
  return String(line || '').includes(quote);
}

function countOccurrences(value: string, needle: string) {
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

function stripCommonIndent(lines: string[]) {
  const nonBlank = lines.filter((line: string) => line.trim());
  const minIndent = nonBlank.length > 0
    ? Math.min(...nonBlank.map((line: string) => countPythonIndent(line)))
    : 0;
  return lines.map((line: string) => line.slice(minIndent)).join('\n');
}

function inferPythonNodeType(code: string) {
  const trimmed = String(code || '').trim();
  if (/^(if|elif)\b/.test(trimmed)) return 'IF';
  if (/^(else|except|finally)\b/.test(trimmed)) return 'ELSE';
  if (/^(for|async\s+for)\b/.test(trimmed)) return 'FOREACH';
  if (/^while\b/.test(trimmed)) return 'LOOP';
  if (/^break\b/.test(trimmed)) return 'BREAK';
  if (/^continue\b/.test(trimmed)) return 'CONTINUE';
  return 'TEXT';
}

function parseSharedStrings(files: Record<string, Uint8Array>, decoder: TextDecoder) {
  const entry = files['xl/sharedStrings.xml'];
  if (!entry) return [];

  const xml = decoder.decode(entry);
  const strings: string[] = [];
  const itemPattern = /<si\b[\s\S]*?<\/si>/g;

  for (const itemMatch of xml.matchAll(itemPattern)) {
    const item = itemMatch[0];
    const parts: string[] = [];
    for (const textMatch of item.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
      parts.push(xmlUnescape(textMatch[1]));
    }
    strings.push(parts.join(''));
  }

  return strings;
}

function cellValue(body: string, type: string, sharedStrings: string[]) {
  if (type === 's') {
    const index = Number(textOf(body, 'v'));
    return (sharedStrings[index] || '').trim();
  }

  if (type === 'inlineStr') {
    return textOf(body, 't').trim();
  }

  return xmlUnescape(textOf(body, 'v')).trim();
}

function parseCellRef(ref: string) {
  const match = String(ref || '').match(/^([A-Z]+)(\d+)$/i);
  if (!match) return null;
  return {
    column: columnToNumber(match[1].toUpperCase()),
    rowNumber: Number(match[2])
  };
}

function columnToNumber(column: string) {
  let value = 0;
  for (const char of column) {
    value = value * 26 + (char.charCodeAt(0) - 64);
  }
  return value;
}

function textOf(xml: string, tagName: string) {
  const match = xml.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match ? xmlUnescape(match[1]) : '';
}
