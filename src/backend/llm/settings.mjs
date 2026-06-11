// LLM 设置读取的唯一权威实现。
// main 进程（Electron 设置页/IPC）与 headless 进程（agent、摘要运行时）此前各持一份手抄副本，
// independent 分支的组装顺序已经漂移过一次；两进程对同一份 .env/iftree.config.json
// 读出不同的 provider/api 选择时，症状是「用错 API key/模型」，极难排查。
// 语义基准取自 electron/main.mjs（生产主路径）：独立摘要配置缺 active id 时
// 不回落到共享 env 指针，而是落到 providers[0]。
import { existsSync, readFileSync } from 'node:fs';

import {
  normalizeApiProtocol,
  normalizeReasoningEffortMap,
  normalizeReasoningEfforts
} from '../../agent/llm-api-config.mjs';
import {
  defaultSummaryStrategies,
  llmId,
  normalizeAgentToolSettings,
  normalizeSummaryConcurrency,
  normalizeSummaryStrategy
} from './defaults.mjs';

export const LLM_PROVIDERS_ENV_KEY = 'IFTREE_LLM_PROVIDERS_JSON';
export const LLM_ACTIVE_PROVIDER_ENV_KEY = 'IFTREE_LLM_ACTIVE_PROVIDER_ID';
export const LLM_ACTIVE_API_ENV_KEY = 'IFTREE_LLM_ACTIVE_API_ID';
export const LLM_INDEPENDENT_ENV_KEY = 'IFTREE_LLM_SUMMARY_INDEPENDENT_CONFIG';
export const LLM_SUMMARY_PROVIDERS_ENV_KEY = 'IFTREE_LLM_SUMMARY_PROVIDERS_JSON';
export const LLM_SUMMARY_ACTIVE_PROVIDER_ENV_KEY = 'IFTREE_LLM_SUMMARY_ACTIVE_PROVIDER_ID';
export const LLM_SUMMARY_ACTIVE_API_ENV_KEY = 'IFTREE_LLM_SUMMARY_ACTIVE_API_ID';
export const LLM_SUMMARY_STRATEGIES_ENV_KEY = 'IFTREE_LLM_SUMMARY_STRATEGIES_JSON';
export const LLM_SUMMARY_ARTICLE_STRATEGY_ENV_KEY = 'IFTREE_LLM_SUMMARY_ARTICLE_STRATEGY_ID';
export const LLM_SUMMARY_NODE_STRATEGY_ENV_KEY = 'IFTREE_LLM_SUMMARY_NODE_STRATEGY_ID';
export const AGENT_PROVIDERS_ENV_KEY = 'IFTREE_AGENT_PROVIDERS_JSON';
export const AGENT_ACTIVE_PROVIDER_ENV_KEY = 'IFTREE_AGENT_ACTIVE_PROVIDER_ID';
export const AGENT_ACTIVE_API_ENV_KEY = 'IFTREE_AGENT_ACTIVE_API_ID';
export const AGENT_PERSONAL_PROMPT_ENV_KEY = 'IFTREE_AGENT_PERSONAL_PROMPT';

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

export function readDotEnv(envPath) {
  const values = {};
  if (!envPath || !existsSync(envPath)) return values;
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function decodeDotEnvMultiline(value) {
  return String(value || '').replace(/\\n/g, '\n');
}

export function readJsonConfig(configPath) {
  if (!configPath || !existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) || {};
  } catch {
    return {};
  }
}

export function safeEnvKey(value) {
  const text = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return text || 'DEFAULT';
}

export function llmApiKeyEnvKey(providerId, apiId) {
  return `IFTREE_LLM_API_KEY_${safeEnvKey(providerId)}_${safeEnvKey(apiId)}`;
}

