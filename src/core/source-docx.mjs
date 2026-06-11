import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';

import { buildSourceDocument } from './source-markdown.mjs';
import { attr, xmlUnescape } from './source-text.mjs';

export function readDocxSourceDocument(filePath) {
  const zip = unzipSync(readFileSync(filePath));
  const documentEntry = zip['word/document.xml'];
  if (!documentEntry) throw new Error('DOCX 导入失败：未找到 word/document.xml');

  const decoder = new TextDecoder('utf-8');
  const styleNames = parseDocxStyleNames(zip, decoder);
  const documentXml = decoder.decode(documentEntry);
  const rawMarkdown = docxParagraphsToMarkdown(documentXml, styleNames);
  if (!rawMarkdown.trim()) throw new Error('DOCX 导入失败：未读取到正文');

  return buildSourceDocument({
    sourcePath: filePath,
    sourceType: 'docx',
    rawMarkdown
  });
}

function parseDocxStyleNames(files, decoder) {
  const entry = files['word/styles.xml'];
  if (!entry) return new Map();

  const stylesXml = decoder.decode(entry);
  const styleNames = new Map();
  for (const match of stylesXml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    const styleId = attr(match[1], 'w:styleId') || attr(match[1], 'styleId');
    if (!styleId) continue;
    const nameMatch = match[2].match(/<w:name\b([^>]*)\/?>/i);
    const styleName = nameMatch ? (attr(nameMatch[1], 'w:val') || attr(nameMatch[1], 'val')) : '';
    if (styleName) styleNames.set(styleId, styleName);
  }
  return styleNames;
}

function docxParagraphsToMarkdown(documentXml, styleNames) {
  const blocks = [];
  for (const match of documentXml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)) {
    const paragraphXml = match[0];
    const text = docxParagraphText(paragraphXml);
    const style = docxParagraphStyle(paragraphXml);
    if (!text) continue;
    if (isDocxTocParagraph(style)) continue;

    const level = docxHeadingLevel(style, styleNames);
    blocks.push(level > 0 ? `${'#'.repeat(level)} ${text}` : text);
  }
  return blocks.join('\n\n').trim();
}

function docxParagraphText(paragraphXml) {
  const parts = [];
  const tokenPattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g;
  for (const match of paragraphXml.matchAll(tokenPattern)) {
    if (match[0].startsWith('<w:tab')) parts.push('\t');
    else if (match[0].startsWith('<w:br')) parts.push('\n');
    else parts.push(xmlUnescape(match[1]));
  }
  return parts.join('').replace(/\u00a0/g, ' ').trim();
}

function docxParagraphStyle(paragraphXml) {
  const match = paragraphXml.match(/<w:pStyle\b([^>]*)\/?>/i);
  if (!match) return '';
  return attr(match[1], 'w:val') || attr(match[1], 'val') || '';
}

function docxHeadingLevel(style, styleNames) {
  const candidates = [style, styleNames.get(style)].filter(Boolean);
  for (const candidate of candidates) {
    const normalized = String(candidate || '').replace(/\s+/g, '').toLowerCase();
    const numbered = normalized.match(/(?:heading|标题)([1-6])$/i);
    if (numbered) return Number(numbered[1]);
    if (/^[1-6]$/.test(normalized)) return Number(normalized);
    if (normalized === 'title' || normalized === '标题') return 1;
  }
  return 0;
}

// TOC1/TOC2 是 Word 的目录段落样式 id —— 格式原生信号，不是语义猜测。
function isDocxTocParagraph(style) {
  return String(style || '').toLowerCase().startsWith('toc');
}
