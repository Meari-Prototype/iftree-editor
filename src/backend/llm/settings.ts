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
} from '../../agent/llm-api-config.js';
import {
  defaultSummaryStrategies,
  llmId,
  normalizeAgentToolSettings,
  normalizeSummaryConcurrency,
  normalizeSummaryStrategy
} from './defaults.js';

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

export type EnvMap = Record<string, string | undefined>;

export interface LlmApiRaw {
  id?: unknown;
  name?: unknown;
  note?: unknown;
  apiKey?: unknown;
  baseUrl?: unknown;
  fullUrl?: unknown;
  model?: unknown;
  protocol?: unknown;
  contextLimit?: unknown;
  contextWindowTokens?: unknown;
  contextWindow?: unknown;
  maxContextTokens?: unknown;
  modelCard?: { contextLimit?: unknown };
  metadata?: { contextLimit?: unknown };
  maxOutputTokens?: unknown;
  maxTokens?: unknown;
  max_tokens?: unknown;
  reasoningEfforts?: unknown;
  reasoning_efforts?: unknown;
  reasoningEffortMap?: unknown;
  reasoning_effort_map?: unknown;
  enabled?: unknown;
  [extra: string]: unknown;
}

export interface LlmApi {
  id: string;
  name: string;
  note: string;
  apiKey: string;
  baseUrl: string;
  fullUrl: boolean;
  model: string;
  protocol: string;
  contextLimit: number;
  maxOutputTokens: number;
  reasoningEfforts: string[];
  reasoningEffortMap: Record<string, string>;
  enabled: boolean;
}

export interface LlmProviderRaw {
  id?: unknown;
  name?: unknown;
  note?: unknown;
  websiteUrl?: unknown;
  apis?: LlmApiRaw[];
}

export interface LlmProvider {
  id: string;
  name: string;
  note: string;
  websiteUrl: string;
  apis: LlmApi[];
}

export interface ActiveLlmApi extends LlmApi {
  providerName: string;
}

export interface SummaryStrategySettings {
  summaryStrategies: ReturnType<typeof normalizeSummaryStrategy>[];
  activeArticleSummaryStrategyId: string;
  activeNodeSummaryStrategyId: string;
  summaryConcurrency: number;
}

export interface LlmSummarySettings extends SummaryStrategySettings {
  activeProviderId: string;
  activeApiId: string;
  providers: LlmProvider[];
  independent: boolean;
  configPath: string | null;
  envPath: string | null;
}

export interface AgentSettings extends LlmSummarySettings {
  personalPrompt: string;
  toolSettings: ReturnType<typeof normalizeAgentToolSettings>;
}

interface SummaryStrategySettingsConfig {
  summaryStrategies?: unknown;
  activeArticleSummaryStrategyId?: unknown;
  activeNodeSummaryStrategyId?: unknown;
  summaryConcurrency?: unknown;
  [extra: string]: unknown;
}

interface LlmSummarySettingsConfig extends SummaryStrategySettingsConfig {
  providers?: LlmProviderRaw[] | unknown;
  activeProviderId?: unknown;
  activeApiId?: unknown;
  independent?: unknown;
}

interface StoredSummarySettings extends LlmSummarySettingsConfig {
  providers?: LlmProviderRaw[];
}

interface ProjectConfig {
  llm?: {
    shared?: StoredSummarySettings;
    summary?: StoredSummarySettings;
    agent?: { personalPrompt?: string; toolSettings?: Parameters<typeof normalizeAgentToolSettings>[0] };
  };
  [extra: string]: unknown;
}

