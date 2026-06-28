import { ImagePlus, Plus, RotateCcw, Search as SearchIcon, Unlink } from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { plainNodeNote } from '../../core/node-notes.js';
import { clampVerticalSplitSize } from '../../core/sidebar-split.js';
import { NODE_TYPES } from '../../core/tree.js';
import {
  DEFAULT_AGENT_PANEL_BASIS,
  MAX_AGENT_PANEL_HEIGHT,
  MIN_AGENT_PANEL_HEIGHT,
  MIN_NODE_INFO_PANEL_HEIGHT,
  PANEL_SPLIT_RAIL_SIZE,
  TRUST_LEVELS,
  depthOf,
  isFactAxiomRef,
  nodeTypeLabel
} from '../lib/doc-utils.js';
import { startResizeRailGesture } from '../lib/mindmap-utils.js';
import { formatDate } from '../lib/ui-utils.js';
import { AgentPanel, type AgentPanelProps } from './AgentPanel.jsx';
import { IconButton, LocateNodeButton } from './common.jsx';

// Inspector 是右边栏：上半 AgentPanel（18 个 agent* props 直接转发，类型对齐 AgentPanelProps）、
// 下半 NodeInfo 面板（读 currentDoc 的 refs/axioms/tree/history 投影 + 编辑 selectedNode + 调 inspectorActions）。
// 本地接口字段全 optional——currentDoc / selectedNode 来自 store 投影，上游字段宽度未收紧前不假设必填。

export interface InspectorRefRow {
  id?: unknown;
  source_type?: string;
  source_id?: unknown;
  target_type?: string;
  target_id?: unknown;
  [extra: string]: unknown;
}

export interface InspectorAxiomRow {
  id?: unknown;
  label?: string;
  content?: string;
  status?: string;
  [extra: string]: unknown;
}

export interface InspectorHistoryRow {
  id?: unknown;
  saved_at?: unknown;
  summary?: string;
  [extra: string]: unknown;
}

export interface InspectorDocLike {
  doc?: { id?: unknown; [extra: string]: unknown } | null;
  refs?: InspectorRefRow[];
  axioms?: InspectorAxiomRow[];
  tree?: { text?: string; [extra: string]: unknown } | null;
  history?: InspectorHistoryRow[];
  [extra: string]: unknown;
}

export interface InspectorSelectedNode {
  id?: unknown;
  address?: string;
  nodeType?: string;
  trustLevel?: string | null;
  note?: string | null;
  [extra: string]: unknown;
}

export type InspectorActionName =
  | 'updateNode'
  | 'createImageAsset'
  | 'updateAxiom'
  | 'deleteRef'
  | 'restoreHistory';

export type InspectorActionHandler = (payload?: unknown) => Promise<unknown> | unknown;
export type InspectorActionsMap = Partial<Record<InspectorActionName, InspectorActionHandler>>;

export interface JumpAddressResult {
  ok: boolean;
  message?: string;
}

export interface InspectorProps {
  currentDoc?: InspectorDocLike | null;
  selectedNode?: InspectorSelectedNode | null;
  runWrite?: (fn: () => Promise<unknown> | unknown) => Promise<unknown> | unknown;
  selectNode?: (nodeId: unknown) => void;
  canEdit?: boolean;
  viewMode?: 'tree' | 'ide' | 'rich';
  collapsed?: boolean;
  sidebarWidth?: number | null;
  onLocateNode?: () => void;
  onJumpToAddress?: (address: string) => Promise<JumpAddressResult | null | undefined> | JumpAddressResult | null | undefined;
  // 18 个 agent* 字段对齐 AgentPanelProps（AgentPanel γ 第 4 步已收紧、Props export）：
  agentSettings?: AgentPanelProps['agentSettings'];
  agentMessages?: AgentPanelProps['messages'];
  agentDiffs?: AgentPanelProps['diffs'];
  agentDocs?: AgentPanelProps['docs'];
  agentSessions?: AgentPanelProps['sessions'];
  activeAgentSessionId?: AgentPanelProps['activeSessionId'];
  agentBusy?: AgentPanelProps['busy'];
  agentContextUsage?: AgentPanelProps['contextUsage'];
  onRunAgent?: AgentPanelProps['onRun'];
  onCancelAgent?: AgentPanelProps['onCancel'];
  onApplyAgentDiff?: AgentPanelProps['onApply'];
  onRejectAgentDiff?: AgentPanelProps['onReject'];
  onApplyAllAgentDiffs?: AgentPanelProps['onApplyAll'];
  onRejectAllAgentDiffs?: AgentPanelProps['onRejectAll'];
  onLoadAgentSession?: AgentPanelProps['onLoadSession'];
  onDeleteAgentSession?: AgentPanelProps['onDeleteSession'];
  onNewAgentSession?: AgentPanelProps['onNewSession'];
  onTraceAgentDiff?: AgentPanelProps['onTraceDiff'];
  onAddAxiomRef?: (nodeId: unknown) => void;
  inspectorActions?: InspectorActionsMap;
}

