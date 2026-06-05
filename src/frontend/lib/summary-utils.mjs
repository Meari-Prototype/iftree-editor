import {
  normalizeApiProtocol,
  normalizeReasoningEffortMap,
  normalizeReasoningEfforts
} from '../../agent/llm-api-config.mjs';

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

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

export const LLM_PROVIDER_PRESETS = [
  {
    id: 'openai',
    name: 'OpenAI 官方',
    note: '官方 Chat Completions',
    websiteUrl: 'https://platform.openai.com/docs/api-reference/chat/create',
    api: {
      name: 'OpenAI GPT-5.2',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.2',
      protocol: 'openai-compatible',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh']
    }
  },
  {
    id: 'claude',
    name: 'Claude 官方',
    note: 'Anthropic Messages API',
    websiteUrl: 'https://docs.anthropic.com/en/api/openai-sdk',
    apis: [
      {
        name: 'Claude Opus 4.1',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-opus-4-1-20250805',
        protocol: 'anthropic-compatible',
        reasoningEfforts: []
      },
      {
        name: 'Claude Sonnet 4',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-20250514',
        protocol: 'anthropic-compatible',
        reasoningEfforts: []
      }
    ]
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    note: 'MiniMax OpenAI API 兼容',
    websiteUrl: 'https://platform.minimaxi.com/docs/api-reference/text-chat-openai',
    apis: [
      {
        name: 'MiniMax 中国站',
        baseUrl: 'https://api.minimaxi.com/v1',
        model: 'MiniMax-M2.7'
      },
      {
        name: 'MiniMax Global',
        baseUrl: 'https://api.minimax.io/v1',
        model: 'MiniMax-M2.7'
      }
    ]
  },
  {
    id: 'glm',
    name: '智谱 GLM',
    note: '智谱 AI OpenAI API 兼容',
    websiteUrl: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
    api: {
      name: 'GLM-5',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-5'
    }
  },
  {
    id: 'kimi',
    name: 'Kimi',
    note: 'Kimi OpenAI API 兼容',
    websiteUrl: 'https://platform.kimi.ai/docs/api/overview',
    api: {
      name: 'Kimi K2.6',
      baseUrl: 'https://api.moonshot.ai/v1',
      model: 'kimi-k2.6'
    }
  },
  {
    id: 'gemini',
    name: 'Gemini',
    note: 'Google Gemini OpenAI compatibility',
    websiteUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    api: {
      name: 'Gemini 3 Flash',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-3-flash-preview'
    }
  },
  {
    id: 'grok',
    name: 'Grok / xAI',
    note: 'xAI OpenAI-compatible endpoint',
    websiteUrl: 'https://docs.x.ai/overview',
    api: {
      name: 'Grok 4.20 Reasoning',
      baseUrl: 'https://api.x.ai/v1',
      model: 'grok-4.20-reasoning'
    }
  }
];

export function newSettingsId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function clampSummaryNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function optionalSummaryInteger(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (number <= 0) return 0;
  return Math.round(Math.min(max, number));
}

export function optionalSummaryRatio(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (number <= 0) return 0;
  return Math.round(clampSummaryNumber(number, 0.1, 90, fallback) * 10) / 10;
}

export function normalizeSummaryConcurrency(value, fallback = DEFAULT_SUMMARY_CONCURRENCY) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.round(number));
}

export function normalizeSummaryStrategy(strategy = {}, index = 0) {
  const fallback = DEFAULT_SUMMARY_STRATEGIES[index] || DEFAULT_SUMMARY_STRATEGIES[1];
  const skipBelowChars = optionalSummaryInteger(strategy.skipBelowChars, fallback.skipBelowChars, 1000000);
  const minWords = optionalSummaryInteger(strategy.minWords, fallback.minWords, 100000);
  let maxWords = optionalSummaryInteger(strategy.maxWords, fallback.maxWords, 100000);
  if (maxWords > 0 && minWords > 0 && maxWords < minWords) maxWords = minWords;
  const ratioPercent = optionalSummaryRatio(strategy.ratioPercent, fallback.ratioPercent);
  return {
    id: String(strategy.id || fallback.id || newSettingsId('summary')),
    name: String(Object.prototype.hasOwnProperty.call(strategy, 'name') ? strategy.name : fallback.name).trim() || fallback.name,
    skipBelowChars,
    minWords,
    maxWords,
    ratioPercent
  };
}

