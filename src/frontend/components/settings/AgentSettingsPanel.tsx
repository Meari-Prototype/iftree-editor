// @ts-nocheck

import { normalizeAgentToolSettings
} from '../../lib/summary-utils.js';
import { LlmSummarySettingsPanel } from './LlmSummarySettingsPanel.jsx';
import { SummaryStrategySettingsPanel } from './SummaryStrategySettingsPanel.jsx';

export function AgentSettingsPanel({
  agentSettings,
  onAgentChange,
  llmSummarySettings,
  onLlmSummaryChange
}) {
  const summaryIndependent = llmSummarySettings?.independent === true;
  const toolSettings = normalizeAgentToolSettings(agentSettings?.toolSettings || {});
  const setSummaryIndependent = (enabled) => {
    onLlmSummaryChange?.({ ...(llmSummarySettings || {}), independent: enabled });
  };
  const updateToolSettings = (patch) => {
    onAgentChange?.({
      ...(agentSettings || {}),
      toolSettings: normalizeAgentToolSettings({ ...toolSettings, ...patch })
    });
  };

  return (
    <>
      <header className="settings-header">
        <h1>Agent 模块</h1>
        <p>供应商和 API 配置默认共享；摘要生成需要不同 API 时再启用独立配置。</p>
      </header>

      <section className="settings-submodule-title">
        <h2>供应商与 API</h2>
        <p>用于右侧 Agent 面板；摘要生成默认也复用这里的当前 API。</p>
      </section>
      <LlmSummarySettingsPanel
        settings={agentSettings}
        onChange={onAgentChange}
        currentLabel="当前共享 API"
        showHeader={false}
      />

      <section className="settings-submodule-title">
        <h2>个性提示词</h2>
        <p>这些额外说明会在每次 Agent 对话开始前固定阅读。</p>
      </section>
      <div className="llm-settings-card">
        <label className="llm-field llm-field-wide">
          <span>额外说明</span>
          <textarea
            value={agentSettings?.personalPrompt || ''}
            placeholder="（为你的智能体提供额外说明，这些信息会在每次对话开始前被固定阅读）"
            onChange={(event) => onAgentChange?.({ ...(agentSettings || {}), personalPrompt: event.target.value })}
          />
        </label>
      </div>

      <section className="settings-submodule-title">
        <h2>搜索工具</h2>
        <p>控制 Agent 搜索、读取和网页打开时返回给模型的内容规模。</p>
      </section>
      <div className="llm-settings-card">
        <div className="llm-form-grid">
          <label className="llm-field">
            <span>文档搜索结果数</span>
            <input type="number" min="1" max="80" value={toolSettings.searchResultLimit} onChange={(event) => updateToolSettings({ searchResultLimit: event.target.value })} />
          </label>
          <label className="llm-field">
            <span>搜索文本块上限</span>
            <input type="number" min="200" max="50000" value={toolSettings.searchBlockMaxChars} onChange={(event) => updateToolSettings({ searchBlockMaxChars: event.target.value })} />
          </label>
          <label className="llm-field">
            <span>读取内容上限</span>
            <input type="number" min="200" max="100000" value={toolSettings.fetchContentMaxChars} onChange={(event) => updateToolSettings({ fetchContentMaxChars: event.target.value })} />
          </label>
          <label className="llm-field">
            <span>网页搜索结果数</span>
            <input type="number" min="1" max="10" value={toolSettings.webSearchResultLimit} onChange={(event) => updateToolSettings({ webSearchResultLimit: event.target.value })} />
          </label>
          <label className="llm-field">
            <span>网页正文上限</span>
            <input type="number" min="1000" max="50000" value={toolSettings.webOpenCharLimit} onChange={(event) => updateToolSettings({ webOpenCharLimit: event.target.value })} />
          </label>
        </div>
      </div>

      <section className="settings-submodule-title settings-submodule-row">
        <div>
          <h2>摘要生成</h2>
          <p>{summaryIndependent ? '用于树视图里的摘要按钮；当前使用独立 API 配置。' : '用于树视图里的摘要按钮；当前复用上方 Agent API。'}</p>
        </div>
        <label className="settings-inline-toggle">
          <input
            type="checkbox"
            checked={summaryIndependent}
            onChange={(event) => setSummaryIndependent(event.target.checked)}
          />
          <span>为摘要生成启用独立配置</span>
        </label>
      </section>
      <SummaryStrategySettingsPanel
        settings={llmSummarySettings}
        onChange={onLlmSummaryChange}
      />
      {summaryIndependent ? (
        <LlmSummarySettingsPanel
          settings={llmSummarySettings}
          onChange={onLlmSummaryChange}
          currentLabel="当前摘要 API"
          showHeader={false}
        />
      ) : (
        <div className="settings-shared-summary">
          摘要生成将直接使用上方选中的供应商和 API。
        </div>
      )}
    </>
  );
}