export function Inspector({
  currentDoc,
  selectedNode,
  runWrite,
  selectNode,
  canEdit,
  viewMode = 'tree',
  collapsed,
  sidebarWidth,
  onLocateNode,
  onJumpToAddress,
  agentSettings,
  agentMessages = [],
  agentDiffs = [],
  agentDocs = [],
  agentSessions = [],
  activeAgentSessionId = null,
  agentBusy = false,
  agentContextUsage,
  onRunAgent,
  onCancelAgent,
  onApplyAgentDiff,
  onRejectAgentDiff,
  onApplyAllAgentDiffs,
  onRejectAllAgentDiffs,
  onLoadAgentSession,
  onDeleteAgentSession,
  onNewAgentSession,
  onTraceAgentDiff,
  onAddAxiomRef,
  inspectorActions = {}
}: InspectorProps) {
  const sidebarStyle = sidebarWidth ? { width: sidebarWidth } : undefined;
  const [agentPanelHeight, setAgentPanelHeight] = useState<number | null>(null);
  const [nodeInfoCollapsedDown, setNodeInfoCollapsedDown] = useState<boolean>(false);
  const [addressJumpValue, setAddressJumpValue] = useState<string>(selectedNode?.address || '');
  const [addressJumpError, setAddressJumpError] = useState<string>('');
  const rightSidebarRef = useRef<HTMLElement | null>(null);
  const agentPanelRef = useRef<HTMLDivElement | null>(null);
  const agentPanelHeightBeforeCollapseRef = useRef<number | null>(null);

  useEffect(() => {
    setAddressJumpValue(selectedNode?.address || '');
  }, [selectedNode?.id, selectedNode?.address]);

  async function submitAddressJump() {
    const result = await onJumpToAddress?.(addressJumpValue);
    if (result && !result.ok) setAddressJumpError(result.message || '没有找到这个节点。');
  }

  function startAgentPanelResize(event: ReactPointerEvent<HTMLButtonElement>) {
    const sidebar = rightSidebarRef.current;
    const panel = agentPanelRef.current;
    if (!sidebar || !panel) return;

    const sidebarRect = sidebar.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const panelTop = panelRect.top - sidebarRect.top;
    const availableSize = sidebarRect.height - panelTop - PANEL_SPLIT_RAIL_SIZE;
    const startSize = panelRect.height;
    startResizeRailGesture(event.nativeEvent, {
      collapsed: nodeInfoCollapsedDown,
      onExpand: toggleNodeInfoCollapseDown,
      bodyClasses: ['is-resizing-vertical', 'is-resizing-right-split'],
      onDrag: (moveEvent, { startY }) => {
        setNodeInfoCollapsedDown(false);
        setAgentPanelHeight(Math.min(
          MAX_AGENT_PANEL_HEIGHT,
          clampVerticalSplitSize({
            startSize,
            startY,
            currentY: moveEvent.clientY,
            availableSize,
            minTop: MIN_AGENT_PANEL_HEIGHT,
            minBottom: MIN_NODE_INFO_PANEL_HEIGHT
          })
        ));
      },
      onClick: toggleNodeInfoCollapseDown
    });
  }

  function toggleNodeInfoCollapseDown() {
    const sidebar = rightSidebarRef.current;
    const panel = agentPanelRef.current;
    if (!sidebar || !panel) return;
    if (nodeInfoCollapsedDown) {
      setAgentPanelHeight(agentPanelHeightBeforeCollapseRef.current);
      setNodeInfoCollapsedDown(false);
      return;
    }
    const sidebarRect = sidebar.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const panelTop = panelRect.top - sidebarRect.top;
    const availableSize = sidebarRect.height - panelTop - PANEL_SPLIT_RAIL_SIZE;
    agentPanelHeightBeforeCollapseRef.current = agentPanelHeight;
    setAgentPanelHeight(Math.max(MIN_AGENT_PANEL_HEIGHT, availableSize));
    setNodeInfoCollapsedDown(true);
  }

  const nodeInfoSplitHint = nodeInfoCollapsedDown
    ? '点按展开节点信息，拖动调整 Agent 和节点信息占比'
    : '拖动调整 Agent 和节点信息占比，点按向下收起节点信息';

  if (!currentDoc || !selectedNode) {
    return (
      <aside ref={rightSidebarRef} className={`sidebar sidebar-right ${collapsed ? 'collapsed' : ''}`} style={sidebarStyle}>
        <div ref={agentPanelRef} className="agent-panel-frame" style={{ flexBasis: agentPanelHeight ?? DEFAULT_AGENT_PANEL_BASIS }}>
          <AgentPanel
            agentSettings={agentSettings}
            messages={agentMessages}
            diffs={agentDiffs}
            docs={agentDocs}
            sessions={agentSessions}
            activeSessionId={activeAgentSessionId}
            busy={agentBusy}
            contextUsage={agentContextUsage}
            onRun={onRunAgent}
            onCancel={onCancelAgent}
            onApply={onApplyAgentDiff}
            onReject={onRejectAgentDiff}
            onApplyAll={onApplyAllAgentDiffs}
            onRejectAll={onRejectAllAgentDiffs}
            onLoadSession={onLoadAgentSession}
            onDeleteSession={onDeleteAgentSession}
            onNewSession={onNewAgentSession}
            onTraceDiff={onTraceAgentDiff}
          />
        </div>
        <button
          type="button"
          className={`right-panel-resizer${nodeInfoCollapsedDown ? ' is-collapsed' : ''}`}
          title={nodeInfoSplitHint}
          aria-label={nodeInfoSplitHint}
          onPointerDown={startAgentPanelResize}
        />
        <div className="inspector-scroll">
          <div className="empty-state">没有选中节点</div>
        </div>
      </aside>
    );
  }

  function runInspectorAction(action: InspectorActionName, payload?: unknown): Promise<unknown> | unknown {
    const handler = inspectorActions?.[action];
    if (!handler) return null;
    return runWrite ? runWrite(() => handler(payload)) : handler(payload);
  }

  // 这两个 function declaration 会被 hoist 出 if(!currentDoc || !selectedNode) 守卫之外，
  // TS narrow 不传播到函数体——内部访问改 ?. 兜底（运行时不会真为 null，守卫之前不会被调）。
  async function updateSelected(patch: Record<string, unknown>) {
    if (!canEdit) return;
    await runInspectorAction('updateNode', {
      docId: currentDoc?.doc?.id,
      nodeId: selectedNode?.id,
      patch
    });
  }

  async function createImageAsset() {
    if (!canEdit) return;
    await runInspectorAction('createImageAsset', {
      docId: currentDoc?.doc?.id,
      nodeId: selectedNode?.id
    });
  }

  const selectedIsRoot = depthOf(selectedNode.address || '1') <= 1;
  const allRefs = currentDoc.refs || [];
  const allAxioms = currentDoc.axioms || [];
  const selectedFactRefs = allRefs.filter((ref) => (
    isFactAxiomRef(ref) && String(ref.target_id) === String(selectedNode.id)
  ));
  const selectedFactRefByAxiomId = new Map<string, InspectorRefRow>(
    selectedFactRefs.map((ref) => [String(ref.source_id), ref])
  );
  const visibleAxioms: InspectorAxiomRow[] = selectedIsRoot
    ? allAxioms
    : allAxioms.filter((axiom) => selectedFactRefByAxiomId.has(String(axiom.id)));

  const addressJumpDialog = addressJumpError ? createPortal(
    <div className="dialog-overlay" onClick={() => setAddressJumpError('')}>
      <div className="dialog-box node-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-header">节点地址不存在</div>
        <div className="dialog-meta">当前文档</div>
        <p className="dialog-message">{addressJumpError}</p>
        <div className="dialog-actions">
          <button type="button" onClick={() => setAddressJumpError('')}>确定</button>
        </div>
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <>
    <aside ref={rightSidebarRef} className={`sidebar sidebar-right ${collapsed ? 'collapsed' : ''}`} style={sidebarStyle}>
      <div ref={agentPanelRef} className="agent-panel-frame" style={{ flexBasis: agentPanelHeight ?? DEFAULT_AGENT_PANEL_BASIS }}>
        <AgentPanel
          agentSettings={agentSettings}
          messages={agentMessages}
          diffs={agentDiffs}
          docs={agentDocs}
          sessions={agentSessions}
          activeSessionId={activeAgentSessionId}
          busy={agentBusy}
          contextUsage={agentContextUsage}
          onRun={onRunAgent}
          onCancel={onCancelAgent}
          onApply={onApplyAgentDiff}
          onReject={onRejectAgentDiff}
          onApplyAll={onApplyAllAgentDiffs}
          onRejectAll={onRejectAllAgentDiffs}
          onLoadSession={onLoadAgentSession}
          onDeleteSession={onDeleteAgentSession}
          onNewSession={onNewAgentSession}
          onTraceDiff={onTraceAgentDiff}
        />
      </div>
      <button
        type="button"
        className={`right-panel-resizer${nodeInfoCollapsedDown ? ' is-collapsed' : ''}`}
        title={nodeInfoSplitHint}
        aria-label={nodeInfoSplitHint}
        onPointerDown={startAgentPanelResize}
      />

      <div className="inspector-scroll">
        <section className="panel inspector-panel">
        <header className="panel-header with-action">
          <span>选中节点</span>
          <LocateNodeButton title="定位当前节点" label="定位节点" className="panel-header-action" onClick={onLocateNode} />
        </header>
        <div className="field-grid">
          <label>
            地址
            <div className="address-jump-control">
              <input
                value={addressJumpValue}
                onChange={(event) => setAddressJumpValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    submitAddressJump();
                  }
                }}
              />
              <button
                type="button"
                className="address-jump-search"
                title="跳转节点"
                aria-label="跳转节点"
                onMouseDown={(event) => event.preventDefault()}
                onClick={submitAddressJump}
              >
                <SearchIcon size={13} />
              </button>
            </div>
          </label>
          <label>
            类型
            <select value={selectedNode.nodeType || 'TEXT'} disabled={!canEdit} onChange={(event) => updateSelected({ node_type: event.target.value })}>
              {NODE_TYPES.map((type) => <option key={type} value={type}>{nodeTypeLabel(type)}</option>)}
            </select>
          </label>
          <label>
            信任级别
            <select value={selectedNode.trustLevel || ''} disabled={!canEdit} onChange={(event) => updateSelected({ trust_level: event.target.value || null })}>
              {TRUST_LEVELS.map((value) => <option key={value} value={value}>{value || '未标注'}</option>)}
            </select>
          </label>
          <label className="field-wide">
            摘要备注
            <textarea
              key={`${String(selectedNode.id ?? '')}-${selectedNode.note || ''}`}
              defaultValue={plainNodeNote(selectedNode.note || '')}
              disabled={!canEdit}
              placeholder="添加摘要备注或生成摘要"
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (value !== plainNodeNote(selectedNode.note || '').trim()) {
                  updateSelected({ node_note: value });
                }
              }}
            />
          </label>
        </div>
        <div className="inspector-actions">
          <button onClick={createImageAsset} disabled={!canEdit}><ImagePlus size={15} /> 添加图片附件</button>
        </div>
      </section>

      <section className="panel root-panel">
        <header className="panel-header">需求总目标</header>
        <p>{currentDoc.tree?.text}</p>
      </section>

      <section className="panel">
        <header className="panel-header with-action">
          <span>事实前提</span>
          {!selectedIsRoot && (
            <IconButton
              title="添加事实前提引用"
              onClick={() => onAddAxiomRef?.(selectedNode.id)}
              disabled={!canEdit || allAxioms.length === 0}
            >
              <Plus size={15} />
            </IconButton>
          )}
        </header>
        <div className="meta-list">
          {visibleAxioms.map((axiom) => (
            <div
              key={String(axiom.id ?? '')}
              className={`meta-item axiom-meta-item${!selectedIsRoot && selectedFactRefByAxiomId.has(String(axiom.id)) ? ' has-unlink' : ''}`}
            >
              <strong>{axiom.label}</strong>
              <span>{axiom.content}</span>
              <select
                value={axiom.status}
                disabled={!canEdit}
                onChange={(event) => runInspectorAction('updateAxiom', {
                  docId: currentDoc.doc?.id,
                  axiomId: axiom.id,
                  patch: { status: event.target.value }
                })}
              >
                <option value="pending">待确认</option>
                <option value="confirmed">已确认</option>
              </select>
              {!selectedIsRoot && selectedFactRefByAxiomId.has(String(axiom.id)) && (
                <IconButton
                  title="移除事实前提引用"
                  disabled={!canEdit}
                  onClick={() => runInspectorAction('deleteRef', {
                    docId: currentDoc.doc?.id,
                    refId: selectedFactRefByAxiomId.get(String(axiom.id))?.id
                  })}
                >
                  <Unlink size={14} />
                </IconButton>
              )}
            </div>
          ))}
          {visibleAxioms.length === 0 && (
            <p className="muted">{allAxioms.length === 0 ? '暂无事实前提' : '暂无事实前提引用'}</p>
          )}
        </div>
      </section>

      <section className="panel">
        <header className="panel-header">变更历史</header>
        <div className="meta-list">
          {(currentDoc.history || []).map((entry) => (
            <div key={String(entry.id ?? '')} className="meta-item history-item">
              <strong>{formatDate(entry.saved_at)}</strong>
              <span>{entry.summary || '未命名版本'}</span>
              <IconButton
                title="回滚到此版本"
                disabled={!canEdit}
                onClick={() => runInspectorAction('restoreHistory', {
                  docId: currentDoc.doc?.id,
                  commitId: entry.id
                })}
              >
                <RotateCcw size={14} />
              </IconButton>
            </div>
          ))}
          {(currentDoc.history || []).length === 0 && <p className="muted">暂无保存版本</p>}
        </div>
      </section>
      </div>
    </aside>
    {addressJumpDialog}
    </>
  );
}
