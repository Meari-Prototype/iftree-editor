import { debugValueSummary, safeDebugLabel } from '../../core/debug-summary.js';

export { debugValueSummary, safeDebugLabel };

let debugLoggingActive = false;

export function setDebugLoggingEnabled(enabled: unknown): void {
  debugLoggingActive = enabled === true;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function debugStartedAt(): number {
  return nowMs();
}

export function debugElapsedMs(startedAt: number): number {
  return Math.round((nowMs() - startedAt) * 10) / 10;
}

export function summarizeArgs(args: unknown): unknown[] {
  return Array.isArray(args) ? args.map((arg) => debugValueSummary(arg)) : [];
}

export function summarizePayload(payload: unknown): unknown {
  return debugValueSummary(payload || {});
}

export function summarizeResult(result: unknown): unknown {
  return debugValueSummary(result || {});
}

export function debugLog(event: string, payload: unknown = {}): void {
  if (!debugLoggingActive) return;
  if (typeof window === 'undefined') return;
  const fn = window.iftree?.debugLog;
  if (typeof fn !== 'function') return;
  try {
    void fn({
      event,
      ...(debugValueSummary(payload || {}) as Record<string, unknown>)
    }).catch(() => {});
  } catch {
    // Debug logging must never affect editing.
  }
}

// 性能探针：debug 模式下打 console 并写入 .iftree-debug/*.jsonl。
// begin 总是跑（只是 performance.now()，零成本），允许调用方无 if 包裹；
// end 仅在 debug 开启时才有副作用。适合一次性大操作（文档加载、useMemo 计算），
// 不要塞进每帧 render 这种高频路径——多次 perf.now() 调用累积仍非零。
export function debugPerfBegin(_label: string): number {
  return debugStartedAt();
}

export function debugPerfEnd(label: string, startedAt: number, extra?: Record<string, unknown>): void {
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
