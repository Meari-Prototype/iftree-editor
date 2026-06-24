// @ts-nocheck
export const REASONING_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh'];
export const API_PROTOCOL_VALUES = ['openai-compatible', 'anthropic-compatible'];

export function normalizeReasoningEffortValue(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text || text === 'auto' || text === 'default' || text === 'none') return '';
  if (text === 'max') return 'xhigh';
  return REASONING_EFFORT_VALUES.includes(text) ? text : '';
}

export function normalizeReasoningEfforts(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || '').split(/[,，\s/]+/);
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const effort = normalizeReasoningEffortValue(item);
    if (effort && !seen.has(effort)) {
      seen.add(effort);
      result.push(effort);
    }
  }
  return result;
}

export function normalizeReasoningEffortMap(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    const effort = normalizeReasoningEffortValue(key);
    const mapped = String(raw || '').trim().toLowerCase();
    if (effort && mapped) result[effort] = mapped;
  }
  return result;
}

export function configuredReasoningEfforts(api = {}) {
  return normalizeReasoningEfforts(api.reasoningEfforts ?? api.reasoning_efforts);
}

export function configuredReasoningEffortMap(api = {}) {
  return normalizeReasoningEffortMap(api.reasoningEffortMap ?? api.reasoning_effort_map);
}

export function normalizeApiProtocol(value) {
  const text = String(value || '').trim().toLowerCase();
  return API_PROTOCOL_VALUES.includes(text) ? text : 'openai-compatible';
}

export function llmProtocol(api = {}) {
  return normalizeApiProtocol(api.protocol);
}

export function configuredMaxOutputTokens(api = {}) {
  for (const value of [api.maxOutputTokens, api.maxTokens, api.max_tokens]) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return Math.round(number);
  }
  return 0;
}

export function normalizeReasoningEffort(value, api = {}) {
  const effort = normalizeReasoningEffortValue(value);
  if (!effort) return '';
  const supported = configuredReasoningEfforts(api);
  if (!supported.includes(effort)) {
    throw new Error(`当前 API 未声明支持推理强度：${effort}`);
  }
  const effortMap = configuredReasoningEffortMap(api);
  return effortMap[effort] || effort;
}