export function normalizeAgentToolSettings(settings = {}) {
  const number = (key, min, max) => clampSummaryNumber(settings[key], min, max, DEFAULT_AGENT_TOOL_SETTINGS[key]);
  return {
    searchResultLimit: number('searchResultLimit', 1, 80),
    searchBlockMaxChars: number('searchBlockMaxChars', 200, 50000),
    fetchContentMaxChars: number('fetchContentMaxChars', 200, 100000),
    webSearchResultLimit: number('webSearchResultLimit', 1, 10),
    webOpenCharLimit: number('webOpenCharLimit', 1000, 50000)
  };
}

export function normalizeSummaryStrategySettings(settings = {}) {
  const strategies = (Array.isArray(settings.summaryStrategies) ? settings.summaryStrategies : [])
    .map((strategy, index) => normalizeSummaryStrategy(strategy, index));
  const summaryStrategies = strategies.length
    ? strategies
    : DEFAULT_SUMMARY_STRATEGIES.map((strategy, index) => normalizeSummaryStrategy(strategy, index));
  const has = (id) => summaryStrategies.some((strategy) => strategy.id === id);
  const activeArticleSummaryStrategyId = has(settings.activeArticleSummaryStrategyId)
    ? settings.activeArticleSummaryStrategyId
    : (summaryStrategies.find((strategy) => strategy.id === 'article-default')?.id || summaryStrategies[0].id);
  const activeNodeSummaryStrategyId = has(settings.activeNodeSummaryStrategyId)
    ? settings.activeNodeSummaryStrategyId
    : (summaryStrategies.find((strategy) => strategy.id === 'node-default')?.id || summaryStrategies[0].id);
  return {
    ...settings,
    summaryStrategies,
    activeArticleSummaryStrategyId,
    activeNodeSummaryStrategyId,
    summaryConcurrency: normalizeSummaryConcurrency(settings.summaryConcurrency)
  };
}

export function summaryStrategyForMode(settings, mode) {
  const normalized = normalizeSummaryStrategySettings(settings || {});
  const id = mode === 'article'
    ? normalized.activeArticleSummaryStrategyId
    : normalized.activeNodeSummaryStrategyId;
  return normalized.summaryStrategies.find((strategy) => strategy.id === id) ||
    normalized.summaryStrategies[mode === 'article' ? 0 : 1] ||
    normalizeSummaryStrategy({}, mode === 'article' ? 0 : 1);
}

export function summaryStrategyLabel(strategy) {
  const normalized = normalizeSummaryStrategy(strategy);
  const skip = normalized.skipBelowChars > 0 ? `低于${normalized.skipBelowChars}字跳过` : '不跳过短文本';
  const min = normalized.minWords > 0 ? `不少于${normalized.minWords}字` : '无下限';
  const max = normalized.maxWords > 0 ? `不多于${normalized.maxWords}字` : '无上限';
  const ratio = normalized.ratioPercent > 0 ? `${normalized.ratioPercent}%` : '自由比例';
  return `${skip} / ${min} / ${max} / ${ratio}`;
}

export function applySummarySkipStrategy(items = [], strategy, index = 0) {
  const normalized = normalizeSummaryStrategy(strategy, index);
  return items.map((item) => {
    const text = String(item?.text || '').trim();
    if (item?.skip === 'generated') return { ...item, text, skip: 'generated' };
    if (normalized.skipBelowChars > 0 && text.length < normalized.skipBelowChars) {
      return { ...item, text, skip: 'short' };
    }
    return { ...item, text, skip: null };
  });
}

export function summarySkipBelowCount(items = [], strategy, index = 0) {
  return applySummarySkipStrategy(items, strategy, index).filter((item) => item.skip === 'short').length;
}

export function newSummaryStrategy(existing = []) {
  return {
    ...normalizeSummaryStrategy(DEFAULT_SUMMARY_STRATEGIES[1], 1),
    id: newSettingsId('summary'),
    name: `摘要策略 ${existing.length + 1}`
  };
}

export function newLlmApi() {
  return {
    id: newSettingsId('api'),
    name: '新 API',
    note: '',
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    fullUrl: false,
    model: 'deepseek-v4-pro',
    protocol: 'openai-compatible',
    contextLimit: 0,
    maxOutputTokens: 0,
    reasoningEfforts: [],
    reasoningEffortMap: {},
    enabled: true
  };
}

