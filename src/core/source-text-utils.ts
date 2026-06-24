import { readFileSync } from 'node:fs';

export function readTextFile(filePath: string): string {
  const buffer = readFileSync(filePath);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le');
  }
  const charset = detectTextCharset(buffer);
  return decodeBuffer(buffer, charset).replace(/^﻿/, '');
}

function detectTextCharset(buffer: Buffer): string {
  const head = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('ascii');
  const meta = head.match(/charset\s*=\s*["']?([a-z0-9._-]+)/i);
  if (meta) return normalizeCharset(meta[1]);
  const utf8 = buffer.toString('utf8');
  const replacementCount = (utf8.match(/�/g) || []).length;
  return replacementCount > Math.max(2, utf8.length * 0.01) ? 'gb18030' : 'utf-8';
}

function normalizeCharset(value: unknown): string {
  const normalized = String(value || '').toLowerCase();
  if (['gb2312', 'gbk', 'gb18030'].includes(normalized)) return 'gb18030';
  if (['shift_jis', 'sjis', 'cp932'].includes(normalized)) return 'shift_jis';
  return normalized || 'utf-8';
}

function decodeBuffer(buffer: Buffer, charset: unknown): string {
  try {
    return new TextDecoder(String(charset || 'utf-8')).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

export function attr(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`${name}="([^"]*)"`, 'i'));
  return match ? match[1] : null;
}

export function decodeXmlEntities(value: unknown): string {
  return String(value)
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function xmlUnescape(value: unknown): string {
  return decodeXmlEntities(value);
}