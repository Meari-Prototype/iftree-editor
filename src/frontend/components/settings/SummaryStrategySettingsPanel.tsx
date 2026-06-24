// @ts-nocheck
import { Plus, Trash2
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { newSummaryStrategy, normalizeSummaryConcurrency, normalizeSummaryStrategy, normalizeSummaryStrategySettings
} from '../../lib/summary-utils.js';

export function SummaryStrategySettingsPanel({ settings, onChange }) {
  const config = normalizeSummaryStrategySettings(settings || {});
  const strategies = config.summaryStrategies;
  const [editingId, setEditingId] = useState(config.activeNodeSummaryStrategyId || strategies[0]?.id || '');
  const [numberDrafts, setNumberDrafts] = useState({});
  const editing = strategies.find((strategy) => strategy.id === editingId) || strategies[0] || null;
  useEffect(() => {
    if (!strategies.some((strategy) => strategy.id === editingId)) {
      setEditingId(config.activeNodeSummaryStrategyId || strategies[0]?.id || '');
    }
  }, [config.activeNodeSummaryStrategyId, editingId, strategies]);

  const save = (patch) => onChange?.({ ...(settings || {}), ...patch });
  const saveStrategies = (nextStrategies, extra = {}) => {
    const fallback = nextStrategies[0]?.id || '';
    save({
      summaryStrategies: nextStrategies,
      activeArticleSummaryStrategyId: nextStrategies.some((strategy) => strategy.id === config.activeArticleSummaryStrategyId)
        ? config.activeArticleSummaryStrategyId
        : fallback,
      activeNodeSummaryStrategyId: nextStrategies.some((strategy) => strategy.id === config.activeNodeSummaryStrategyId)
        ? config.activeNodeSummaryStrategyId
        : fallback,
      ...extra
    });
  };
  const addStrategy = () => {
    const strategy = newSummaryStrategy(strategies);
    saveStrategies([...strategies, strategy]);
    setEditingId(strategy.id);
  };
  const deleteStrategy = () => {
    if (!editing || strategies.length <= 1) return;
    const ok = window.confirm(`确定删除摘要策略「${editing.name || '未命名策略'}」吗？`);
    if (!ok) return;
    const next = strategies.filter((strategy) => strategy.id !== editing.id);
    const fallback = next[0]?.id || '';
    saveStrategies(next, {
      activeArticleSummaryStrategyId: config.activeArticleSummaryStrategyId === editing.id ? fallback : config.activeArticleSummaryStrategyId,
      activeNodeSummaryStrategyId: config.activeNodeSummaryStrategyId === editing.id ? fallback : config.activeNodeSummaryStrategyId
    });
    setEditingId(fallback);
  };
  const updateStrategy = (patch) => {
    if (!editing) return;
    saveStrategies(strategies.map((strategy, index) => (
      strategy.id === editing.id ? normalizeSummaryStrategy({ ...strategy, ...patch }, index) : strategy
    )));
  };
  const numberDraftKey = (field) => `${editing?.id || ''}:${field}`;
  const numberValue = (field) => {
    const key = numberDraftKey(field);
    return Object.prototype.hasOwnProperty.call(numberDrafts, key) ? numberDrafts[key] : editing?.[field];
  };
  const settingsNumberValue = (field) => {
    const key = `settings:${field}`;
    return Object.prototype.hasOwnProperty.call(numberDrafts, key) ? numberDrafts[key] : config[field];
  };
  const updateNumber = (field, value) => {
    if (!editing) return;
    const key = numberDraftKey(field);
    setNumberDrafts((drafts) => ({ ...drafts, [key]: value }));
    if (value !== '') updateStrategy({ [field]: value });
  };
  const updateSettingsNumber = (field, value) => {
    const key = `settings:${field}`;
    setNumberDrafts((drafts) => ({ ...drafts, [key]: value }));
    if (value !== '') save({ [field]: normalizeSummaryConcurrency(value) });
  };
  const commitNumberDraft = (field) => {
    const key = numberDraftKey(field);
    setNumberDrafts((drafts) => {
      if (!Object.prototype.hasOwnProperty.call(drafts, key)) return drafts;
      const next = { ...drafts };
      delete next[key];
      return next;
    });
  };
  const commitSettingsNumberDraft = (field) => {
    const key = `settings:${field}`;
    setNumberDrafts((drafts) => {
      if (!Object.prototype.hasOwnProperty.call(drafts, key)) return drafts;
      const next = { ...drafts };
      delete next[key];
      return next;
    });
  };

  return (
    <section className="settings-group">
      <header>
        <h2>摘要算法</h2>
        <span>自动保存</span>
      </header>
      <div className="llm-settings-card">
        <div className="summary-strategy-current">
          <label className="llm-field">
            <span>全文摘要</span>
            <select value={config.activeArticleSummaryStrategyId} onChange={(event) => save({ activeArticleSummaryStrategyId: event.target.value })}>
              {strategies.map((strategy) => <option key={strategy.id} value={strategy.id}>{strategy.name}</option>)}
            </select>
          </label>
          <label className="llm-field">
            <span>节点/子树摘要</span>
            <select value={config.activeNodeSummaryStrategyId} onChange={(event) => save({ activeNodeSummaryStrategyId: event.target.value })}>
              {strategies.map((strategy) => <option key={strategy.id} value={strategy.id}>{strategy.name}</option>)}
            </select>
          </label>
        </div>
        <div className="llm-toolbar">
          <select value={editing?.id || ''} onChange={(event) => setEditingId(event.target.value)}>
            {strategies.map((strategy) => (
              <option key={strategy.id} value={strategy.id}>{strategy.name}</option>
            ))}
          </select>
          <button type="button" onClick={addStrategy}><Plus size={15} />新增策略</button>
          <button type="button" disabled={strategies.length <= 1} onClick={deleteStrategy}><Trash2 size={15} />删除</button>
        </div>
        {editing && (
          <div className="llm-form-grid">
            <label className="llm-field">
              <span>批量并发请求数</span>
              <input type="number" min="1" value={settingsNumberValue('summaryConcurrency')} onBlur={() => commitSettingsNumberDraft('summaryConcurrency')} onChange={(event) => updateSettingsNumber('summaryConcurrency', event.target.value)} />
            </label>
            <label className="llm-field">
              <span>策略名称</span>
              <input value={editing.name || ''} onChange={(event) => updateStrategy({ name: event.target.value })} />
            </label>
            <label className="llm-field">
              <span>低于字数跳过（0=不跳过）</span>
              <input type="number" min="0" value={numberValue('skipBelowChars')} onBlur={() => commitNumberDraft('skipBelowChars')} onChange={(event) => updateNumber('skipBelowChars', event.target.value)} />
            </label>
            <label className="llm-field">
              <span>相对比例 %（0=自由）</span>
              <input type="number" min="0" max="90" step="0.1" value={numberValue('ratioPercent')} onBlur={() => commitNumberDraft('ratioPercent')} onChange={(event) => updateNumber('ratioPercent', event.target.value)} />
            </label>
            <label className="llm-field">
              <span>不得少于字数（0=无下限）</span>
              <input type="number" min="0" value={numberValue('minWords')} onBlur={() => commitNumberDraft('minWords')} onChange={(event) => updateNumber('minWords', event.target.value)} />
            </label>
            <label className="llm-field">
              <span>不得多于字数（0=无上限）</span>
              <input type="number" min="0" value={numberValue('maxWords')} onBlur={() => commitNumberDraft('maxWords')} onChange={(event) => updateNumber('maxWords', event.target.value)} />
            </label>
          </div>
        )}
      </div>
    </section>
  );
}