export function normalizeLlmApi(api = {}, index = 0) {
  const contextLimit = Number(api.contextLimit ?? api.contextWindowTokens ?? api.contextWindow ?? api.maxContextTokens ?? api.modelCard?.contextLimit ?? api.metadata?.contextLimit);
  const maxOutputTokens = Number(api.maxOutputTokens ?? api.maxTokens ?? api.max_tokens);
  const hasReasoningEfforts = hasOwn(api, 'reasoningEfforts') || hasOwn(api, 'reasoning_efforts');
  const hasReasoningMap = hasOwn(api, 'reasoningEffortMap') || hasOwn(api, 'reasoning_effort_map');
  return {
    id: llmId('api', api.id, index),
    name: String(hasOwn(api, 'name') ? api.name : `API ${index + 1}`).trim(),
    note: String(api.note || '').trim(),
    apiKey: String(api.apiKey || '').trim(),
    baseUrl: String(api.baseUrl || '').trim(),
    fullUrl: api.fullUrl === true,
    model: String(api.model || '').trim(),
    protocol: normalizeApiProtocol(api.protocol),
    contextLimit: Number.isFinite(contextLimit) && contextLimit > 0 ? Math.round(contextLimit) : 0,
    maxOutputTokens: Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? Math.round(maxOutputTokens) : 0,
    reasoningEfforts: hasReasoningEfforts ? normalizeReasoningEfforts(api.reasoningEfforts ?? api.reasoning_efforts) : [],
    reasoningEffortMap: hasReasoningMap ? normalizeReasoningEffortMap(api.reasoningEffortMap ?? api.reasoning_effort_map) : {},
    enabled: api.enabled !== false
  };
}

export function normalizeLlmProvider(provider = {}, index = 0) {
  const apis = (Array.isArray(provider.apis) ? provider.apis : [])
    .map((api, apiIndex) => normalizeLlmApi(api, apiIndex));
  if (apis.length === 0) apis.push(normalizeLlmApi({}, 0));
  return {
    id: llmId('provider', provider.id, index),
    name: String(hasOwn(provider, 'name') ? provider.name : `供应商 ${index + 1}`).trim(),
    note: String(provider.note || '').trim(),
    websiteUrl: String(provider.websiteUrl || '').trim(),
    apis
  };
}

export function defaultLlmProvider(env = {}) {
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY || '';
  const baseUrl = process.env.DEEPSEEK_BASE_URL || process.env.OPENAI_BASE_URL || env.DEEPSEEK_BASE_URL || env.OPENAI_BASE_URL || 'https://api.deepseek.com';
  const model = process.env.DEEPSEEK_MODEL || process.env.OPENAI_MODEL || env.DEEPSEEK_MODEL || env.OPENAI_MODEL || 'deepseek-v4-pro';
  return normalizeLlmProvider({
    id: 'deepseek',
    name: 'DeepSeek',
    note: '默认摘要供应商',
    websiteUrl: 'https://api.deepseek.com',
    apis: [{
      id: 'deepseek-default',
      name: '默认 API',
      note: '',
      apiKey,
      baseUrl,
      fullUrl: false,
      model,
      protocol: 'openai-compatible',
      reasoningEfforts: [],
      reasoningEffortMap: {},
      enabled: true
    }]
  }, 0);
}

export function normalizeSummaryStrategySettings(config = {}) {
  const strategies = (Array.isArray(config.summaryStrategies) ? config.summaryStrategies : [])
    .map((strategy, index) => normalizeSummaryStrategy(strategy, index));
  const summaryStrategies = strategies.length ? strategies : defaultSummaryStrategies();

  let activeArticleSummaryStrategyId = String(config.activeArticleSummaryStrategyId || '').trim();
  if (!summaryStrategies.some((strategy) => strategy.id === activeArticleSummaryStrategyId)) {
    activeArticleSummaryStrategyId = summaryStrategies.find((strategy) => strategy.id === 'article-default')?.id || summaryStrategies[0].id;
  }

  let activeNodeSummaryStrategyId = String(config.activeNodeSummaryStrategyId || '').trim();
  if (!summaryStrategies.some((strategy) => strategy.id === activeNodeSummaryStrategyId)) {
    activeNodeSummaryStrategyId = summaryStrategies.find((strategy) => strategy.id === 'node-default')?.id || summaryStrategies[0].id;
  }

  return {
    summaryStrategies,
    activeArticleSummaryStrategyId,
    activeNodeSummaryStrategyId,
    summaryConcurrency: normalizeSummaryConcurrency(config.summaryConcurrency)
  };
}

export function apiKeyFor(env, providerId, apiId, legacyValue = '') {
  const key = llmApiKeyEnvKey(providerId, apiId);
  const specific = process.env[key] || (env || {})[key] || legacyValue || '';
  if (specific) return specific;
  const provider = String(providerId || '').toLowerCase();
  if (provider.includes('deepseek')) {
    return process.env.DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || env.OPENAI_API_KEY || '';
  }
  if (provider.includes('openai')) {
    return process.env.OPENAI_API_KEY || env.OPENAI_API_KEY || '';
  }
  return '';
}

