// debug 日志值摘要的唯一权威实现（脱敏 + 截断）。
// 此前 electron/main.mjs 与 src/frontend/lib/debug-log.mjs 各持一份，
// safeKeys 名单和大小写匹配语义已经漂移过一次。统一语义：
// - safe key 匹配大小写不敏感（main 进程 payload 的 key 大小写不可控）；
// - redact 名单取两份的并集（'api' 宽匹配涵盖 apikey/api_key，'secret' 保留）；
// - 字符串截断统一折叠空白后截 80（safeDebugLabel），保证日志单行。
const SAFE_STRING_KEYS = new Set([
  'action',
  'arialabel',
  'backend',
  'button',
  'channel',
  'code',
  'direction',
  'editmode',
  'error',
  'event',
  'from',
  'id',
  'key',
  'kind',
  'label',
  'level',
  'method',
  'message',
  'mode',
  'name',
  'phase',
  'renderbackend',
  'rendermode',
  'role',
  'screen',
  'stage',
  'status',
  'tag',
  'to',
  'type',
  'view'
]);

const REDACTED_KEY_PARTS = [
  'api',
  'content',
  'markdown',
  'password',
  'path',
  'prompt',
  'raw',
  'secret',
  'summary',
  'text',
  'token'
];

export function safeDebugLabel(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function shouldRedactKey(key: unknown): boolean {
  const normalized = String(key || '').toLowerCase();
  return REDACTED_KEY_PARTS.some((part) => normalized.includes(part));
}

export function debugValueSummary(value: unknown, key: string = '', depth: number = 0): unknown {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const normalizedKey = String(key || '').toLowerCase();
    if (SAFE_STRING_KEYS.has(normalizedKey) || normalizedKey.endsWith('id') || normalizedKey === 'address') return safeDebugLabel(value);
    return { type: 'string', length: value.length };
  }
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (typeof value !== 'object') return String(value);
  if (depth >= 2) return { type: 'object', keys: Object.keys(value as object).slice(0, 20) };

  const result: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    if (shouldRedactKey(childKey)) {
      result[childKey] = typeof childValue === 'string'
        ? { type: 'string', length: childValue.length }
        : debugValueSummary(childValue, childKey, depth + 1);
      continue;
    }
    result[childKey] = debugValueSummary(childValue, childKey, depth + 1);
  }
  return result;
}
