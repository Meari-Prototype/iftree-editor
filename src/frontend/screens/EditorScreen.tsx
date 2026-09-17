// 编辑器主屏（frontend-refactor.md §6 阶段 3）：标题栏 + 左右拖柄 + 左栏（LeftSidebar）
// + 中栏（WorkspacePane）+ 右栏（Inspector）。inspectorActions 的 repository 打包随
// Inspector 挂载点迁入。

import { useMemo } from 'react';
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen
} from 'lucide-react';

import { WindowTitlebar } from '../components/common.jsx';
import { Inspector } from '../components/Inspector.jsx';
import {
  assetRepository,
  axiomRepository,
  historyRepository,
  nodeRepository,
  refRepository
} from '../data/repositories.js';
import { useAppState } from '../app-context.js';
import { useCommands } from '../commands/commands-context.js';
import { LeftSidebar } from './LeftSidebar.jsx';
import { WorkspacePane } from './WorkspacePane.jsx';
import { DialogHost } from './DialogHost.jsx';

export function EditorScreen() {
  const { docState, selection, layout, agentChat, misc } = useAppState();
  const { editor, treeView: treeViewCommands, axiom, agent } = useCommands();
  const { currentDoc, docs } = docState;
  const {
    leftWidth, rightWidth, leftCollapsed, rightCollapsed, leftRailAnimate, rightRailAnimate,
    startSidebarResize
  } = layout;

  const inspectorActions = useMemo(() => ({
    updateNode: (payload: Parameters<typeof nodeRepository.updateNode>[0]) => nodeRepository.updateNode(payload),
    createImageAsset: (payload: Parameters<typeof assetRepository.createImageAsset>[0]) => assetRepository.createImageAsset(payload),
    deleteRef: (payload: Parameters<typeof refRepository.deleteRef>[0]) => refRepository.deleteRef(payload),
    updateAxiom: (payload: Parameters<typeof axiomRepository.updateAxiom>[0]) => axiomRepository.updateAxiom(payload),
    restoreHistory: (payload: Parameters<typeof historyRepository.restoreDocumentSnapshot>[0]) => historyRepository.restoreDocumentSnapshot(payload)
  }), []);

  const leftSidebarRailHint = leftCollapsed ? '点按展开左侧栏' : '拖动调整左侧栏宽度，点按收起';
  const rightSidebarRailHint = rightCollapsed ? '点按展开右侧栏' : '拖动调整右侧栏宽度，点按收起';

  return (
    <>
      <WindowTitlebar onClose={misc.handleCloseWindow} />
      <main className="app-shell">
        <button
          type="button"
          className={`sidebar-rail sidebar-rail-left${leftCollapsed ? ' is-collapsed' : ''}${leftRailAnimate ? ' rail-animating' : ''}`}
          style={{ left: leftCollapsed ? 0 : leftWidth - 6 }}
          title={leftSidebarRailHint}
          aria-label={leftSidebarRailHint}
          onPointerDown={(event) => startSidebarResize('left', event.nativeEvent)}
        >
          {leftCollapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
        </button>
        <button
          type="button"
          className={`sidebar-rail sidebar-rail-right${rightCollapsed ? ' is-collapsed' : ''}${rightRailAnimate ? ' rail-animating' : ''}`}
          style={{ right: rightCollapsed ? 0 : rightWidth - 6 }}
          title={rightSidebarRailHint}
          aria-label={rightSidebarRailHint}
          onPointerDown={(event) => startSidebarResize('right', event.nativeEvent)}
        >
          {rightCollapsed ? <PanelRightOpen size={12} /> : <PanelRightClose size={12} />}
        </button>

        <LeftSidebar />

        <WorkspacePane />

        <Inspector
          currentDoc={currentDoc}
          selectedNode={selection.selectedNode}
          selectedNodeId={selection.selectedNodeId}
          runWrite={editor.dispatchWrite}
          selectNode={treeViewCommands.selectNodeAndOpenTree}
          canEdit={misc.treeEditMode}
          collapsed={rightCollapsed}
          sidebarWidth={rightWidth}
          onLocateNode={treeViewCommands.locateSelectedNode}
          onJumpToAddress={treeViewCommands.jumpToCurrentDocAddress}
          agentSettings={agentChat.settings}
          agentMessages={agentChat.messages}
          agentDiffs={agentChat.diffs}
          agentDocs={docs}
          agentSessions={agentChat.sessions}
          activeAgentSessionId={agentChat.activeSessionId}
          agentBusy={agentChat.busy}
          agentContextUsage={agentChat.contextUsage}
          onRunAgent={agent.runAgentRequest}
          onCancelAgent={agent.cancelAgentRequest}
          onApplyAgentDiff={agent.applyAgentDiff}
          onRejectAgentDiff={agent.rejectAgentDiff}
          onApplyAllAgentDiffs={agent.applyAllAgentDiffs}
          onRejectAllAgentDiffs={agent.rejectAllAgentDiffs}
          onLoadAgentSession={agentChat.loadSession}
          onDeleteAgentSession={agentChat.deleteSession}
          onNewAgentSession={agentChat.newSession}
          onTraceAgentDiff={agent.traceAgentDiff}
          onAddAxiomRef={axiom.requestAxiomRef}
          inspectorActions={inspectorActions}
        />

        <DialogHost />
      </main>
    </>
  );
}
