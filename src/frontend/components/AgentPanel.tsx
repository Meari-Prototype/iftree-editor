import { ArrowUp, Bot, Brain, Check, ChevronDown, ChevronRight, Trash2, X
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { RichMarkdown } from './RichMarkdown';

import {
  AGENT_REASONING_OPTIONS, agentBranchDocLabel, agentBranchEntries, agentBranchOwnerLabel, agentContextUsageView, agentModeLabel, agentReasoningLabel, agentReasoningShortLabel,
  agentSessionTime, agentSessionTitle, agentToolArgsSummary, agentToolNameText, agentToolStatusText, buildAgentModelOptions, compactAgentModelLabel,
  defaultAgentModelKey, formatAgentElapsed,
  type AgentBranch, type AgentMessageLike, type AgentModelOption,
  type AgentSegment, type AgentSession, type AgentSettingsLike,
  type AgentToolEvent, type AgentUsage
} from '../lib/agent-utils.js';

// AgentPanel 是 Agent 子面板：消费 agent-utils 已 export 的真类型（messages/diffs/sessions/usage 等），
// 内部 3 个子组件 + groupSegments + 主组件 props 都按真类型收紧；docs 字段沿用 agentBranchDocLabel 的最小形参形态。

type AgentDocOption = { id?: unknown; title?: string };
type AgentToolByIdMap = Map<string, AgentToolEvent>;
type AgentMode = 'qa' | 'edit' | 'full';
type AgentMenuView = 'main' | 'models';
type ReasoningEffort = string;

// 渲染前把连续的 tool 段聚合成组：text/reasoning 段原样保留，连续 tool 段合成一个 tool-group。
interface AgentToolGroupSegment {
  kind: 'tool-group';
  tools: string[];
}
type AgentGroupedSegment =
  | Extract<AgentSegment, { kind: 'text' }>
  | Extract<AgentSegment, { kind: 'reasoning' }>
  | AgentToolGroupSegment;

interface AgentToolRowProps {
  tool: AgentToolEvent;
}

interface AgentToolGroupProps {
  toolIds: string[];
  toolById: AgentToolByIdMap;
}

interface AgentReasoningProps {
  text: string;
  live?: boolean;
}

export interface AgentRunRequest {
  mode: AgentMode;
  prompt: string;
  modelOption: AgentModelOption | null;
  reasoningEffort: ReasoningEffort;
}

export interface AgentPanelProps {
  agentSettings?: AgentSettingsLike | null;
  messages?: AgentMessageLike[];
  diffs?: AgentBranch[];
  docs?: AgentDocOption[];
  sessions?: AgentSession[];
  activeSessionId?: number | string | null;
  busy?: boolean;
  contextUsage?: AgentUsage | null;
  onRun?: (payload: AgentRunRequest) => void;
  onCancel?: () => void;
  onApply?: (branchId: unknown) => void;
  onReject?: (branchId: unknown) => void;
  onApplyAll?: () => void;
  onRejectAll?: () => void;
  onLoadSession?: (sessionId: unknown) => void;
  onDeleteSession?: (sessionId: unknown) => void;
  onNewSession?: () => void;
  onTraceDiff?: (branch: AgentBranch) => void;
}

// 单个工具调用卡片：segments 交错渲染与旧会话两段式回退共用一处。默认折叠、可展开看参数 / 返回 / 错误。
function AgentToolRow({ tool }: AgentToolRowProps) {
  const hasDisplayPreview = Object.prototype.hasOwnProperty.call(tool, 'displayPreview');
  const resultText = hasDisplayPreview ? tool.displayPreview : tool.resultPreview;
  const status = tool.status === 'done' || tool.status === 'error' ? tool.status : 'running';
  const argsSummary = agentToolArgsSummary(tool);
  return (
    <details className={`agent-tool-row ${status}`}>
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
}

// 连续工具聚合成组（CC 式"已使用 N 个工具"）：单个直接一行,多个折叠成组、展开看各工具（组 → 工具 → 详情三层）。
function AgentToolGroup({ toolIds, toolById }: AgentToolGroupProps) {
  const tools = toolIds
    .map((id) => toolById.get(id))
    .filter((tool): tool is AgentToolEvent => Boolean(tool));
  if (tools.length === 0) return null;
  if (tools.length === 1) return <AgentToolRow tool={tools[0]} />;
  const running = tools.some((tool) => tool.status !== 'done' && tool.status !== 'error');
  return (
    <details className="agent-tool-group">
      <summary>
        <span className={`agent-tool-status-dot ${running ? 'running' : 'done'}`} aria-hidden="true" />
        <span className="agent-tool-name">已使用 {tools.length} 个工具</span>
        <em className="agent-tool-state">{running ? '运行中' : '完成'}</em>
      </summary>
      <div className="agent-tool-group-body">
        {tools.map((tool) => <AgentToolRow key={tool.id} tool={tool} />)}
      </div>
    </details>
  );
}

// 思考链：默认折叠成一行,展开看全文；流式途中默认展开看实时思考。
function AgentReasoning({ text, live }: AgentReasoningProps) {
  return (
    <details className="agent-reasoning" open={live || undefined}>
      <summary>
        <Brain size={12} />
        <span className="agent-reasoning-label">思考</span>
        {live && <span className="agent-stream-cursor" />}
      </summary>
      <div className="agent-reasoning-body">{text}</div>
    </details>
  );
}

// 渲染前把连续的 tool 段聚合成组,text / reasoning 段原样保留时间线顺序。
function groupSegments(segments: AgentSegment[]): AgentGroupedSegment[] {
  const groups: AgentGroupedSegment[] = [];
  for (const segment of segments) {
    if (segment.kind === 'tool') {
      const last = groups[groups.length - 1];
      if (last && last.kind === 'tool-group') last.tools.push(segment.toolId);
      else groups.push({ kind: 'tool-group', tools: [segment.toolId] });
    } else {
      groups.push(segment);
    }
  }
  return groups;
}

export function AgentPanel({
  agentSettings,
  messages = [],
  diffs = [],
  docs = [],
  sessions = [],
  activeSessionId = null,
  busy = false,
  contextUsage = null,
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
}: AgentPanelProps) {
  const [mode, setMode] = useState<AgentMode>('qa');
  const [input, setInput] = useState<string>('');
  const [expanded, setExpanded] = useState<boolean>(false);
  const [modelKey, setModelKey] = useState<string>('');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('auto');
  const [sessionMenuOpen, setSessionMenuOpen] = useState<boolean>(false);
  const [modeMenuOpen, setModeMenuOpen] = useState<boolean>(false);
  const [agentMenuOpen, setAgentMenuOpen] = useState<boolean>(false);
  const [agentMenuView, setAgentMenuView] = useState<AgentMenuView>('main');
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const stickToChatBottomRef = useRef<boolean>(true);
  const sessionMenuRef = useRef<HTMLDivElement | null>(null);
  const modeMenuRef = useRef<HTMLDivElement | null>(null);
  const agentMenuRef = useRef<HTMLDivElement | null>(null);
  const pendingCount = diffs.length;
  const activeSession = sessions.find((session) => Number(session.id) === Number(activeSessionId)) || null;
  const modelOptions = useMemo(() => buildAgentModelOptions(agentSettings ?? {}), [agentSettings]);
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
    const nextKey = defaultAgentModelKey(agentSettings ?? {}, modelOptions);
    setModelKey((current) => (modelOptions.some((option) => option.key === current) ? current : nextKey));
  }, [agentSettings, modelOptions]);

  useEffect(() => {
    if (reasoningEffort !== 'auto' && !supportedReasoningEfforts.has(reasoningEffort)) {
      setReasoningEffort('auto');
    }
  }, [reasoningEffort, supportedReasoningEfforts]);

  useEffect(() => {
    if (!agentMenuOpen) return undefined;
    const closeMenu = (event: PointerEvent) => {
      if (!agentMenuRef.current?.contains(event.target as Node | null)) setAgentMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeMenu);
    return () => document.removeEventListener('pointerdown', closeMenu);
  }, [agentMenuOpen]);

  useEffect(() => {
    if (!sessionMenuOpen) return undefined;
    const closeMenu = (event: PointerEvent) => {
      if (!sessionMenuRef.current?.contains(event.target as Node | null)) setSessionMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeMenu);
    return () => document.removeEventListener('pointerdown', closeMenu);
  }, [sessionMenuOpen]);

  useEffect(() => {
    if (!modeMenuOpen) return undefined;
    const closeMenu = (event: PointerEvent) => {
      if (!modeMenuRef.current?.contains(event.target as Node | null)) setModeMenuOpen(false);
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
          {diffs.map((branch) => {
            const entries = agentBranchEntries(branch);
            return (
              <div key={String(branch.id ?? '')} className="agent-diff-card">
                <header>
                  <div className="agent-diff-title">
                    <strong>{agentBranchDocLabel(branch, docs)}</strong>
                    <span>{entries.length} 处待审改动 · {agentBranchOwnerLabel(branch, sessions)}</span>
                  </div>
                </header>
                {entries.map((entry) => (
                  <div key={entry.key} className="agent-field-diff">
                    <span>{entry.label}</span>
                    <div><code>{entry.address || '—'}</code></div>
                  </div>
                ))}
                <footer>
                  <button type="button" onClick={() => onTraceDiff?.(branch)}>看 diff</button>
                  <button type="button" onClick={() => onReject?.(branch.id)}>拒绝整批</button>
                  <button type="button" onClick={() => onApply?.(branch.id)}><Check size={13} /> 接受整批</button>
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
                // text 是纯文本投影：user 消息正文，或 assistant 没有 segments 时的回退（旧会话）。
                // 正常 assistant 走下面的 segments 渲染——segments 才是展示主真相，answer 只兜底 + 供历史回传。
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
                const toolById: AgentToolByIdMap = new Map(
                  (message.toolEvents || []).map((toolEvent): [string, AgentToolEvent] => [String(toolEvent.id ?? ''), toolEvent])
                );
                const segments = Array.isArray(message.segments) ? message.segments : [];
                const lastSegmentIndex = segments.length - 1;
                const streamingTail = message.streaming && segments[lastSegmentIndex]?.kind === 'tool';
                return (
                  <div key={message.id} className="agent-message-row assistant">
                    <div className={`agent-answer${message.error ? ' error' : ''}`}>
                      <span className="agent-message-meta">{meta}</span>
                      {segments.length > 0 ? (
                        <div className="agent-segments">
                          {groupSegments(segments).map((group, index, groups) => {
                            const isLastGroup = index === groups.length - 1;
                            if (group.kind === 'tool-group') {
                              return <AgentToolGroup key={`group-${index}`} toolIds={group.tools} toolById={toolById} />;
                            }
                            if (group.kind === 'reasoning') {
                              return <AgentReasoning key={`reason-${index}`} text={group.text} live={message.streaming && isLastGroup} />;
                            }
                            if (message.streaming && isLastGroup) {
                              return (
                                <p key={`text-${index}`} className="agent-message-content">
                                  {group.text}
                                  <span className="agent-stream-cursor" />
                                </p>
                              );
                            }
                            return <RichMarkdown key={`text-${index}`} className="agent-message-rich" markdown={group.text} />;
                          })}
                          {streamingTail && (
                            <p className="agent-message-content">
                              {message.status || '正在处理...'}
                              <span className="agent-stream-cursor" />
                            </p>
                          )}
                        </div>
                      ) : (
                        <>
                          {message.toolEvents && message.toolEvents.length > 0 && (
                            <div className="agent-tool-list">
                              {message.toolEvents.map((tool) => <AgentToolRow key={tool.id} tool={tool} />)}
                            </div>
                          )}
                          {!message.streaming && text ? (
                            <RichMarkdown className="agent-message-rich" markdown={text} />
                          ) : (
                            <p className="agent-message-content">
                              {text || message.status || '正在处理...'}
                              {message.streaming && <span className="agent-stream-cursor" />}
                            </p>
                          )}
                        </>
                      )}
                      {role === 'assistant' && (message.diffCount ?? 0) > 0 && (
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