function hasOwn(value: unknown, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

export function readDotEnv(envPath: string | null | undefined): EnvMap {
  const values: EnvMap = {};
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

export function decodeDotEnvMultiline(value: unknown): string {
  return String(value || '').replace(/\\n/g, '\n');
}

export function readJsonConfig(configPath: string | null | undefined): ProjectConfig {
  if (!configPath || !existsSync(configPath)) return {};
  try {
    return (JSON.parse(readFileSync(configPath, 'utf8')) as ProjectConfig) || {};
  } catch {
    return {};
  }
}

export function safeEnvKey(value: unknown): string {
  const text = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return text || 'DEFAULT';
}

export function llmApiKeyEnvKey(providerId: unknown, apiId: unknown): string {
  return `IFTREE_LLM_API_KEY_${safeEnvKey(providerId)}_${safeEnvKey(apiId)}`;
}

export function normalizeLlmApi(api: LlmApiRaw = {}, index = 0): LlmApi {
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

export function normalizeLlmProvider(provider: LlmProviderRaw = {}, index = 0): LlmProvider {
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

export function defaultLlmProvider(env: EnvMap = {}): LlmProvider {
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

export function normalizeSummaryStrategySettings(config: SummaryStrategySettingsConfig = {}): SummaryStrategySettings {
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

export function apiKeyFor(env: EnvMap, providerId: unknown, apiId: unknown, legacyValue: string = ''): string {
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

export function attachLlmSecrets<T extends { providers?: LlmProvider[] }>(settings: T, env: EnvMap = {}): T {
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

export function stripLlmSecrets<T extends { providers?: LlmProvider[] }>(settings: T) {
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

export function llmApiKeyEnvValues(settings: { providers?: LlmProvider[] } = {}): Record<string, string> {
  const values: Record<string, string> = {};
  for (const provider of settings.providers || []) {
    for (const api of provider.apis || []) {
      if (hasOwn(api, 'apiKey')) {
        values[llmApiKeyEnvKey(provider.id, api.id)] = api.apiKey || '';
      }
    }
  }
  return values;
}

export function cleanupLegacyLlmEnvValues(extra: Record<string, string | null> = {}): Record<string, string | null> {
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

export function activeLlmApiFromSettings(settings: { providers: LlmProvider[]; activeProviderId?: string; activeApiId?: string }): ActiveLlmApi | null {
  const provider = settings.providers.find((item) => item.id === settings.activeProviderId) || settings.providers[0];
  if (!provider) return null;
  const api = provider.apis.find((item) => item.id === settings.activeApiId) || provider.apis[0];
  if (!api) return null;
  return { ...api, providerName: provider.name };
}

export interface CreateLlmSettingsReaderOptions {
  envPath?: string | null;
  configPath?: string | null;
  readEnv?: (() => EnvMap) | null;
  readProjectConfig?: (() => ProjectConfig) | null;
}

export interface LlmSettingsReader {
  readEnv: () => EnvMap;
  readProjectConfig: () => ProjectConfig;
  readSummaryStrategySettings: (env?: EnvMap) => SummaryStrategySettings;
  normalizeLlmSummarySettings: (config?: LlmSummarySettingsConfig, env?: EnvMap) => LlmSummarySettings;
  readStoredLlmSummarySettings: (env?: EnvMap) => StoredSummarySettings | null;
  readStoredIndependentSummarySettings: (env?: EnvMap) => StoredSummarySettings | null;
  readSharedLlmSettings: (env?: EnvMap) => LlmSummarySettings;
  readLlmSummarySettings: () => LlmSummarySettings;
  readAgentSettings: () => AgentSettings;
  activeAgentApi: () => ActiveLlmApi;
  agentApiFromPayload: (payload?: Record<string, unknown>) => ActiveLlmApi;
  activeLlmSummaryApi: () => ActiveLlmApi;
}

// 组合读取器：把「.env 在哪、config 在哪」这两个进程特异事实注入进来，
// 其余读取链（shared/summary/agent 三套 + 策略）共享同一实现。
// readEnv/readProjectConfig 可覆盖（main 进程注入带缓存的版本）。
export function createLlmSettingsReader({
  envPath = null,
  configPath = null,
  readEnv: readEnvOverride = null,
  readProjectConfig: readProjectConfigOverride = null
}: CreateLlmSettingsReaderOptions = {}): LlmSettingsReader {
  const readEnv = readEnvOverride || (() => readDotEnv(envPath));
  const readProjectConfig = readProjectConfigOverride || (() => readJsonConfig(configPath));

  function readSummaryStrategySettings(env: EnvMap = readEnv()): SummaryStrategySettings {
    const configured = (readProjectConfig().llm?.summary || {}) as SummaryStrategySettingsConfig;
    if (
      configured.summaryStrategies
      || configured.activeArticleSummaryStrategyId
      || configured.activeNodeSummaryStrategyId
      || configured.summaryConcurrency
    ) {
      return normalizeSummaryStrategySettings(configured);
    }
    let parsed: unknown = null;
    const raw = env[LLM_SUMMARY_STRATEGIES_ENV_KEY];
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }
    const source: SummaryStrategySettingsConfig & { strategies?: unknown } = Array.isArray(parsed)
      ? { summaryStrategies: parsed }
      : (parsed && typeof parsed === 'object' ? parsed as SummaryStrategySettingsConfig : {});
    return normalizeSummaryStrategySettings({
      summaryStrategies: source.summaryStrategies || (source as { strategies?: unknown }).strategies,
      activeArticleSummaryStrategyId: env[LLM_SUMMARY_ARTICLE_STRATEGY_ENV_KEY] || source.activeArticleSummaryStrategyId,
      activeNodeSummaryStrategyId: env[LLM_SUMMARY_NODE_STRATEGY_ENV_KEY] || source.activeNodeSummaryStrategyId,
      summaryConcurrency: source.summaryConcurrency
    });
  }

  function normalizeLlmSummarySettings(config: LlmSummarySettingsConfig = {}, env: EnvMap = readEnv()): LlmSummarySettings {
    const providers = (Array.isArray(config.providers) ? config.providers : [])
      .map((provider: LlmProviderRaw, index: number) => normalizeLlmProvider(provider, index));
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

  function readStoredLlmSummarySettings(env: EnvMap = readEnv()): StoredSummarySettings | null {
    const configured = readProjectConfig().llm?.shared;
    if (configured) return configured;
    const raw = env[LLM_PROVIDERS_ENV_KEY];
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? { providers: parsed as LlmProviderRaw[] } : parsed as StoredSummarySettings;
    } catch {
      return null;
    }
  }

  function readStoredIndependentSummarySettings(env: EnvMap = readEnv()): StoredSummarySettings | null {
    const configured = readProjectConfig().llm?.summary;
    if (configured?.providers) return configured;
    const raw = env[LLM_SUMMARY_PROVIDERS_ENV_KEY];
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? { providers: parsed as LlmProviderRaw[] } : parsed as StoredSummarySettings;
    } catch {
      return null;
    }
  }

  function readSharedLlmSettings(env: EnvMap = readEnv()): LlmSummarySettings {
    const stored = readStoredLlmSummarySettings(env);
    const base: LlmSummarySettingsConfig = stored || { providers: [defaultLlmProvider(env)] };
    return attachLlmSecrets(normalizeLlmSummarySettings({
      ...base,
      ...readSummaryStrategySettings(env),
      independent: false,
      activeProviderId: base.activeProviderId || env[LLM_ACTIVE_PROVIDER_ENV_KEY],
      activeApiId: base.activeApiId || env[LLM_ACTIVE_API_ENV_KEY]
    }, env), env);
  }

  function readLlmSummarySettings(): LlmSummarySettings {
    const env = readEnv();
    const configuredSummary = (readProjectConfig().llm?.summary || {}) as LlmSummarySettingsConfig;
    const independent = hasOwn(configuredSummary, 'independent')
      ? configuredSummary.independent === true
      : hasOwn(env, LLM_INDEPENDENT_ENV_KEY)
        ? env[LLM_INDEPENDENT_ENV_KEY] === 'true'
        : false;
    if (!independent) return { ...readSharedLlmSettings(env), independent: false };

    const stored = readStoredIndependentSummarySettings(env);
    const base: LlmSummarySettingsConfig = (stored || readSharedLlmSettings(env)) as LlmSummarySettingsConfig;
    return attachLlmSecrets(normalizeLlmSummarySettings({
      ...base,
      ...readSummaryStrategySettings(env),
      independent: true,
      activeProviderId: configuredSummary.activeProviderId || env[LLM_SUMMARY_ACTIVE_PROVIDER_ENV_KEY] || base.activeProviderId,
      activeApiId: configuredSummary.activeApiId || env[LLM_SUMMARY_ACTIVE_API_ENV_KEY] || base.activeApiId
    }, env), env);
  }

  function readAgentSettings(): AgentSettings {
    const env = readEnv();
    const agentConfig = readProjectConfig().llm?.agent || {};
    return {
      ...readSharedLlmSettings(env),
      personalPrompt: agentConfig.personalPrompt ?? decodeDotEnvMultiline(env[AGENT_PERSONAL_PROMPT_ENV_KEY]),
      toolSettings: normalizeAgentToolSettings(agentConfig.toolSettings || {})
    };
  }

  // .env 直连覆盖（最高优先级）：设了 IFTREE_AGENT_BASE_URL + IFTREE_AGENT_MODEL
  // 即直接用该端点/模型，绕过 iftree.config.json 的 provider 选择，便于本地 ollama
  // 等通过 .env 一键介入。API_KEY 可省（ollama 不校验，默认占位 'ollama'）。
  function agentEnvOverride(env: EnvMap): ActiveLlmApi | null {
    const baseUrl = String(process.env.IFTREE_AGENT_BASE_URL || env.IFTREE_AGENT_BASE_URL || '').trim();
    const model = String(process.env.IFTREE_AGENT_MODEL || env.IFTREE_AGENT_MODEL || '').trim();
    if (!baseUrl || !model) return null;
    const apiKey = String(process.env.IFTREE_AGENT_API_KEY || env.IFTREE_AGENT_API_KEY || 'ollama').trim();
    return {
      id: 'env-direct',
      providerName: 'EnvDirect',
      name: model,
      note: '',
      apiKey,
      baseUrl,
      model,
      fullUrl: false,
      protocol: 'openai-compatible',
      contextLimit: 0,
      maxOutputTokens: 0,
      reasoningEfforts: [],
      reasoningEffortMap: {},
      enabled: true
    };
  }

  // 当前 agent 该用哪个 provider/api：.env 直连覆盖 > 设置页选中的共享 provider > legacy env。
  function activeAgentApi(): ActiveLlmApi {
    const env = readEnv();
    const override = agentEnvOverride(env);
    if (override) return override;
    const stored = Boolean(readProjectConfig().llm?.shared?.providers || env[LLM_PROVIDERS_ENV_KEY]);
    const active = activeLlmApiFromSettings(readAgentSettings());
    if (active?.apiKey && active.enabled !== false) return active;
    if (stored) {
      if (active?.enabled === false) throw new Error('当前共享 API 已禁用，请在设置里启用或切换。');
      throw new Error('当前共享 API 未配置 API Key，请在设置里填写。');
    }
    const apiKey = process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY || env.DEEPSEEK_API_KEY || '';
    if (!apiKey) throw new Error('未配置共享 API Key，请在设置页填写。');
    return {
      id: 'legacy-shared',
      providerName: 'Legacy',
      name: 'Legacy',
      note: '',
      apiKey,
      baseUrl: process.env.OPENAI_BASE_URL || process.env.DEEPSEEK_BASE_URL || env.OPENAI_BASE_URL || env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      model: process.env.OPENAI_MODEL || process.env.DEEPSEEK_MODEL || env.OPENAI_MODEL || env.DEEPSEEK_MODEL || 'deepseek-v4-pro',
      fullUrl: false,
      protocol: 'openai-compatible',
      contextLimit: 0,
      maxOutputTokens: 0,
      reasoningEfforts: [],
      reasoningEffortMap: {},
      enabled: true
    };
  }

  function agentApiFromPayload(payload: Record<string, unknown> = {}): ActiveLlmApi {
    const settings = readAgentSettings();
    const providerId = String(payload.agentProviderId || payload.providerId || '').trim();
    const apiId = String(payload.agentApiId || payload.apiId || '').trim();
    if (providerId || apiId) {
      const provider = settings.providers.find((item) => item.id === providerId)
        || settings.providers.find((item) => item.apis.some((api) => api.id === apiId));
      const api = provider?.apis.find((item) => item.id === apiId);
      if (provider && api) {
        if (api.enabled === false) throw new Error('当前选择的 Agent API 已禁用，请切换模型或在设置里启用。');
        if (!api.apiKey) throw new Error('当前选择的 Agent API 未配置 API Key。');
        return { ...api, providerName: provider.name };
      }
    }
    const active = activeAgentApi();
    const model = String(payload.agentModel || payload.model || '').trim();
    return model ? { ...active, model } : active;
  }

  // 摘要该用哪个 api：独立摘要配置启用时用其自身 provider，否则复用 agent 的选择。
  function activeLlmSummaryApi(): ActiveLlmApi {
    const settings = readLlmSummarySettings();
    if (settings.independent !== true) return activeAgentApi();
    const env = readEnv();
    const stored = Boolean(readProjectConfig().llm?.summary?.providers || env[LLM_SUMMARY_PROVIDERS_ENV_KEY]);
    const active = activeLlmApiFromSettings(settings);
    if (active?.apiKey && active.enabled !== false) return active;
    if (stored) {
      if (active?.enabled === false) throw new Error('当前 LLM 摘要 API 已禁用，请在设置里启用或切换。');
      throw new Error('当前 LLM 摘要 API 未配置 API Key，请在设置里填写。');
    }
    const apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY || '';
    if (!apiKey) throw new Error('未配置 LLM 摘要 API Key，请检查 .env 或设置页。');
    return {
      id: 'legacy-summary',
      providerName: 'Legacy',
      name: 'Legacy',
      note: '',
      apiKey,
      baseUrl: process.env.DEEPSEEK_BASE_URL || process.env.OPENAI_BASE_URL || env.DEEPSEEK_BASE_URL || env.OPENAI_BASE_URL || 'https://api.deepseek.com',
      model: process.env.DEEPSEEK_MODEL || process.env.OPENAI_MODEL || env.DEEPSEEK_MODEL || env.OPENAI_MODEL || 'deepseek-v4-pro',
      fullUrl: false,
      protocol: 'openai-compatible',
      contextLimit: 0,
      maxOutputTokens: 0,
      reasoningEfforts: [],
      reasoningEffortMap: {},
      enabled: true
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
    readAgentSettings,
    activeAgentApi,
    agentApiFromPayload,
    activeLlmSummaryApi
  };
}
