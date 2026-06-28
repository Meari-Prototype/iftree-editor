export const REASONING_EFFORT_VALUES: string[] = ['low', 'medium', 'high', 'xhigh'];
export const API_PROTOCOL_VALUES: string[] = ['openai-compatible', 'anthropic-compatible'];

interface LlmApiConfig {
  reasoningEfforts?: unknown;
  reasoning_efforts?: unknown;
  reasoningEffortMap?: unknown;
  reasoning_effort_map?: unknown;
  protocol?: unknown;
  maxOutputTokens?: unknown;
  maxTokens?: unknown;
  max_tokens?: unknown;
}

export function normalizeReasoningEffortValue(value: unknown): string {
  const text = String(value || '').trim().toLowerCase();
  if (!text || text === 'auto' || text === 'default' || text === 'none') return '';
  if (text === 'max') return 'xhigh';
  return REASONING_EFFORT_VALUES.includes(text) ? text : '';
}

export function normalizeReasoningEfforts(value: unknown): string[] {
  const source = Array.isArray(value)
    ? value
    : String(value || '').split(/[,，\s/]+/);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of source) {
    const effort = normalizeReasoningEffortValue(item);
    if (effort && !seen.has(effort)) {
      seen.add(effort);
      result.push(effort);
    }
  }
  return result;
}

export function normalizeReasoningEffortMap(value: unknown = {}): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const effort = normalizeReasoningEffortValue(key);
    const mapped = String(raw || '').trim().toLowerCase();
    if (effort && mapped) result[effort] = mapped;
  }
  return result;
}

export function configuredReasoningEfforts(api: LlmApiConfig = {}): string[] {
  return normalizeReasoningEfforts(api.reasoningEfforts ?? api.reasoning_efforts);
}

export function configuredReasoningEffortMap(api: LlmApiConfig = {}): Record<string, string> {
  return normalizeReasoningEffortMap(api.reasoningEffortMap ?? api.reasoning_effort_map);
}

export function normalizeApiProtocol(value: unknown): string {
  const text = String(value || '').trim().toLowerCase();
  return API_PROTOCOL_VALUES.includes(text) ? text : 'openai-compatible';
}

export function llmProtocol(api: LlmApiConfig = {}): string {
  return normalizeApiProtocol(api.protocol);
}

export function configuredMaxOutputTokens(api: LlmApiConfig = {}): number {
  for (const value of [api.maxOutputTokens, api.maxTokens, api.max_tokens]) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return Math.round(number);
  }
  return 0;
}

export function normalizeReasoningEffort(value: unknown, api: LlmApiConfig = {}): string {
  const effort = normalizeReasoningEffortValue(value);
  if (!effort) return '';
  const supported = configuredReasoningEfforts(api);
  if (!supported.includes(effort)) {
    throw new Error(`当前 API 未声明支持推理强度：${effort}`);
  }
  const effortMap = configuredReasoningEffortMap(api);
  return effortMap[effort] || effort;
}
