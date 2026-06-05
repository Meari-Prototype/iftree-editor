import { useEffect, useState } from 'react';
import { Database, FileText, KeyRound, Plus, Trash2
} from 'lucide-react';
import { LLM_PROVIDER_PRESETS, newLlmApi, newLlmProvider,
  normalizeLlmSettingsForEditor, providerMatchesPreset
} from '../../lib/summary-utils.mjs';

const ANTHROPIC_MAX_OUTPUT_MESSAGE = 'Anthropic compatible 需要填写最大输出 token。';

function needsAnthropicMaxOutput(api = {}) {
  return String(api.protocol || 'openai-compatible') === 'anthropic-compatible'
    && Number(api.maxOutputTokens) <= 0;
}

export function LlmSummarySettingsPanel({
  settings,
  onChange,
  title = 'LLM 摘要',
  description = '非密钥配置写入项目根目录 JSON；API Key 保留在 .env。',
  currentLabel = '当前 API',
  showHeader = true
}) {
  const config = normalizeLlmSettingsForEditor(settings || {});
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const activeProvider = providers.find((provider) => provider.id === config.activeProviderId) || providers[0] || null;
  const apis = Array.isArray(activeProvider?.apis) ? activeProvider.apis : [];
  const activeApi = apis.find((api) => api.id === config.activeApiId) || apis[0] || null;
  const activeReasoningEfforts = Array.isArray(activeApi?.reasoningEfforts)
    ? activeApi.reasoningEfforts.join(',')
    : String(activeApi?.reasoningEfforts || '');
  const [apiValidationMessage, setApiValidationMessage] = useState('');
  const visibleApiValidationMessage = apiValidationMessage || (
    activeApi && needsAnthropicMaxOutput(activeApi) ? ANTHROPIC_MAX_OUTPUT_MESSAGE : ''
  );
  useEffect(() => {
    setApiValidationMessage('');
  }, [activeApi?.id]);
  const save = (next) => onChange?.(next);
  const saveProviders = (nextProviders, extra = {}) => save({ ...config, providers: nextProviders, ...extra });
  const providerOptions = [
    ...providers.map((provider) => ({ kind: 'provider', value: provider.id, label: provider.name || '未命名供应商' })),
    ...LLM_PROVIDER_PRESETS
      .filter((preset) => !providers.some((provider) => providerMatchesPreset(provider, preset)))
      .map((preset) => ({ kind: 'preset', value: `preset:${preset.id}`, label: preset.name }))
  ];

  const addProvider = () => {
    const provider = newLlmProvider(null, providers);
    saveProviders([...providers, provider], {
      activeProviderId: provider.id,
      activeApiId: provider.apis[0].id
    });
  };

  const deleteProvider = () => {
    if (!activeProvider || providers.length <= 1) return;
    const ok = window.confirm(`确定删除供应商「${activeProvider.name || '未命名供应商'}」及其全部 API 配置吗？此操作保存后不能直接撤销。`);
    if (!ok) return;
    const nextProviders = providers.filter((provider) => provider.id !== activeProvider.id);
    const nextProvider = nextProviders[0];
    saveProviders(nextProviders, {
      activeProviderId: nextProvider?.id || '',
      activeApiId: nextProvider?.apis?.[0]?.id || ''
    });
  };

  const selectProvider = (providerId) => {
    if (providerId.startsWith('preset:')) {
      const preset = LLM_PROVIDER_PRESETS.find((item) => item.id === providerId.slice('preset:'.length));
      if (!preset) return;
      const provider = newLlmProvider(preset, providers);
      saveProviders([...providers, provider], {
        activeProviderId: provider.id,
        activeApiId: provider.apis?.[0]?.id || ''
      });
      return;
    }
    const provider = providers.find((item) => item.id === providerId);
    if (!provider) return;
    saveProviders(providers, {
      activeProviderId: provider.id,
      activeApiId: provider.apis?.[0]?.id || ''
    });
  };

  const updateProvider = (patch) => {
    if (!activeProvider) return;
    saveProviders(providers.map((provider) => (
      provider.id === activeProvider.id ? { ...provider, ...patch } : provider
    )));
  };

  const addApi = () => {
    if (!activeProvider) return;
    const api = newLlmApi();
    saveProviders(providers.map((provider) => (
      provider.id === activeProvider.id
        ? { ...provider, apis: [...(provider.apis || []), api] }
        : provider
    )), { activeApiId: api.id });
  };

  const deleteApi = () => {
    if (!activeProvider || !activeApi || apis.length <= 1) return;
    const ok = window.confirm(`确定删除 API「${activeApi.name || '未命名 API'}」吗？此操作保存后不能直接撤销。`);
    if (!ok) return;
    const nextApis = apis.filter((api) => api.id !== activeApi.id);
    saveProviders(providers.map((provider) => (
      provider.id === activeProvider.id ? { ...provider, apis: nextApis } : provider
    )), { activeApiId: nextApis[0]?.id || '' });
  };

  const updateApi = (patch) => {
    if (!activeProvider || !activeApi) return;
    const nextApi = { ...activeApi, ...patch };
    if (needsAnthropicMaxOutput(nextApi)) {
      setApiValidationMessage(ANTHROPIC_MAX_OUTPUT_MESSAGE);
      return;
    }
    setApiValidationMessage('');
    saveProviders(providers.map((provider) => (
      provider.id === activeProvider.id
        ? {
          ...provider,
          apis: apis.map((api) => (api.id === activeApi.id ? nextApi : api))
        }
        : provider
    )));
  };

  return (
    <>
      {showHeader && (
        <header className="settings-header">
          <h1>{title}</h1>
          <p>{description}</p>
        </header>
      )}

      <section className="settings-group">
        <header>
          <h2>供应商</h2>
          <span>自动保存</span>
        </header>
        <div className="llm-settings-card">
          <div className="llm-toolbar">
            <select
              value={activeProvider?.id || ''}
              onChange={(event) => selectProvider(event.target.value)}
            >
              {providerOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <button type="button" onClick={addProvider}><Plus size={15} />新增供应商</button>
            <button type="button" disabled={providers.length <= 1} onClick={deleteProvider}><Trash2 size={15} />删除</button>
          </div>

          {activeProvider && (
            <div className="llm-form-grid">
              <label className="llm-field">
                <span>供应商名称</span>
                <input value={activeProvider.name || ''} onChange={(event) => updateProvider({ name: event.target.value })} placeholder="例如：DeepSeek" />
              </label>
              <label className="llm-field">
                <span>备注</span>
                <input value={activeProvider.note || ''} onChange={(event) => updateProvider({ note: event.target.value })} placeholder="例如：公司专用账号" />
              </label>
              <label className="llm-field llm-field-wide">
                <span>官网链接</span>
                <input value={activeProvider.websiteUrl || ''} onChange={(event) => updateProvider({ websiteUrl: event.target.value })} placeholder="https://example.com（可选）" />
              </label>
            </div>
          )}
        </div>
      </section>

      <section className="settings-group">
        <header>
          <h2>API 配置</h2>
          <span>{activeApi?.enabled === false ? '当前 API 已禁用' : '当前 API 生效'}</span>
        </header>
        <div className="llm-settings-card">
          <div className="llm-toolbar">
            <select
              value={activeApi?.id || ''}
              onChange={(event) => save({ ...config, activeApiId: event.target.value })}
            >
              {apis.map((api) => (
                <option key={api.id} value={api.id}>{api.name || '未命名 API'}</option>
              ))}
            </select>
            <button type="button" disabled={!activeProvider} onClick={addApi}><Plus size={15} />新增 API</button>
            <button type="button" disabled={apis.length <= 1} onClick={deleteApi}><Trash2 size={15} />删除</button>
          </div>

          {activeApi && (
            <div className="llm-form-grid">
              <label className="llm-field">
                <span>API 名称</span>
                <input value={activeApi.name || ''} onChange={(event) => updateApi({ name: event.target.value })} placeholder="例如：主账号" />
              </label>
              <label className="llm-field">
                <span>备注</span>
                <input value={activeApi.note || ''} onChange={(event) => updateApi({ note: event.target.value })} placeholder="例如：高上下文" />
              </label>
              <label className="llm-field llm-field-wide">
                <span>API Key</span>
                <input type="password" value={activeApi.apiKey || ''} onChange={(event) => updateApi({ apiKey: event.target.value })} placeholder="只需要填这里，会写入 .env" />
              </label>
              <label className="llm-field">
                <span>请求地址</span>
                <input value={activeApi.baseUrl || ''} onChange={(event) => updateApi({ baseUrl: event.target.value })} placeholder="https://api.deepseek.com" />
              </label>
              <label className="llm-field">
                <span>协议</span>
                <select value={activeApi.protocol || 'openai-compatible'} onChange={(event) => updateApi({ protocol: event.target.value })}>
                  <option value="openai-compatible">OpenAI compatible</option>
                  <option value="anthropic-compatible">Anthropic compatible</option>
                </select>
              </label>
              <label className="llm-field">
                <span>模型</span>
                <input value={activeApi.model || ''} onChange={(event) => updateApi({ model: event.target.value })} placeholder="deepseek-v4-pro" />
              </label>
              <label className="llm-field">
                <span>上下文窗口 token</span>
                <input type="number" min="0" value={Number(activeApi.contextLimit) > 0 ? activeApi.contextLimit : ''} onChange={(event) => updateApi({ contextLimit: event.target.value })} />
              </label>
              <label className="llm-field">
                <span>最大输出 token</span>
                <input
                  type="number"
                  min="0"
                  value={Number(activeApi.maxOutputTokens) > 0 ? activeApi.maxOutputTokens : ''}
                  onChange={(event) => updateApi({ maxOutputTokens: event.target.value })}
                  onBlur={(event) => {
                    setApiValidationMessage(needsAnthropicMaxOutput({
                      ...activeApi,
                      maxOutputTokens: event.target.value
                    }) ? ANTHROPIC_MAX_OUTPUT_MESSAGE : '');
                  }}
                />
                {visibleApiValidationMessage && <span className="llm-field-error">{visibleApiValidationMessage}</span>}
              </label>
              <label className="llm-field">
                <span>支持推理强度</span>
                <input value={activeReasoningEfforts} onChange={(event) => updateApi({ reasoningEfforts: event.target.value })} placeholder="low,medium,high,xhigh" />
              </label>
              <div className="llm-switch-row llm-field-wide">
                <label>
                  <input type="checkbox" checked={activeApi.fullUrl === true} onChange={(event) => updateApi({ fullUrl: event.target.checked })} />
                  请求地址是完整 URL
                </label>
                <label>
                  <input type="checkbox" checked={activeApi.enabled !== false} onChange={(event) => updateApi({ enabled: event.target.checked })} />
                  启用这个 API
                </label>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="settings-group">
        <header>
          <h2>当前生效值</h2>
          <span>JSON + .env</span>
        </header>
        <div className="settings-list">
          <div className="settings-row">
            <div className="settings-row-icon"><FileText size={17} /></div>
            <div className="settings-row-text">
              <strong>非密钥配置</strong>
              <span>供应商、模型、提示词选择等写入根目录 JSON</span>
            </div>
            <code>{config.configPath || 'iftree.config.json'}</code>
          </div>
          <div className="settings-row">
            <div className="settings-row-icon"><KeyRound size={17} /></div>
            <div className="settings-row-text">
              <strong>API Key</strong>
              <span>只保存密钥，不保存普通配置</span>
            </div>
            <code>{config.envPath || '.env'}</code>
          </div>
          <div className="settings-row">
            <div className="settings-row-icon"><Database size={17} /></div>
            <div className="settings-row-text">
              <strong>{currentLabel}</strong>
              <span>{activeProvider?.name || '未配置'} / {activeApi?.name || '未配置'}</span>
            </div>
            <code>{activeApi?.model || '未配置模型'}</code>
          </div>
        </div>
      </section>
    </>
  );
}
