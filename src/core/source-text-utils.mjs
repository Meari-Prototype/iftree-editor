// 导入模块的底层文本/XML 工具（从 source-text 抽出，拆 source-text ↔ source-chm/docx 循环依赖）：
// source-text 是高层 dispatch（按扩展名 import 各格式解析器 source-chm/docx/pdf/markdown），而
// source-chm/docx 是格式解析器、要用底层 readTextFile 与 XML 工具。两边都依赖这些底层工具——放独立
// 模块两边共享、互不 import，环即断。source-text 仍 re-export 这些以兼容历史 importer（如 tests）。
import { readFileSync } from 'node:fs';

export function readTextFile(filePath) {
  const buffer = readFileSync(filePath);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le');
  }
  const charset = detectTextCharset(buffer);
  return decodeBuffer(buffer, charset).replace(/^﻿/, '');
}

function detectTextCharset(buffer) {
  const head = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('ascii');
  const meta = head.match(/charset\s*=\s*["']?([a-z0-9._-]+)/i);
  if (meta) return normalizeCharset(meta[1]);
  const utf8 = buffer.toString('utf8');
  const replacementCount = (utf8.match(/�/g) || []).length;
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

export function attr(attrs, name) {
  const match = attrs.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return match ? match[1] : null;
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

export function xmlUnescape(value) {
  return decodeXmlEntities(value);
}
