export const DEFAULT_SUMMARY_STRATEGIES = [
  { id: 'article-default', name: '全文默认', skipBelowChars: 100, minWords: 250, maxWords: 1200, ratioPercent: 10 },
  { id: 'node-default', name: '节点/子树默认', skipBelowChars: 100, minWords: 80, maxWords: 300, ratioPercent: 20 }
];

export const DEFAULT_SUMMARY_CONCURRENCY = 10;

export const DEFAULT_AGENT_TOOL_SETTINGS = {
  searchResultLimit: 20,
  searchBlockMaxChars: 20000,
  fetchContentMaxChars: 20000,
  webSearchResultLimit: 5,
  webOpenCharLimit: 12000
};

interface SummaryStrategyConfig {
  id?: unknown;
  name?: unknown;
  skipBelowChars?: unknown;
  minWords?: unknown;
  maxWords?: unknown;
  ratioPercent?: unknown;
}

interface AgentToolSettingsConfig {
  searchResultLimit?: unknown;
  searchBlockMaxChars?: unknown;
  fetchContentMaxChars?: unknown;
  webSearchResultLimit?: unknown;
  webOpenCharLimit?: unknown;
}

export function llmId(prefix: string, value: unknown, index: number): string {
  const text = String(value || '').trim();
  if (text) return text;
  return `${prefix}-${index + 1}`;
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function optionalIntegerLimit(value: unknown, fallback: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (number <= 0) return 0;
  return Math.round(Math.min(max, number));
}

export function optionalRatioLimit(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (number <= 0) return 0;
  return Math.round(clampNumber(number, 0.1, 90, fallback) * 10) / 10;
}

export function normalizeSummaryConcurrency(value: unknown, fallback = DEFAULT_SUMMARY_CONCURRENCY): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.round(number));
}

export function normalizeAgentToolSettings(config: AgentToolSettingsConfig = {}) {
  return {
    searchResultLimit: optionalIntegerLimit(config.searchResultLimit, DEFAULT_AGENT_TOOL_SETTINGS.searchResultLimit, 80) || DEFAULT_AGENT_TOOL_SETTINGS.searchResultLimit,
    searchBlockMaxChars: optionalIntegerLimit(config.searchBlockMaxChars, DEFAULT_AGENT_TOOL_SETTINGS.searchBlockMaxChars, 50000) || DEFAULT_AGENT_TOOL_SETTINGS.searchBlockMaxChars,
    fetchContentMaxChars: optionalIntegerLimit(config.fetchContentMaxChars, DEFAULT_AGENT_TOOL_SETTINGS.fetchContentMaxChars, 100000) || DEFAULT_AGENT_TOOL_SETTINGS.fetchContentMaxChars,
    webSearchResultLimit: optionalIntegerLimit(config.webSearchResultLimit, DEFAULT_AGENT_TOOL_SETTINGS.webSearchResultLimit, 10) || DEFAULT_AGENT_TOOL_SETTINGS.webSearchResultLimit,
    webOpenCharLimit: optionalIntegerLimit(config.webOpenCharLimit, DEFAULT_AGENT_TOOL_SETTINGS.webOpenCharLimit, 50000) || DEFAULT_AGENT_TOOL_SETTINGS.webOpenCharLimit
  };
}

export function normalizeSummaryStrategy(strategy: SummaryStrategyConfig = {}, index = 0) {
  const fallback = DEFAULT_SUMMARY_STRATEGIES[index] || DEFAULT_SUMMARY_STRATEGIES[1];
  const skipBelowChars = optionalIntegerLimit(strategy.skipBelowChars, fallback.skipBelowChars, 1000000);
  const minWords = optionalIntegerLimit(strategy.minWords, fallback.minWords, 100000);
  let maxWords = optionalIntegerLimit(strategy.maxWords, fallback.maxWords, 100000);
  if (maxWords > 0 && minWords > 0 && maxWords < minWords) maxWords = minWords;
  const ratioPercent = optionalRatioLimit(strategy.ratioPercent, fallback.ratioPercent);
  return {
    id: llmId('summary', strategy.id || fallback.id, index),
    name: String(Object.prototype.hasOwnProperty.call(strategy, 'name') ? strategy.name : fallback.name).trim() || fallback.name,
    skipBelowChars,
    minWords,
    maxWords,
    ratioPercent
  };
}

export function defaultSummaryStrategies() {
  return DEFAULT_SUMMARY_STRATEGIES.map((strategy, index) => normalizeSummaryStrategy(strategy, index));
}
