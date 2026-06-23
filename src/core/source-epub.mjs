import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';

import { createSpanAccumulator, addSentenceContainer } from './source-spans.mjs';

// EPUB 结构解析（只解析原生结构、不解析语义）。EPUB 与 CHM 同构——都是「zip + 目录树 + 多 HTML」，
// 因此沿用 chm 的范式：目录树（EPUB2 的 toc.ncx / EPUB3 的 nav.xhtml）给章节骨架，每个目录项指向的
// 章节 HTML 用块切分挂在其下、HTML 内 h1-h6 再细分。nodeType 一律 TEXT；层级只取目录嵌套深度与
// HTML 标题层级，不从标题文字猜「卷/章」、不去重、不判断正文/注释。
//
// 刻意不复用 source-chm.mjs 的 HTML 处理函数：chm 与 epub 是两种独立格式，共享会让「改 chm 解析」
// 意外波及 epub。下方 HTML 切块/取文本逻辑是本模块自带的独立副本。

export async function readEpubSourceDocument(filePath, options = {}) {
  const zip = unzipSync(readFileSync(filePath));
  const readEntry = (name) => decodeEntry(zip[findEntryKey(zip, name)]);

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

// zip 内路径理论上区分大小写、用正斜杠；个别打包工具会有大小写出入，按精确→大小写不敏感兜底取键。
function findEntryKey(zip, name) {
  if (zip[name] != null) return name;
  const lower = String(name || '').toLowerCase();
  return Object.keys(zip).find((key) => key.toLowerCase() === lower) || name;
}

function decodeEntry(bytes) {
  if (bytes == null) return null;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  const text = new TextDecoder('utf-8').decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function dirOf(path) {
  const normalized = String(path || '').replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(0, slash) : '';
}

// 把目录项 href/src（相对其所在文件目录）解析成 zip entry key；去掉 #anchor、解 URL 转义、压平 ../。
function resolveZipPath(baseDir, relative) {
  const cleaned = decodeUrlPath(String(relative || '').replace(/\\/g, '/').split('#')[0]);
  const parts = baseDir ? baseDir.split('/').filter(Boolean) : [];
  for (const segment of cleaned.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') parts.pop();
    else parts.push(segment);
  }
  return parts.join('/');
}

function decodeUrlPath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function matchTag(xml, tagName) {
  return String(xml || '').match(new RegExp(`<${tagName}\\b[^>]*>`, 'i'))?.[0] || '';
}

// 取标签属性，单/双引号都认（source-text 的 attr 只认双引号，nav 里 href 常用单引号）。
function readAttr(tag, name) {
  const match = String(tag || '').match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return match ? (match[2] ?? match[3] ?? '') : null;
}

// —— OPF / 目录解析 ——————————————————————————————————————————————

function parseOpf(opfXml) {
  const manifest = new Map();
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

// 找目录文件：优先 EPUB3 nav（manifest item 带 properties="nav"），否则 EPUB2 ncx（spine 的 toc 指向
// 的 item / 退到 media-type 或 .ncx 后缀）。两条都产出同形的 { name, src, level } 列表，下游统一处理。
function resolveTocFile(manifest, spineTocId, opfDir, readEntry) {
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

// EPUB2 toc.ncx：navMap 里 navPoint 嵌套即层级。navLabel>text 是标题，content@src 是目标文档。
// 用 token 流扫描——navPoint 开/闭管理深度，navLabel/content 落到最近打开的 navPoint。
function parseNcxToc(ncxXml) {
  const navMap = ncxXml.match(/<navMap\b[^>]*>([\s\S]*?)<\/navMap>/i)?.[1] || '';
  const items = [];
  const stack = [];
  const tokenPattern = /<navPoint\b[^>]*>|<\/navPoint>|<navLabel\b[\s\S]*?<\/navLabel>|<content\b[^>]*\/?>/gi;
  for (const match of navMap.matchAll(tokenPattern)) {
    const token = match[0];
    if (/^<navPoint\b/i.test(token)) {
      const item = { name: '', src: null, level: stack.length + 1 };
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

// EPUB3 nav.xhtml：<nav epub:type="toc"> 下嵌套 ol/li/a，ol 嵌套即层级（同 chm 的 ul）。
function parseNavToc(navXml) {
  const tocNav = navXml.match(/<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i)?.[1]
    || navXml.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/i)?.[1]
    || '';
  const items = [];
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
      // 无链接的分组标题（EPUB3 允许 <li><span>组</span><ol>…</ol></li>）。
      const name = decodeEntities(stripTags(token)).trim();
      if (name) items.push({ name, src: null, level: Math.max(1, level) });
    }
  }
  return items.filter((item) => item.name);
}

// —— 目录项 + 章节 HTML → 层级 records（结构与 chm 同构，复用已验证的 createDocFromStructuredRecords 通路）——

function epubItemsToSourceDocument(items, tocDir, readEntry, sourcePath, structureSource, options = {}) {
  const granularity = options.granularity === 'sentence' ? 'sentence' : 'paragraph';
  const records = [];
  const acc = createSpanAccumulator(); // 载体重建 + 句位 spans（取代本地 rawParts/rawOffset/appendRawText）
  const counters = new Map();
  const stack = [];

  function nextAddress(parentAddress) {
    const key = parentAddress || '';
    const next = (counters.get(key) || 0) + 1;
    counters.set(key, next);
    return key ? `${key}-${next}` : String(next);
  }

  function addRecord(parentAddress, text, role, recordOptions = {}) {
    const indexes = Array.isArray(recordOptions.indexes) ? recordOptions.indexes : acc.appendSegment(text);
    if (!indexes?.length) return null;
    const index = indexes[0];
    const address = nextAddress(parentAddress);
    const record = {
      address,
      text: String(text || '').trim(),
      nodeType: 'TEXT',
      sourcePosition: recordOptions.sourcePosition ?? index,
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
    while (stack.length > 0 && stack.at(-1).level >= level) stack.pop();
    const parentAddress = stack.at(-1)?.address || '';
    const heading = addRecord(parentAddress, title, 'toc-heading');
    if (!heading) continue;
    stack.push({ level, address: heading.address });

    const html = item.src ? readEntry(resolveZipPath(tocDir, item.src)) : null;
    if (!html) continue;
    const htmlBlocks = htmlToTextBlocks(html);
    const htmlStack = [];
    for (const block of htmlBlocks) {
      if (block.text === title) continue;
      if (block.role === 'html-heading') {
        const blockLevel = Math.max(1, Number(block.level) || 1);
        while (htmlStack.length > 0 && htmlStack.at(-1).level >= blockLevel) htmlStack.pop();
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
    sourceType: 'epub',
    structureSource,
    intermediateFormat: null,
    rawText,
    rawMarkdown: rawText,
    spans,
    records,
    tocItemCount: items.length
  };
}

// —— HTML → 文本块（本模块自带的独立副本，不与 source-chm 共享）——————————————

function htmlToTextBlocks(html) {
  const source = String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<head\b[\s\S]*?<\/head>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '\n');
  const blocks = [];
  const blockPattern = /<table\b[\s\S]*?<\/table>|<h([1-6])\b[\s\S]*?<\/h\1>|<p\b[\s\S]*?<\/p>|<li\b[\s\S]*?<\/li>|<blockquote\b[\s\S]*?<\/blockquote>/gi;
  let cursor = 0;

  for (const match of source.matchAll(blockPattern)) {
    pushPlain(source.slice(cursor, match.index));
    const block = match[0];
    if (/^<table\b/i.test(block)) {
      pushBlock(htmlTableToText(block), 'html-table');
    } else {
      const heading = block.match(/^<h([1-6])\b/i);
      pushBlock(htmlFragmentToText(block), heading ? 'html-heading' : 'html-paragraph', heading ? Number(heading[1]) : null);
    }
    cursor = match.index + block.length;
  }
  pushPlain(source.slice(cursor));
  return blocks;

  function pushPlain(fragment) {
    const text = htmlFragmentToText(fragment);
    for (const paragraph of splitParagraphs(text)) pushBlock(paragraph, 'html-paragraph');
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
  return rows.length > 0 ? rows.join('\n') : htmlFragmentToText(html);
}

function htmlFragmentToText(html) {
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

function splitParagraphs(text) {
  return String(text || '')
    .split(/\n{2,}/g)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function stripTags(value) {
  return String(value || '').replace(/<[^>]+>/g, '');
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}