export function attachLlmSecrets(settings = {}, env = {}) {
  return {
    ...settings,
    providers: (settings.providers || []).map((provider) => ({
      ...provider,
      apis: (provider.apis || []).map((api) => ({
        ...api,
        apiKey: apiKeyFor(env, provider.id, api.id, api.apiKey)
      }))
    }))
  };
}

export function stripLlmSecrets(settings = {}) {
  return {
    ...settings,
    providers: (settings.providers || []).map((provider) => ({
      ...provider,
      apis: (provider.apis || []).map((api) => {
        const { apiKey: _apiKey, ...rest } = api;
        return rest;
      })
    }))
  };
}

export function llmApiKeyEnvValues(settings = {}) {
  const values = {};
  for (const provider of settings.providers || []) {
    for (const api of provider.apis || []) {
      if (hasOwn(api, 'apiKey')) {
        values[llmApiKeyEnvKey(provider.id, api.id)] = api.apiKey || '';
      }
    }
  }
  return values;
}

export function cleanupLegacyLlmEnvValues(extra = {}) {
  return {
    [LLM_ACTIVE_PROVIDER_ENV_KEY]: null,
    [LLM_ACTIVE_API_ENV_KEY]: null,
    [LLM_PROVIDERS_ENV_KEY]: null,
    [LLM_INDEPENDENT_ENV_KEY]: null,
    [LLM_SUMMARY_ACTIVE_PROVIDER_ENV_KEY]: null,
    [LLM_SUMMARY_ACTIVE_API_ENV_KEY]: null,
    [LLM_SUMMARY_PROVIDERS_ENV_KEY]: null,
    [LLM_SUMMARY_ARTICLE_STRATEGY_ENV_KEY]: null,
    [LLM_SUMMARY_NODE_STRATEGY_ENV_KEY]: null,
    [LLM_SUMMARY_STRATEGIES_ENV_KEY]: null,
    [AGENT_ACTIVE_PROVIDER_ENV_KEY]: null,
    [AGENT_ACTIVE_API_ENV_KEY]: null,
    [AGENT_PROVIDERS_ENV_KEY]: null,
    [AGENT_PERSONAL_PROMPT_ENV_KEY]: null,
    IFTREE_AGENT_API_KEY: null,
    IFTREE_AGENT_BASE_URL: null,
    IFTREE_AGENT_MODEL: null,
    OPENAI_BASE_URL: null,
    OPENAI_MODEL: null,
    DEEPSEEK_BASE_URL: null,
    DEEPSEEK_MODEL: null,
    ...extra
  };
}

export function activeLlmApiFromSettings(settings) {
  const provider = settings.providers.find((item) => item.id === settings.activeProviderId) || settings.providers[0];
  if (!provider) return null;
  const api = provider.apis.find((item) => item.id === settings.activeApiId) || provider.apis[0];
  if (!api) return null;
  return { ...api, providerName: provider.name };
}

