// 内置 agent web_search 工具的安全闸与结果解析（agent-runtime 拆分，§6-7）：
// 内网/保留地址拦截（SSRF 防护）、HTML 实体解码、DuckDuckGo 结果页解析。纯函数，无 IO。
import { isIP } from 'node:net';

﻿export function blockedIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

export function blockedIpv6(hostname: string): boolean {
  const text = hostname.toLowerCase();
  if (text === '::1' || text === '::') return true;
  if (text.startsWith('fe80:') || text.startsWith('fc') || text.startsWith('fd')) return true;
  if (text.startsWith('::ffff:')) {
    const mapped = text.slice('::ffff:'.length);
    return isIP(mapped) === 4 ? blockedIpv4(mapped) : true;
  }
  return false;
}

export function assertAgentOpenUrlAllowed(rawUrl: unknown): string {
  let url: URL;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    throw new Error('web_search open 需要合法 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('web_search open 只允许 http 或 https URL');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname) throw new Error('web_search open 需要 URL 主机名');
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('web_search open 禁止访问 localhost');
  }
  if (!hostname.includes('.') && isIP(hostname) === 0) {
    throw new Error('web_search open 禁止访问内网短主机名');
  }
  const ipVersion = isIP(hostname);
  if (ipVersion === 4 && blockedIpv4(hostname)) throw new Error('web_search open 禁止访问内网或保留 IPv4 地址');
  if (ipVersion === 6 && blockedIpv6(hostname)) throw new Error('web_search open 禁止访问内网或保留 IPv6 地址');
  return url.toString();
}

export function decodeHtmlEntities(value: unknown = ''): string {
  // 数字实体（&#92; / &#x27; 等）是封闭规则，用两条带回调的 replace 全覆盖、不逐个枚举；
  // 非法码点回退原文（|| m）防 RangeError。&amp; 放最后解，避免把已解出的 & 再当实体头。
  const fromCp = (cp: number): string => (Number.isFinite(cp) && cp >= 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : '');
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => fromCp(parseInt(hex, 16)) || m)
    .replace(/&#(\d+);/g, (m, dec) => fromCp(parseInt(dec, 10)) || m)
    .replace(/&amp;/g, '&');
}

export function stripHtml(value: unknown = ''): string {
  return decodeHtmlEntities(String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

export function normalizeDuckDuckGoUrl(raw: unknown = ''): string {
  const text = decodeHtmlEntities(raw);
  try {
    const parsed = new URL(text, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    return uddg || parsed.href;
  } catch {
    return text;
  }
}

export interface DuckDuckGoResult {
  title: string;
  url: string;
  snippet: string;
}

export function parseDuckDuckGoResults(html: unknown, limit: number): DuckDuckGoResult[] {
  const results: DuckDuckGoResult[] = [];
  const blocks = String(html || '').split(/<div class="result results_links[^>]*>/i).slice(1);
  for (const block of blocks) {
    const link = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const snippet = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i);
    const url = normalizeDuckDuckGoUrl(link[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({
      title: stripHtml(link[2]),
      url,
      snippet: stripHtml(snippet?.[1] || '')
    });
    if (results.length >= limit) break;
  }
  return results;
}