import { ArrowUp, Bot, Check, ChevronDown, ChevronRight, Trash2, X
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  AGENT_REASONING_OPTIONS, agentContextUsageView, agentDiffTraceTarget, agentModeLabel, agentReasoningLabel, agentReasoningShortLabel,
  agentSessionTime, agentSessionTitle, agentToolArgsSummary, agentToolNameText, agentToolStatusText, buildAgentModelOptions, clipText, compactAgentModelLabel,
  defaultAgentModelKey, diffFields, diffTitle, formatAgentElapsed
} from '../lib/agent-utils.mjs';
import { LocateNodeButton } from './common.jsx';



export function AgentPanel({
  agentSettings,
  messages,
  diffs,
  docs = [],
  sessions = [],
  activeSessionId = null,
  busy,
  contextUsage,
  onRun,
  onCancel,
  onApply,
  onReject,
  onApplyAll,
  onRejectAll,
  onLoadSession,
  onDeleteSession,
  onNewSession,
  onTraceDiff
}) {
  const [mode, setMode] = useState('qa');
  const [input, setInput] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [modelKey, setModelKey] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('auto');
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [agentMenuView, setAgentMenuView] = useState('main');
  const chatScrollRef = useRef(null);
  const stickToChatBottomRef = useRef(true);
  const sessionMenuRef = useRef(null);
  const modeMenuRef = useRef(null);
  const agentMenuRef = useRef(null);
  const pendingCount = diffs.length;
  const activeSession = sessions.find((session) => Number(session.id) === Number(activeSessionId)) || null;
  const modelOptions = useMemo(() => buildAgentModelOptions(agentSettings), [agentSettings]);
  const selectedModel = modelOptions.find((option) => option.key === modelKey) || modelOptions[0] || null;
  const supportedReasoningEfforts = useMemo(() => new Set(selectedModel?.reasoningEfforts || []), [selectedModel]);
  const contextView = agentContextUsageView(contextUsage);
  const modelFullLabel = selectedModel?.label || selectedModel?.model || '未配置';
  const modelShortLabel = selectedModel ? compactAgentModelLabel(modelFullLabel) : '配置';
  const reasoningLabel = agentReasoningLabel(reasoningEffort);
  const reasoningShortLabel = agentReasoningShortLabel(reasoningEffort);

  useEffect(() => {
    const scroll = chatScrollRef.current;
    if (scroll && stickToChatBottomRef.current) scroll.scrollTop = scroll.scrollHeight;
  }, [messages, pendingCount, busy]);

  useEffect(() => {
    if (pendingCount > 0) setExpanded(true);
  }, [pendingCount]);

  useEffect(() => {
    const nextKey = defaultAgentModelKey(agentSettings, modelOptions);
    setModelKey((current) => (modelOptions.some((option) => option.key === current) ? current : nextKey));
  }, [agentSettings, modelOptions]);

  useEffect(() => {
    if (reasoningEffort !== 'auto' && !supportedReasoningEfforts.has(reasoningEffort)) {
      setReasoningEffort('auto');
    }
  }, [reasoningEffort, supportedReasoningEfforts]);

  useEffect(() => {
    if (!agentMenuOpen) return undefined;
    const closeMenu = (event) => {
      if (!agentMenuRef.current?.contains(event.target)) setAgentMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeMenu);
    return () => document.removeEventListener('pointerdown', closeMenu);
  }, [agentMenuOpen]);

  useEffect(() => {
    if (!sessionMenuOpen) return undefined;
    const closeMenu = (event) => {
      if (!sessionMenuRef.current?.contains(event.target)) setSessionMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeMenu);
    return () => document.removeEventListener('pointerdown', closeMenu);
  }, [sessionMenuOpen]);

  useEffect(() => {
    if (!modeMenuOpen) return undefined;
    const closeMenu = (event) => {
      if (!modeMenuRef.current?.contains(event.target)) setModeMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeMenu);
    return () => document.removeEventListener('pointerdown', closeMenu);
  }, [modeMenuOpen]);

  const submit = () => {
    const prompt = input.trim();
    if (!prompt || busy) return;
    stickToChatBottomRef.current = true;
    setInput('');
    onRun?.({ mode, prompt, modelOption: selectedModel, reasoningEffort });
  };

  const reviewPanel = pendingCount > 0 ? (
    <div className="agent-review-box agent-review-dock">
      <div className="agent-review-head">
        <strong>{pendingCount} 个待审变更</strong>
        <div>
          <button type="button" onClick={() => setExpanded((value) => !value)}>{expanded ? '收起' : '审核'}</button>
          <button type="button" onClick={onRejectAll}>全部拒绝</button>
          <button type="button" onClick={onApplyAll}><Check size={13} /> 全部接受</button>
        </div>
      </div>
      {expanded && (
        <div className="agent-diff-list">
          {diffs.map((diff) => {
            const trace = agentDiffTraceTarget(diff, docs);
            return (
              <div key={diff.id} className="agent-diff-card">
                <header>
                  <div className="agent-diff-title">
                    <strong>{diffTitle(diff)}</strong>
                    <span>{diff.summary}</span>
                    <div className="agent-diff-addresses">
                      <span>文档 <code>{trace.docLabel || '未知文档'}</code></span>
                      <span>文内 <code>{trace.address || '未定位'}</code></span>
                    </div>
                  </div>
                  <LocateNodeButton
                    title="追踪待审节点"
                    label="追踪"
                    className="agent-diff-trace"
                    disabled={!trace.docId || !trace.address}
                    onClick={() => onTraceDiff?.(diff)}
                  />
                </header>
                {diffFields(diff).map((field) => (
                  <div key={field.key} className="agent-field-diff">
                    <span>{field.label}</span>
                    <div>
                      <p className="before">{clipText(field.before, 180) || '空'}</p>
                      <p className="after">{clipText(field.after, 180) || '空'}</p>
                    </div>
                  </div>
                ))}
                <footer>
                  <button type="button" onClick={() => onReject?.(diff.id)}>拒绝</button>
                  <button type="button" onClick={() => onApply?.(diff.id)}><Check size={13} /> 接受</button>
                </footer>
              </div>
            );
          })}
        </div>
      )}
    </div>
  ) : null;

  return (
    <section className="agent-panel">
      <header className="agent-chat-header">
        <span className="agent-title"><Bot size={15} /> 智能体</span>
        <div className="agent-session-anchor" ref={sessionMenuRef}>
          <button
            type="button"
            className="agent-session-button"
            title="Agent 会话"
            onClick={() => setSessionMenuOpen((open) => !open)}
          >
            <span>{activeSession ? agentSessionTitle(activeSession) : '会话'}</span>
            <ChevronDown size={12} />
          </button>
          {sessionMenuOpen && (
            <div className="agent-session-menu">
              <div className="agent-session-head">
                <span>会话</span>
                <button
                  type="button"
                  onClick={() => {
                    onNewSession?.();
                    setSessionMenuOpen(false);
                  }}
                >
                  新建
                </button>
              </div>
              <div className="agent-session-list">
                {sessions.length > 0 ? sessions.map((session) => (
                  <div
                    key={session.id}
                    className={`agent-session-item ${Number(session.id) === Number(activeSessionId) ? 'active' : ''}`}
                  >
                    <button
                      type="button"
                      className="agent-session-load"
                      onClick={() => {
                        onLoadSession?.(session.id);
                        setSessionMenuOpen(false);
                      }}
                    >
                      <span>{agentSessionTitle(session)}</span>
                      <em>{agentSessionTime(session)}{session.pending_diff_count ? ` · ${session.pending_diff_count} 待审` : ''}</em>
                    </button>
                    <button
                      type="button"
                      className="agent-session-delete"
                      title="删除会话"
                      onClick={(event) => {
                        event.stopPropagation();
                        onDeleteSession?.(session.id);
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )) : (
                  <p className="agent-session-empty">暂无保存会话</p>
                )}
              </div>
            </div>
          )}
        </div>
      </header>

      <div className="agent-chat-shell">
        <div
          ref={chatScrollRef}
          className={`agent-chat-scroll${messages.length === 0 && pendingCount === 0 && !busy ? ' empty' : ''}`}
          onWheel={(event) => {
            if (event.deltaY < 0) stickToChatBottomRef.current = false;
          }}
          onScroll={(event) => {
            const scroll = event.currentTarget;
            stickToChatBottomRef.current = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 4;
          }}
        >
          {messages.length > 0 ? (
            <div className="agent-message-list">
              {messages.map((message) => {
                const role = message.role === 'user' ? 'user' : 'assistant';
                const text = role === 'user' ? message.content : message.answer;
                const meta = `${message.status || '智能体'}${message.elapsedMs ? ` · ${formatAgentElapsed(message.elapsedMs)}` : ''}`;
                if (role === 'user') {
                  return (
                    <div key={message.id} className="agent-message-row user">
                      <div className="agent-message-bubble user">
                        <p className="agent-message-content">{text}</p>
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={message.id} className="agent-message-row assistant">
                    <div className={`agent-answer${message.error ? ' error' : ''}`}>
                      <span className="agent-message-meta">{meta}</span>
                      {Array.isArray(message.toolEvents) && message.toolEvents.length > 0 && (
                        <div className="agent-tool-list">
                          {message.toolEvents.map((tool) => {
                            const hasDisplayPreview = Object.prototype.hasOwnProperty.call(tool, 'displayPreview');
                            const resultText = hasDisplayPreview ? tool.displayPreview : tool.resultPreview;
                            const status = tool.status === 'done' || tool.status === 'error' ? tool.status : 'running';
                            const argsSummary = agentToolArgsSummary(tool);
                            return (
                              <details key={tool.id} className={`agent-tool-row ${status}`}>
                                <summary>
                                  <span className="agent-tool-status-dot" aria-hidden="true" />
                                  <span className="agent-tool-name">{agentToolNameText(tool.name)}</span>
                                  {argsSummary && <span className="agent-tool-args">({argsSummary})</span>}
                                  <em className="agent-tool-state">{agentToolStatusText(status)}</em>
                                </summary>
                                <div className="agent-tool-body">
                                  {tool.argsPreview && (
                                    <>
                                      <span className="agent-tool-label">参数</span>
                                      <pre>{tool.argsPreview}</pre>
                                    </>
                                  )}
                                  {resultText && (
                                    <>
                                      <span className="agent-tool-label">返回</span>
                                      <pre>{resultText}</pre>
                                    </>
                                  )}
                                  {tool.error && (
                                    <>
                                      <span className="agent-tool-label">错误</span>
                                      <pre>{tool.error}</pre>
                                    </>
                                  )}
                                </div>
                              </details>
                            );
                          })}
                        </div>
                      )}
                      <p className="agent-message-content">
                        {text || message.status || '正在处理...'}
                        {message.streaming && <span className="agent-stream-cursor" />}
                      </p>
                      {role === 'assistant' && message.diffCount > 0 && (
                        <span className="agent-message-note">{message.diffCount} 个待审变更</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="agent-empty-chat">
              <Bot size={18} />
              <p>{mode === 'full' ? '完全权限可读写工作区文件，并直接改写当前文档数据。' : mode === 'edit' ? '协作模式会生成待审变更，批准后合入当前编辑分支。' : '可以询问当前文档，也可以切到协作生成待审变更。'}</p>
            </div>
          )}
        </div>

        {reviewPanel}

        <div className="agent-composer">
          <textarea
            value={input}
            disabled={busy}
            placeholder={mode === 'full' ? '完全权限处理当前文档' : mode === 'edit' ? '协作编辑当前文档' : '询问当前文档'}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent?.isComposing) return;
              if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <div className="agent-control-row">
            <div className="agent-mode-anchor" ref={modeMenuRef}>
              <button
                type="button"
                className="agent-mode-pill"
                title="编辑权限"
                disabled={busy}
                onClick={() => setModeMenuOpen((open) => !open)}
              >
                <span className="agent-pill-label">{agentModeLabel(mode)}</span>
                <ChevronDown size={12} />
              </button>
              {modeMenuOpen && (
                <div className="agent-mode-menu">
                  <button
                    type="button"
                    className={`agent-menu-item ${mode === 'qa' ? 'selected' : ''}`}
                    onClick={() => {
                      setMode('qa');
                      setModeMenuOpen(false);
                    }}
                  >
                    <span>问答</span>
                    {mode === 'qa' && <Check size={14} />}
                  </button>
                  <button
                    type="button"
                    className={`agent-menu-item ${mode === 'edit' ? 'selected' : ''}`}
                    onClick={() => {
                      setMode('edit');
                      setModeMenuOpen(false);
                    }}
                  >
                    <span>协作</span>
                    {mode === 'edit' && <Check size={14} />}
                  </button>
                  <button
                    type="button"
                    className={`agent-menu-item ${mode === 'full' ? 'selected' : ''}`}
                    onClick={() => {
                      setMode('full');
                      setModeMenuOpen(false);
                    }}
                  >
                    <span>完全权限</span>
                    {mode === 'full' && <Check size={14} />}
                  </button>
                </div>
              )}
            </div>
            <div className="agent-run-controls">
              <div
                className={`agent-context-dot ${contextView.level}`}
                title={contextView.title}
                style={{ '--agent-context-ratio': `${Math.round(contextView.ratio * 360)}deg` }}
              >
                <span />
              </div>
              <div className="agent-menu-anchor" ref={agentMenuRef}>
                <button
                  type="button"
                  className="agent-model-depth-pill"
                  title={`${selectedModel?.title || '切换模型'} / 思考深度：${reasoningLabel}`}
                  disabled={busy}
                  onClick={() => {
                    setAgentMenuOpen((open) => !open);
                    setAgentMenuView('main');
                  }}
                >
                  <span className="agent-pill-label agent-model-full">{modelFullLabel}</span>
                  <span className="agent-pill-label agent-model-short">{modelShortLabel}</span>
                  <span className="agent-pill-label agent-depth-full">{reasoningLabel}</span>
                  <span className="agent-pill-label agent-depth-short">{reasoningShortLabel}</span>
                  <ChevronDown size={12} className="agent-pill-chevron" />
                </button>
                {agentMenuOpen && (
                  <div className="agent-model-menu">
                    <div className="agent-menu-section">
                      {AGENT_REASONING_OPTIONS.map((option) => {
                        const enabled = option.value === 'auto' || supportedReasoningEfforts.has(option.value);
                        return (
                          <button
                            key={option.value}
                            type="button"
                            className={`agent-menu-item ${reasoningEffort === option.value ? 'selected' : ''}`}
                            disabled={!enabled}
                            title={enabled ? '' : '当前 API 未声明支持该推理强度'}
                            onClick={() => {
                              if (!enabled) return;
                              setReasoningEffort(option.value);
                              setAgentMenuOpen(false);
                            }}
                          >
                            <span>{option.label}</span>
                            {reasoningEffort === option.value && <Check size={14} />}
                          </button>
                        );
                      })}
                    </div>
                    {modelOptions.length > 0 && (
                      <>
                        <div className="agent-menu-separator" />
                        <button
                          type="button"
                          className={`agent-menu-item ${agentMenuView === 'models' ? 'selected' : ''}`}
                          onClick={() => setAgentMenuView((view) => (view === 'models' ? 'main' : 'models'))}
                        >
                          <span>{modelFullLabel}</span>
                          {agentMenuView === 'models' ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                        {agentMenuView === 'models' && (
                          <div className="agent-menu-section agent-menu-scroll agent-menu-subsection">
                            {modelOptions.map((option) => (
                              <button
                                key={option.key}
                                type="button"
                                className={`agent-menu-item ${selectedModel?.key === option.key ? 'selected' : ''}`}
                                onClick={() => {
                                  setModelKey(option.key);
                                  setAgentMenuOpen(false);
                                }}
                              >
                                <span>{option.label}</span>
                                {selectedModel?.key === option.key && <Check size={14} />}
                              </button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
              {busy ? (
                <button type="button" className="agent-send-button cancel" title="取消当前 Agent 请求" onClick={onCancel}>
                  <X size={17} strokeWidth={2.4} />
                </button>
              ) : (
                <button type="button" className="agent-send-button" disabled={!input.trim() || modelOptions.length === 0} onClick={submit}>
                  <ArrowUp size={17} strokeWidth={2.4} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
