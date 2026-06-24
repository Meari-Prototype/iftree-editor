import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';

import { createSpanAccumulator, addSentenceContainer } from './source-spans.js';

export async function readEpubSourceDocument(filePath: string, options: Record<string, unknown> = {}) {
  const zip = unzipSync(readFileSync(filePath));
  const readEntry = (name: string) => decodeEntry(zip[findEntryKey(zip, name)]);

  const containerXml = readEntry('META-INF/container.xml');
  if (!containerXml) throw new Error('EPUB 导入失败：缺少 META-INF/container.xml');
  const opfPath = readAttr(matchTag(containerXml, 'rootfile'), 'full-path');
  if (!opfPath) throw new Error('EPUB 导入失败：container.xml 未指向 OPF 包文件');

  const opfXml = readEntry(opfPath);
  if (!opfXml) throw new Error(`EPUB 导入失败：未找到 OPF 包文件 ${opfPath}`);
  const opfDir = dirOf(opfPath);

  const { manifest, spineTocId } = parseOpf(opfXml);
  const toc = resolveTocFile(manifest, spineTocId, opfDir, readEntry);
  if (!toc) throw new Error('EPUB 导入失败：未找到目录（toc.ncx / EPUB3 nav）');

  const items = toc.kind === 'nav' ? parseNavToc(toc.xml) : parseNcxToc(toc.xml);
  if (items.length === 0) throw new Error('EPUB 导入失败：目录为空');

  const tocDir = dirOf(toc.path);
  return epubItemsToSourceDocument(items, tocDir, readEntry, filePath, toc.kind === 'nav' ? 'nav' : 'ncx', options);
}

// —— zip / 文本基础 ——————————————————————————————————————————————

function findEntryKey(zip: Record<string, Uint8Array>, name: string): string {
  if (zip[name] != null) return name;
  const lower = String(name || '').toLowerCase();
  return Object.keys(zip).find((key) => key.toLowerCase() === lower) || name;
}

