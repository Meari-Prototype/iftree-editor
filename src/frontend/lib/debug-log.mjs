const SAFE_STRING_KEYS = new Set([
  'action',
  'ariaLabel',
  'backend',
  'button',
  'channel',
  'code',
  'direction',
  'editMode',
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
  'renderBackend',
  'renderMode',
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

let debugLoggingActive = false;

export function setDebugLoggingEnabled(enabled) {
  debugLoggingActive = enabled === true;
}

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function debugStartedAt() {
  return nowMs();
}

export function debugElapsedMs(startedAt) {
  return Math.round((nowMs() - startedAt) * 10) / 10;
}

export function safeDebugLabel(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function shouldRedactKey(key) {
  const normalized = String(key || '').toLowerCase();
  return REDACTED_KEY_PARTS.some((part) => normalized.includes(part));
}

export function debugValueSummary(value, key = '', depth = 0) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    const normalizedKey = String(key || '').toLowerCase();
    if (SAFE_STRING_KEYS.has(key) || normalizedKey.endsWith('id') || normalizedKey === 'address') return safeDebugLabel(value);
    return { type: 'string', length: value.length };
  }
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (typeof value !== 'object') return String(value);
  if (depth >= 2) return { type: 'object', keys: Object.keys(value).slice(0, 20) };

  const result = {};
  for (const [childKey, childValue] of Object.entries(value)) {
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

export function summarizeArgs(args) {
  return Array.isArray(args) ? args.map((arg) => debugValueSummary(arg)) : [];
}

export function summarizePayload(payload) {
  return debugValueSummary(payload || {});
}

export function summarizeResult(result) {
  return debugValueSummary(result || {});
}

export function debugLog(event, payload = {}) {
  if (!debugLoggingActive) return;
  if (typeof window === 'undefined') return;
  const fn = window.iftree?.debugLog;
  if (typeof fn !== 'function') return;
  try {
    void fn({
      event,
      ...debugValueSummary(payload || {})
    }).catch(() => {});
  } catch {
    // Debug logging must never affect editing.
  }
}

// 性能探针：debug 模式下打 console 并写入 .iftree-debug/*.jsonl。
// begin 总是跑（只是 performance.now()，零成本），允许调用方无 if 包裹；
// end 仅在 debug 开启时才有副作用。适合一次性大操作（文档加载、useMemo 计算），
// 不要塞进每帧 render 这种高频路径——多次 perf.now() 调用累积仍非零。
export function debugPerfBegin(_label) {
  return debugStartedAt();
}

export function debugPerfEnd(label, startedAt, extra) {
  if (!debugLoggingActive) return;
  const elapsedMs = debugElapsedMs(startedAt);
  try {
    if (typeof console !== 'undefined' && typeof console.log === 'function') {
      console.log(`[perf] ${label} ${elapsedMs}ms`, extra || '');
    }
  } catch {
    // 必须吞掉日志层的错误，避免影响真正逻辑。
  }
  debugLog('perf', { label, elapsedMs, ...(extra || {}) });
}
