// @ts-nocheck

import { useEffect, useState } from 'react';


import {
  DEFAULT_SUMMARY_STRATEGIES, normalizeSummaryStrategy,
  summarySkipBelowCount, summaryStrategyLabel
} from '../lib/summary-utils.js';


export function SummaryConfirmDialog({ request, onCancel, onConfirm }) {
  const strategyIndex = Number.isInteger(request?.strategyIndex)
    ? request.strategyIndex
    : (request?.mode === 'article' ? 0 : 1);
  const options = Array.isArray(request?.strategyOptions) && request.strategyOptions.length > 0
    ? request.strategyOptions.map((strategy, index) => normalizeSummaryStrategy(strategy, index))
    : DEFAULT_SUMMARY_STRATEGIES.map((strategy, index) => normalizeSummaryStrategy(strategy, index));
  const initial = normalizeSummaryStrategy(
    request?.strategy || options[strategyIndex] || options[0],
    strategyIndex
  );
  const [draft, setDraft] = useState(initial);

  useEffect(() => {
    setDraft(initial);
  }, [request]);

  const updateNumber = (key, value) => {
    setDraft((current) => (
      value === ''
        ? { ...current, [key]: '' }
        : normalizeSummaryStrategy({ ...current, [key]: value }, strategyIndex)
    ));
  };
  const commitNumbers = () => {
    setDraft((current) => normalizeSummaryStrategy(current, strategyIndex));
  };
  const selectStrategy = (id) => {
    const selected = options.find((strategy) => strategy.id === id);
    if (selected) setDraft(selected);
  };
  const skippedShort = summarySkipBelowCount(request?.summaryItems || [], draft, strategyIndex);
  const skippedGenerated = Number(request?.skippedGenerated || 0);

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <form
        className="dialog-box summary-confirm-dialog"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm?.(normalizeSummaryStrategy(draft, strategyIndex));
        }}
      >
        <div className="dialog-header">确认摘要配置</div>
        <p className="dialog-message">
          将为「{request?.scopeLabel || '摘要'}」生成摘要备注。实际目标：{request?.targetLabel || '无'}。
        </p>
        <div className="summary-confirm-meta">
          <span>当前选择：{request?.selectedLabel || '无'}</span>
          <span>当前配置会跳过短文本 {skippedShort} 个，已有摘要跳过 {skippedGenerated} 个。</span>
        </div>
        <label className="dialog-field">
          <span>复用配置</span>
          <select className="dialog-input" value={draft.id} onChange={(event) => selectStrategy(event.target.value)}>
            {options.map((strategy) => (
              <option key={strategy.id} value={strategy.id}>
                {strategy.name}（{summaryStrategyLabel(strategy)}）
              </option>
            ))}
          </select>
        </label>
        <div className="summary-confirm-grid">
          <label className="dialog-field">
            <span>低于字数跳过（0=不跳过）</span>
            <input className="dialog-input" type="number" min="0" value={draft.skipBelowChars} onBlur={commitNumbers} onChange={(event) => updateNumber('skipBelowChars', event.target.value)} />
          </label>
          <label className="dialog-field">
            <span>不得少于（0=无下限）</span>
            <input className="dialog-input" type="number" min="0" value={draft.minWords} onBlur={commitNumbers} onChange={(event) => updateNumber('minWords', event.target.value)} />
          </label>
          <label className="dialog-field">
            <span>不得多于（0=无上限）</span>
            <input className="dialog-input" type="number" min="0" value={draft.maxWords} onBlur={commitNumbers} onChange={(event) => updateNumber('maxWords', event.target.value)} />
          </label>
          <label className="dialog-field">
            <span>相对比例 %（0=自由）</span>
            <input className="dialog-input" type="number" min="0" max="90" step="0.1" value={draft.ratioPercent} onBlur={commitNumbers} onChange={(event) => updateNumber('ratioPercent', event.target.value)} />
          </label>
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>取消</button>
          <button type="submit">应用本次配置</button>
        </div>
      </form>
    </div>
  );
}