export function newLlmApiFromPreset(api = {}) {
  return {
    ...newLlmApi(),
    ...api,
    id: newSettingsId('api'),
    apiKey: '',
    fullUrl: api.fullUrl === true,
    enabled: api.enabled !== false
  };
}

export function newLlmProvider(preset = null, existingProviders = []) {
  if (preset) {
    const apis = Array.isArray(preset.apis) && preset.apis.length > 0
      ? preset.apis.map((api) => newLlmApiFromPreset(api))
      : [newLlmApiFromPreset(preset.api || {})];
    const usedIds = new Set(existingProviders.map((provider) => provider.id));
    return {
      id: preset.id && !usedIds.has(preset.id) ? preset.id : newSettingsId('provider'),
      name: preset.name || '新供应商',
      note: preset.note || '',
      websiteUrl: preset.websiteUrl || '',
      apis
    };
  }
  const api = newLlmApi();
  return {
    id: newSettingsId('provider'),
    name: '新供应商',
    note: '',
    websiteUrl: '',
    apis: [api]
  };
}

export function normalizeLlmApiForEditor(api = {}, index = 0) {
  const contextLimit = Number(api.contextLimit ?? api.contextWindowTokens ?? api.contextWindow ?? api.maxContextTokens ?? api.modelCard?.contextLimit ?? api.metadata?.contextLimit);
  const maxOutputTokens = Number(api.maxOutputTokens ?? api.maxTokens ?? api.max_tokens);
  const hasReasoningEfforts = hasOwn(api, 'reasoningEfforts') || hasOwn(api, 'reasoning_efforts');
  const hasReasoningMap = hasOwn(api, 'reasoningEffortMap') || hasOwn(api, 'reasoning_effort_map');
  return {
    ...newLlmApi(),
    ...api,
    id: String(api.id || `api-${index + 1}`),
    name: String(api.name || `API ${index + 1}`),
    note: String(api.note || ''),
    apiKey: String(api.apiKey || ''),
    baseUrl: String(api.baseUrl || 'https://api.deepseek.com'),
    fullUrl: api.fullUrl === true,
    model: String(api.model || 'deepseek-v4-pro'),
    protocol: normalizeApiProtocol(api.protocol),
    contextLimit: Number.isFinite(contextLimit) && contextLimit > 0 ? Math.round(contextLimit) : 0,
    maxOutputTokens: Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? Math.round(maxOutputTokens) : 0,
    reasoningEfforts: hasReasoningEfforts ? normalizeReasoningEfforts(api.reasoningEfforts ?? api.reasoning_efforts) : [],
    reasoningEffortMap: hasReasoningMap ? normalizeReasoningEffortMap(api.reasoningEffortMap ?? api.reasoning_effort_map) : {},
    enabled: api.enabled !== false
  };
}

export function defaultLlmProviderForEditor() {
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    note: '默认供应商',
    websiteUrl: 'https://api.deepseek.com',
    apis: [normalizeLlmApiForEditor({
      id: 'deepseek-default',
      name: '默认 API',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro'
    }, 0)]
  };
}

export function normalizeLlmSettingsForEditor(settings = {}) {
  const rawProviders = Array.isArray(settings.providers) ? settings.providers : [];
  const providers = rawProviders.length
    ? rawProviders.map((provider, index) => {
      const apis = Array.isArray(provider.apis) && provider.apis.length > 0
        ? provider.apis.map((api, apiIndex) => normalizeLlmApiForEditor(api, apiIndex))
        : [normalizeLlmApiForEditor({}, 0)];
      return {
        id: String(provider.id || `provider-${index + 1}`),
        name: String(provider.name || `供应商 ${index + 1}`),
        note: String(provider.note || ''),
        websiteUrl: String(provider.websiteUrl || ''),
        apis
      };
    })
    : [defaultLlmProviderForEditor()];
  const activeProvider = providers.find((provider) => provider.id === settings.activeProviderId) || providers[0];
  const activeApi = activeProvider.apis.find((api) => api.id === settings.activeApiId) || activeProvider.apis[0];
  return {
    ...settings,
    providers,
    activeProviderId: activeProvider.id,
    activeApiId: activeApi?.id || '',
    configPath: settings.configPath || 'iftree.config.json',
    envPath: settings.envPath || '.env'
  };
}

export function providerMatchesPreset(provider, preset) {
  return provider?.id === preset.id ||
    provider?.name === preset.name ||
    (provider?.websiteUrl && provider.websiteUrl === preset.websiteUrl);
}