function decodeEntry(bytes: Uint8Array | null | undefined): string | null {
  if (bytes == null) return null;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  const text = new TextDecoder('utf-8').decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function dirOf(path: string): string {
  const normalized = String(path || '').replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(0, slash) : '';
}

function resolveZipPath(baseDir: string, relative: string): string {
  const cleaned = decodeUrlPath(String(relative || '').replace(/\\/g, '/').split('#')[0]);
  const parts = baseDir ? baseDir.split('/').filter(Boolean) : [];
  for (const segment of cleaned.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

function decodeUrlPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function matchTag(xml: string, tagName: string): string {
  return String(xml || '').match(new RegExp(`<${tagName}\\b[^>]*>`, 'i'))?.[0] || '';
}

function readAttr(tag: string, name: string): string | null {
  const match = String(tag || '').match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return match ? (match[2] ?? match[3] ?? '') : null;
}

// —— OPF / 目录解析 ——————————————————————————————————————————————

type TocItemInfo = { name: string; src: string | null; level: number };

function parseOpf(opfXml: string): { manifest: Map<string, { href: string; mediaType: string; properties: string }>; spineTocId: string | null } {
  const manifest = new Map<string, { href: string; mediaType: string; properties: string }>();
  const manifestXml = opfXml.match(/<manifest\b[^>]*>([\s\S]*?)<\/manifest>/i)?.[1] || '';
  for (const match of manifestXml.matchAll(/<item\b([^>]*)\/?>/gi)) {
    const attrs = match[1];
    const id = readAttr(attrs, 'id');
    const href = readAttr(attrs, 'href');
    if (!id || !href) continue;
    manifest.set(id, {
      href,
      mediaType: readAttr(attrs, 'media-type') || '',
      properties: readAttr(attrs, 'properties') || ''
    });
  }
  const spineTag = matchTag(opfXml, 'spine');
  return { manifest, spineTocId: readAttr(spineTag, 'toc') };
}

function resolveTocFile(
  manifest: Map<string, { href: string; mediaType: string; properties: string }>,
  spineTocId: string | null,
  opfDir: string,
  readEntry: (name: string) => string | null
): { kind: string; path: string; xml: string } | null {
  const navItem = [...manifest.values()].find((item) => /(^|\s)nav(\s|$)/i.test(item.properties || ''));
  if (navItem) {
    const path = resolveZipPath(opfDir, navItem.href);
    const xml = readEntry(path);
    if (xml) return { kind: 'nav', path, xml };
  }

  const ncxItem = (spineTocId && manifest.get(spineTocId))
    || [...manifest.values()].find((item) => item.mediaType === 'application/x-dtbncx+xml' || /\.ncx$/i.test(item.href));
  if (ncxItem) {
    const path = resolveZipPath(opfDir, ncxItem.href);
    const xml = readEntry(path);
    if (xml) return { kind: 'ncx', path, xml };
  }
  return null;
}

function parseNcxToc(ncxXml: string): TocItemInfo[] {
  const navMap = ncxXml.match(/<navMap\b[^>]*>([\s\S]*?)<\/navMap>/i)?.[1] || '';
  const items: TocItemInfo[] = [];
  const stack: TocItemInfo[] = [];
  const tokenPattern = /<navPoint\b[^>]*>|<\/navPoint>|<navLabel\b[\s\S]*?<\/navLabel>|<content\b[^>]*\/?>/gi;
  for (const match of navMap.matchAll(tokenPattern)) {
    const token = match[0];
    if (/^<navPoint\b/i.test(token)) {
      const item: TocItemInfo = { name: '', src: null, level: stack.length + 1 };
      items.push(item);
      stack.push(item);
    } else if (/^<\/navPoint>/i.test(token)) {
      stack.pop();
    } else if (/^<navLabel\b/i.test(token)) {
      const current = stack.at(-1);
      if (current && !current.name) current.name = decodeEntities(stripTags(token)).trim();
    } else if (/^<content\b/i.test(token)) {
      const current = stack.at(-1);
      if (current && !current.src) current.src = readAttr(token, 'src');
    }
  }
  return items.filter((item) => item.name);
}

function parseNavToc(navXml: string): TocItemInfo[] {
  const tocNav = navXml.match(/<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i)?.[1]
    || navXml.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/i)?.[1]
    || '';
  const items: TocItemInfo[] = [];
  let level = 0;
  const tokenPattern = /<ol\b[^>]*>|<\/ol>|<a\b[^>]*>[\s\S]*?<\/a>|<span\b[^>]*>[\s\S]*?<\/span>/gi;
  for (const match of tocNav.matchAll(tokenPattern)) {
    const token = match[0];
    if (/^<ol\b/i.test(token)) {
      level += 1;
    } else if (/^<\/ol>/i.test(token)) {
      level = Math.max(0, level - 1);
    } else if (/^<a\b/i.test(token)) {
      const name = decodeEntities(stripTags(token)).trim();
      const src = readAttr(token, 'href');
      if (name || src) items.push({ name, src, level: Math.max(1, level) });
    } else if (/^<span\b/i.test(token)) {
      const name = decodeEntities(stripTags(token)).trim();
      if (name) items.push({ name, src: null, level: Math.max(1, level) });
    }
  }
  return items.filter((item) => item.name);
}

type EpubRecord = {
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

function epubItemsToSourceDocument(
  items: TocItemInfo[],
  tocDir: string,
  readEntry: (name: string) => string | null,
  sourcePath: string,
  structureSource: string,
  options: Record<string, unknown> = {}
) {
  const granularity: string = options.granularity === 'sentence' ? 'sentence' : 'paragraph';
  const records: EpubRecord[] = [];
  const acc = createSpanAccumulator();
  const counters = new Map<string, number>();
  const stack: { level: number; address: string }[] = [];

  function nextAddress(parentAddress: string): string {
    const key = parentAddress || '';
    const next = (counters.get(key) || 0) + 1;
    counters.set(key, next);
    return key ? `${key}-${next}` : String(next);
  }

  function addRecord(parentAddress: string, text: string, role: string, recordOptions: Record<string, unknown> = {}): EpubRecord | null {
    const indexes: number[] | null = Array.isArray(recordOptions.indexes) ? recordOptions.indexes as number[] : acc.appendSegment(text);
    if (!indexes?.length) return null;
    const index = indexes[0];
    const address = nextAddress(parentAddress);
    const record: EpubRecord = {
      address,
      text: String(text || '').trim(),
      nodeType: 'TEXT',
      sourcePosition: (recordOptions.sourcePosition as number) ?? index,
      index,
      role,
      vector: null
    };
    if (indexes.length > 1) record.indexes = indexes;
    if (recordOptions.skipVector) record.skipVector = true;
    records.push(record);
    return record;
  }

  for (const item of items) {
    const title = String(item.name || '').trim();
    if (!title) continue;
    const level = Math.max(1, Number(item.level) || 1);
    while (stack.length > 0 && stack.at(-1)!.level >= level) stack.pop();
    const parentAddress = stack.at(-1)?.address || '';
    const heading = addRecord(parentAddress, title, 'toc-heading');
    if (!heading) continue;
    stack.push({ level, address: heading.address });

    const html = item.src ? readEntry(resolveZipPath(tocDir, item.src)) : null;
    if (!html) continue;
    const htmlBlocks = htmlToTextBlocks(html);
    const htmlStack: { level: number; address: string }[] = [];
    for (const block of htmlBlocks) {
      if (block.text === title) continue;
      if (block.role === 'html-heading') {
        const blockLevel = Math.max(1, Number(block.level) || 1);
        while (htmlStack.length > 0 && htmlStack.at(-1)!.level >= blockLevel) htmlStack.pop();
        const headingParent = htmlStack.at(-1)?.address || heading.address;
        const htmlHeading = addRecord(headingParent, block.text, 'html-heading');
        if (htmlHeading) htmlStack.push({ level: blockLevel, address: htmlHeading.address });
        continue;
      }

      const blockParent = htmlStack.at(-1)?.address || heading.address;
      if (granularity === 'sentence' && block.role === 'html-paragraph') {
        addSentenceContainer({ acc, addRecord, parentAddress: blockParent, text: block.text, rolePrefix: 'html' });
      } else {
        addRecord(blockParent, block.text, block.role);
      }
    }
  }

  const { rawText, spans } = acc.finalize();
  return {
    sourcePath,
    sourceType: 'epub' as const,
    structureSource,
    intermediateFormat: null,
    rawText,
    rawMarkdown: rawText,
    spans,
    records,
    tocItemCount: items.length
  };
}

type TextBlock = { text: string; role: string; level?: number };

function htmlToTextBlocks(html: string): TextBlock[] {
  const source = String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<head\b[\s\S]*?<\/head>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '\n');
  const blocks: TextBlock[] = [];
  const blockPattern = /<table\b[\s\S]*?<\/table>|<h([1-6])\b[\s\S]*?<\/h\1>|<p\b[\s\S]*?<\/p>|<li\b[\s\S]*?<\/li>|<blockquote\b[\s\S]*?<\/blockquote>/gi;
  let cursor = 0;

  for (const match of source.matchAll(blockPattern)) {
    pushPlain(source.slice(cursor, match.index));
    const block = match[0];
    if (/^<table\b/i.test(block)) {
      pushBlock(htmlTableToText(block), 'html-table');
    } else {
      const heading = block.match(/^<h([1-6])\b/i);
      pushBlock(htmlFragmentToText(block), heading ? 'html-heading' : 'html-paragraph', heading ? Number(heading[1]) : undefined);
    }
    cursor = match.index + block.length;
  }
  pushPlain(source.slice(cursor));
  return blocks;

  function pushPlain(fragment: string): void {
    const text = htmlFragmentToText(fragment);
    for (const paragraph of splitParagraphs(text)) pushBlock(paragraph, 'html-paragraph');
  }

  function pushBlock(text: string, role: string, level?: number): void {
    const normalized = String(text || '').trim();
    if (!normalized) return;
    blocks.push(level != null ? { text: normalized, role, level } : { text: normalized, role });
  }
}

function htmlTableToText(html: string): string {
  const rows: string[] = [];
  for (const rowMatch of String(html || '').matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[0].matchAll(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi)) {
      const text = htmlFragmentToText(cellMatch[0]).replace(/\s+/g, ' ').trim();
      if (text) cells.push(text);
    }
    if (cells.length > 0) rows.push(cells.join(' | '));
  }
  return rows.length > 0 ? rows.join('\n') : htmlFragmentToText(html);
}

function htmlFragmentToText(html: string): string {
  let text = String(html || '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|section|article|tr|table|h[1-6])>/gi, '\n\n');
  text = text.replace(/<li\b[^>]*>/gi, '\n- ');
  text = text.replace(/<\/li>/gi, '\n');
  text = stripTags(text);
  text = decodeEntities(text);
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitParagraphs(text: string): string[] {
  return String(text || '')
    .split(/\n{2,}/g)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function stripTags(value: string): string {
  return String(value || '').replace(/<[^>]+>/g, '');
}

function decodeEntities(value: string): string {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}
