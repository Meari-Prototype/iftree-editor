import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { readTextFile } from './source-text-utils.js';
import { createSpanAccumulator, addSentenceContainer } from './source-spans.js';

const execFileAsync = promisify(execFile);

export async function readChmSourceDocument(filePath: string, options: { granularity?: string } = {}) {
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
    throw new Error(`CHM 导入失败：${(error as Error).message || String(error)}`);
  } finally {
    try {
      rmSync(outputDir, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup failures
    }
  }
}

type ChmRecord = {
  address: string;
  text: string;
  nodeType: string;
  sourcePosition: number;
  index: number;
  role: string;
  vector: null;
  indexes?: number[];
  skipVector?: boolean;
};

function chmItemsToSourceDocument(items: { name: string; local?: string; level: number }[], outputDir: string, sourcePath: string, options: { granularity?: string } = {}) {
  const granularity = options.granularity === 'sentence' ? 'sentence' : 'paragraph';
  const records: ChmRecord[] = [];
  const acc = createSpanAccumulator(); // 载体重建 + 句位 spans（取代本地 rawParts/rawOffset/appendRawText）
  const counters = new Map();
  const stack: { level: number; address: string }[] = [];

  function nextAddress(parentAddress: string) {
    const key = parentAddress || '';
    const next = (counters.get(key) || 0) + 1;
    counters.set(key, next);
    return key ? `${key}-${next}` : String(next);
  }

  function addRecord(parentAddress: string, text: string, role: string, options: { indexes?: number[]; sourcePosition?: number; skipVector?: boolean } = {}) {
    const indexes = Array.isArray(options.indexes) ? options.indexes : acc.appendSegment(text);
    if (!indexes?.length) return null;
    const index = indexes[0];
    const address = nextAddress(parentAddress);
    const record: ChmRecord = {
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
    while (stack.length > 0 && stack.at(-1)!.level >= level) stack.pop();
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
        while (htmlStack.length > 0 && htmlStack.at(-1)!.level >= blockLevel) htmlStack.pop();
        const parentAddressForHeading = htmlStack.at(-1)?.address || heading.address;
        const htmlHeading = addRecord(parentAddressForHeading, block.text, 'html-heading');
        if (htmlHeading) htmlStack.push({ level: blockLevel, address: htmlHeading.address });
        continue;
      }

      const parentAddressForBlock = htmlStack.at(-1)?.address || heading.address;
      if (granularity === 'sentence' && block.role === 'html-paragraph') {
        addSentenceContainer({ acc, addRecord, parentAddress: parentAddressForBlock, text: block.text, rolePrefix: 'html' });
      } else {
        addRecord(parentAddressForBlock, block.text, block.role);
      }
    }
  }

  const { rawText, spans } = acc.finalize();

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

function listFiles(root: string) {
  const result = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile()) result.push(fullPath);
    }
  }
  return result;
}

function parseHhc(html: string) {
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

function hhcParam(token: string, name: string) {
  const pattern = new RegExp(`<param\\b[^>]*name=["']?${name}["']?[^>]*>`, 'i');
  const param = String(token || '').match(pattern)?.[0] || '';
  const value = param.match(/\bvalue\s*=\s*"([^"]*)"/i)?.[1] ||
    param.match(/\bvalue\s*=\s*'([^']*)'/i)?.[1] ||
    param.match(/\bvalue\s*=\s*([^>\s]+)/i)?.[1] ||
    '';
  return value.trim();
}

function decodeChmLocal(local: string) {
  const clean = String(local || '').replace(/\\/g, '/').split('#')[0];
  try {
    return decodeURIComponent(clean);
  } catch {
    return clean;
  }
}

function htmlToTextBlocks(html: string) {
  const source = String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '\n');
  const blocks: { text: string; role: string; level?: number }[] = [];
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

  function pushPlain(fragment: string) {
    const text = htmlFragmentToText(fragment);
    for (const paragraph of splitChmParagraphs(text)) pushBlock(paragraph, 'html-paragraph');
  }

  function pushBlock(text: string, role: string, level: number | null = null) {
    const normalized = String(text || '').trim();
    if (!normalized) return;
    blocks.push(level ? { text: normalized, role, level } : { text: normalized, role });
  }
}

function htmlTableToText(html: string) {
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

function htmlFragmentToText(html: string) {
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

function splitChmParagraphs(text: string) {
  return String(text || '')
    .split(/\n{2,}/g)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function decodeHtmlEntities(value: string) {
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