// 组合读取器：把「.env 在哪、config 在哪」这两个进程特异事实注入进来，
// 其余读取链（shared/summary/agent 三套 + 策略）共享同一实现。
// readEnv/readProjectConfig 可覆盖（main 进程注入带缓存的版本）。
export function createLlmSettingsReader({ envPath = null, configPath = null, readEnv: readEnvOverride = null, readProjectConfig: readProjectConfigOverride = null } = {}) {
  const readEnv = readEnvOverride || (() => readDotEnv(envPath));
  const readProjectConfig = readProjectConfigOverride || (() => readJsonConfig(configPath));

  function readSummaryStrategySettings(env = readEnv()) {
    const configured = readProjectConfig().llm?.summary || {};
    if (
      configured.summaryStrategies
      || configured.activeArticleSummaryStrategyId
      || configured.activeNodeSummaryStrategyId
      || configured.summaryConcurrency
    ) {
      return normalizeSummaryStrategySettings(configured);
    }
    let parsed = null;
    const raw = env[LLM_SUMMARY_STRATEGIES_ENV_KEY];
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }
    const source = Array.isArray(parsed) ? { summaryStrategies: parsed } : (parsed || {});
    return normalizeSummaryStrategySettings({
      summaryStrategies: source.summaryStrategies || source.strategies,
      activeArticleSummaryStrategyId: env[LLM_SUMMARY_ARTICLE_STRATEGY_ENV_KEY] || source.activeArticleSummaryStrategyId,
      activeNodeSummaryStrategyId: env[LLM_SUMMARY_NODE_STRATEGY_ENV_KEY] || source.activeNodeSummaryStrategyId,
      summaryConcurrency: source.summaryConcurrency
    });
  }

  function normalizeLlmSummarySettings(config = {}, env = readEnv()) {
    const providers = (Array.isArray(config.providers) ? config.providers : [])
      .map((provider, index) => normalizeLlmProvider(provider, index));
    if (providers.length === 0) providers.push(defaultLlmProvider(env));

    let activeProviderId = String(config.activeProviderId || '').trim();
    if (!providers.some((provider) => provider.id === activeProviderId)) {
      activeProviderId = providers[0].id;
    }
    const activeProvider = providers.find((provider) => provider.id === activeProviderId) || providers[0];

    let activeApiId = String(config.activeApiId || '').trim();
    if (!activeProvider.apis.some((api) => api.id === activeApiId)) {
      activeApiId = activeProvider.apis[0]?.id || '';
    }

    return {
      activeProviderId,
      activeApiId,
      providers,
      independent: config.independent === true,
      ...normalizeSummaryStrategySettings(config),
      configPath,
      envPath
    };
  }

  function readStoredLlmSummarySettings(env = readEnv()) {
    const configured = readProjectConfig().llm?.shared;
    if (configured) return configured;
    const raw = env[LLM_PROVIDERS_ENV_KEY];
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? { providers: parsed } : parsed;
    } catch {
      return null;
    }
  }

  function readStoredIndependentSummarySettings(env = readEnv()) {
    const configured = readProjectConfig().llm?.summary;
    if (configured?.providers) return configured;
    const raw = env[LLM_SUMMARY_PROVIDERS_ENV_KEY];
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? { providers: parsed } : parsed;
    } catch {
      return null;
    }
  }

  function readSharedLlmSettings(env = readEnv()) {
    const stored = readStoredLlmSummarySettings(env);
    const base = stored || { providers: [defaultLlmProvider(env)] };
    return attachLlmSecrets(normalizeLlmSummarySettings({
      ...base,
      ...readSummaryStrategySettings(env),
      independent: false,
      activeProviderId: base.activeProviderId || env[LLM_ACTIVE_PROVIDER_ENV_KEY],
      activeApiId: base.activeApiId || env[LLM_ACTIVE_API_ENV_KEY]
    }, env), env);
  }

  /** @returns {Record<string, any>} */
  function readLlmSummarySettings() {
    const env = readEnv();
    const configuredSummary = readProjectConfig().llm?.summary || {};
    const independent = hasOwn(configuredSummary, 'independent')
      ? configuredSummary.independent === true
      : hasOwn(env, LLM_INDEPENDENT_ENV_KEY)
        ? env[LLM_INDEPENDENT_ENV_KEY] === 'true'
        : false;
    if (!independent) return { ...readSharedLlmSettings(env), independent: false };

    const stored = readStoredIndependentSummarySettings(env);
    const base = stored || readSharedLlmSettings(env);
    return attachLlmSecrets(normalizeLlmSummarySettings({
      ...base,
      ...readSummaryStrategySettings(env),
      independent: true,
      activeProviderId: configuredSummary.activeProviderId || env[LLM_SUMMARY_ACTIVE_PROVIDER_ENV_KEY] || base.activeProviderId,
      activeApiId: configuredSummary.activeApiId || env[LLM_SUMMARY_ACTIVE_API_ENV_KEY] || base.activeApiId
    }, env), env);
  }

  function readAgentSettings() {
    const env = readEnv();
    const agentConfig = readProjectConfig().llm?.agent || {};
    return {
      ...readSharedLlmSettings(env),
      personalPrompt: agentConfig.personalPrompt ?? decodeDotEnvMultiline(env[AGENT_PERSONAL_PROMPT_ENV_KEY]),
      toolSettings: normalizeAgentToolSettings(agentConfig.toolSettings || {})
    };
  }

  return {
    readEnv,
    readProjectConfig,
    readSummaryStrategySettings,
    normalizeLlmSummarySettings,
    readStoredLlmSummarySettings,
    readStoredIndependentSummarySettings,
    readSharedLlmSettings,
    readLlmSummarySettings,
    readAgentSettings
  };
}
