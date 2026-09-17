// 编辑器中栏（frontend-refactor.md §6 阶段 3）：WorkspaceHeader + 五视图（tree/ide/rich/
// entity/search）+ 空态。useEntityTrace 与 C2D 命令分发随视图迁入（deps 全部来自
// context / commands，无外部消费者）。undo/redo 可用性经 editorStore selector 订阅。

import { useCallback, useMemo, useRef } from 'react';

import { buildNodeSentenceLabelMap } from '../../core/source-ranges.js';
import {
  buildParagraphLabelMap,
  docDisplayTitle
} from '../lib/doc-utils.js';
import { debugPerfBegin, debugPerfEnd } from '../lib/debug-log.js';
import { ViewAlignedEmptyState } from '../components/common.jsx';
import { C2DMapView } from '../components/c2d/C2DMapView';
import type { C2DMapHandle } from '../components/c2d/C2DMapView';
import { IdeView } from '../components/IdeView.jsx';
import { RichTextView } from '../components/RichTextView.jsx';
import { SearchView } from '../components/SearchView.jsx';
import { EntityTraceView } from '../components/EntityTraceView.jsx';
import { WorkspaceHeader } from '../components/WorkspaceHeader.jsx';
import {
  axiomRepository,
  nodeRepository
} from '../data/repositories.js';
import { useAppUIContext } from '../hooks/useAppUI.js';
import { useAppState } from '../app-context.js';
import { useCommands } from '../commands/commands-context.js';
import { useStoreSelector } from '../stores/use-store.js';

type C2DAxiomPatchIn = Record<string, unknown>;

function c2dAxiomPatch(patch: C2DAxiomPatchIn = {}): Record<string, unknown> {
  const nextPatch: Record<string, unknown> = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'text')) nextPatch.content = patch.text;
  if (Object.prototype.hasOwnProperty.call(patch, 'node_title')) nextPatch.node_title = patch.node_title;
  if (Object.prototype.hasOwnProperty.call(patch, 'node_note')) nextPatch.node_note = patch.node_note;
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) nextPatch.status = patch.status;
  return nextPatch;
}

// 视图隐藏时冻结其 tree 类大 props：display:none 不挡 React render/reconcile，三个吃 currentDoc.tree
// 的视图（C2D/Ide/RichText）在每次 project（含每个后台预取页）都会各自把 O(N) 派生重算一遍——
// 渲染成本 ×3。冻结后非活动视图 props 引用不变、useMemo/卡片 memo 全命中，重派生跳过；
// 组件保持挂载（滚动位置等 DOM 态不丢，区别于条件渲染卸载）；切回活动 tab 时解冻拿最新 tree。
// 驱逐保护集按 session.view 的纯函数计算（document-session.childrenVisibleSet），不依赖组件是否重渲。
function useFrozenWhileHidden<T>(hidden: boolean, value: T): T {
  const ref = useRef(value);
  if (!hidden) ref.current = value;
  return hidden ? ref.current : value;
}

export function WorkspacePane() {
  const { busy, notice, activeTab, setNotice } = useAppUIContext();
  const { docState, treeView, entityTrace, selection, layout, editorStore, summary, search, startup, dialogs, misc } = useAppState();
  const { editor, treeView: treeViewCommands, axiom, document: documentCommands } = useCommands();
  const { currentDoc, selectedLibraryEntry } = docState;
  const {
    depthLimit, axiomsCollapsed, collapsed, expanded,
    actualMaxDepth, depthOptions,
    setVisibleDepth, collapseVisibleDepthOne, syncC2dVisibleDepth
  } = treeView;
  // 深度控件 → session 持久化（useTreeViewState）+ C2D 地图命令（ref 直达，替代旧 seq 脉冲）。
  const c2dMapRef = useRef<C2DMapHandle | null>(null);
  const applyVisibleDepth = useCallback(async (value: number | string, options: { clearAll?: boolean; action?: string } = {}) => {
    const nextDepth = await setVisibleDepth(value, options);
    c2dMapRef.current?.applyDepthControl(options.action || 'setDepth', nextDepth);
  }, [setVisibleDepth]);
  const applyCollapseVisibleDepthOne = useCallback(async () => {
    const nextDepth = await collapseVisibleDepthOne();
    c2dMapRef.current?.applyDepthControl('collapseOne', nextDepth);
  }, [collapseVisibleDepthOne]);
  const { selectedNodeId, setSelectedNodeId, setMultiSelectedNodeIds, locateRequest } = selection;
  const { leftWidth, rightWidth, leftCollapsed, rightCollapsed } = layout;
  const undoDepth = useStoreSelector(editorStore, (state) => state.undoStack.length);
  const redoDepth = useStoreSelector(editorStore, (state) => state.redoStack.length);

  const {
    entityQuery, setEntityQuery, entityRows, selectedEntity, entityDetail,
    entityNodeQuery, entityNodeMatchMode, entityNodeResults, entityNodeGroups, entityNodePage,
    changeEntityNodeMatchMode, changeEntityNodeQuery,
    runEntitySearch, runEntityNodeSearch, selectEntityTraceEntity, useEntityTraceKeyword,
    pageEntityNodeSearch, dragEntityTraceEntity, dropEntityIntoNodeSearch, openEntityMaintenance
  } = entityTrace;

  const activeSourceSpans = currentDoc?.sourceWindow?.sourceSpans || currentDoc?.sourceSpans || null;
  // 非活动视图的 tree 类 props 冻结（见 useFrozenWhileHidden）：隐藏期间不追新 tree，派生不重算。
  const frozenC2dRootNode = useFrozenWhileHidden(activeTab !== 'tree', currentDoc?.tree);
  const frozenIdeTree = useFrozenWhileHidden(activeTab !== 'ide', currentDoc?.tree);
  const frozenRichDoc = useFrozenWhileHidden(activeTab !== 'rich', currentDoc);
  const sentenceLabelByNodeId = useMemo(() => {
    if (!((activeSourceSpans?.length ?? 0) > 0)) return new Map();
    // debug 模式下测全树 sentence label 聚合耗时——这个会在 sourceSpans 变化（如翻窗口）时重跑
    // 只喂 IdeView：基于冻结 tree 计算，ide 隐藏时不重算。
    const perfToken = debugPerfBegin('buildNodeSentenceLabelMap');
    const map = buildNodeSentenceLabelMap(frozenIdeTree ?? null, activeSourceSpans || []);
    debugPerfEnd('buildNodeSentenceLabelMap', perfToken, { spans: activeSourceSpans!.length, nodes: map.size });
    return map;
  }, [frozenIdeTree, currentDoc?.sourceSpans, currentDoc?.sourceWindow?.sourceSpans]);
  const paragraphLabelByNodeId = useMemo(() => {
    // debug 模式下测段落 label 聚合耗时。只喂 C2DMapView：基于冻结 tree 计算，tree tab 隐藏时不重算。
    const perfToken = debugPerfBegin('buildParagraphLabelMap');
    const map = buildParagraphLabelMap(frozenC2dRootNode);
    debugPerfEnd('buildParagraphLabelMap', perfToken, { nodes: map?.size ?? 0 });
    return map;
  }, [frozenC2dRootNode]);

  const diffBranchOptions = useMemo(() => {
    const branch = editor.activeEditBranch(currentDoc);
    if (!branch) return [];
    const activeEntryCount = editor.editBranchUndoEntries(branch).length;
    const owner = String(branch.owner || 'human');
    return [{
      id: branch.id,
      owner,
      label: owner.split('#')[0].split(':')[0] === 'llm' ? 'LLM 分支' : 'human 分支',
      activeEntryCount,
      disabled: activeEntryCount <= 0,
      branch
    }];
  }, [currentDoc?.editBranch]);

  const runC2DNodeCommand = useCallback((command: {
    type?: string;
    target?: { kind?: string; nodeId?: unknown; axiomId?: unknown; [k: string]: unknown };
    parentNodeId?: unknown;
    afterNodeId?: unknown;
    nodeId?: unknown;
    direction?: unknown;
    patch?: C2DAxiomPatchIn;
    [k: string]: unknown;
  } = {}) => {
    const docId = currentDoc?.doc?.id;
    if (!docId) return null;
    const target = command?.target || {};
    return editor.dispatchWrite(() => {
      switch (command?.type) {
        case 'addChild':
          return nodeRepository.insertNode({
            docId,
            parentId: command.parentNodeId,
            text: '',
            nodeType: 'TEXT'
          });
        case 'addSibling':
          return nodeRepository.insertNode({
            docId,
            parentId: command.parentNodeId,
            afterNodeId: command.afterNodeId,
            text: '',
            nodeType: 'TEXT'
          });
        case 'updateBlock':
          if (target.kind === 'axiom') {
            return axiomRepository.updateAxiom({
              docId,
              axiomId: target.axiomId,
              patch: c2dAxiomPatch(command.patch)
            });
          }
          return nodeRepository.updateNode({
            docId,
            nodeId: target.nodeId,
            patch: command.patch || {}
          });
        case 'reorderNode':
          return nodeRepository.moveNode({ docId, nodeId: command.nodeId, direction: command.direction });
        case 'promoteToParentSibling':
          return nodeRepository.promoteNode({ docId, nodeId: command.nodeId });
        case 'splitNode':
          return nodeRepository.splitNode({ docId, nodeId: command.nodeId });
        case 'deleteBlock':
          if (target.kind === 'axiom') return axiomRepository.deleteAxiom({ docId, axiomId: target.axiomId });
          return nodeRepository.deleteNode({ docId, nodeId: target.nodeId });
        case 'mergeIntoTarget':
          return nodeRepository.mergeNodeIntoTarget({ docId, nodeId: command.nodeId, targetNodeId: command.targetNodeId });
        case 'moveAfterSibling':
          return nodeRepository.moveNodeAfterSibling({ docId, nodeId: command.nodeId, targetNodeId: command.targetNodeId });
        case 'moveToParent':
          return nodeRepository.moveNodeToParent({ docId, nodeId: command.nodeId, newParentId: command.newParentId });
        default:
          setNotice('当前动作尚未接入。');
          return null;
      }
    });
  }, [currentDoc?.doc?.id, editor, setNotice]);

  const visibleNodeCount = Number(currentDoc?.doc?.node_count) > 0
    ? Number(currentDoc!.doc!.node_count)
    : Number(currentDoc?.nodes?.length || 0);
  const workspaceTitle = currentDoc ? docDisplayTitle(currentDoc.doc) : (selectedLibraryEntry?.name || '未打开文档');
  const workspaceSubtitle = currentDoc
    ? `${visibleNodeCount} 个节点`
    : selectedLibraryEntry
      ? '未导入原始文件，请先手动导入'
      : '选择 library 中的文件开始';

  return (
    <section
      className="workspace"
      style={{
        left: leftCollapsed ? 0 : leftWidth,
        right: rightCollapsed ? 0 : rightWidth
      }}
    >
      <WorkspaceHeader
        title={workspaceTitle}
        subtitle={workspaceSubtitle}
        activeTab={activeTab}
        setActiveTab={misc.changeActiveTab}
        undoEdit={editor.undoEdit}
        redoEdit={editor.redoEdit}
        undoDisabled={undoDepth === 0 || busy}
        redoDisabled={redoDepth === 0 || busy}
        treeEditMode={misc.treeEditMode}
        toggleTreeEditMode={editor.toggleTreeEditMode}
        hasTree={Boolean(currentDoc?.tree && !currentDoc?.virtual)}
        busy={busy}
        recomputeCurrentTreeView={() => applyVisibleDepth(depthLimit, { clearAll: false })}
        setVisibleDepth={applyVisibleDepth}
        collapseVisibleDepthOne={applyCollapseVisibleDepthOne}
        visibleDepthLimit={depthLimit}
        visibleDepthOptions={depthOptions}
        actualMaxDepth={actualMaxDepth}
        summaryNotesVisible={summary.summaryNotesVisible}
        onToggleSummaryNotes={summary.toggleSummaryNotesVisible}
        onGenerateSummary={summary.generateSummary}
        onRunSummaryGeneration={(request, strategy) => { void summary.runSummaryGeneration(request, strategy); }}
        diffBranches={diffBranchOptions}
        onOpenDiff={dialogs.openEditBranchDiff}
        onOpenEntityMaintenance={openEntityMaintenance}
      >
        {({ viewShowLeftInfo, viewShowTitles, viewShowNotes, viewShowAxioms }) => (
          <>

      {notice && (
        <div className="notice" onClick={() => setNotice('')}>
          {notice}
        </div>
      )}

      <div className="tree-surface" aria-busy={busy}>
        {currentDoc?.tree ? (
          <>
            <div style={{ display: activeTab === 'tree' ? 'contents' : 'none' }}>
              <C2DMapView
                ref={c2dMapRef}
                docId={currentDoc.doc?.id}
                rootNode={frozenC2dRootNode}
                expanded={treeView.c2dExpanded}
                onExpandedChange={treeView.setC2dExpanded}
                selectedNodeId={selectedNodeId}
                setSelectedNodeId={setSelectedNodeId}
                setMultiSelectedIds={setMultiSelectedNodeIds}
                onRenderReady={(info) => startup.handleMindMapRenderReady(info)}
                onNotice={setNotice}
                locateRequest={locateRequest}
                axioms={currentDoc.axioms}
                axiomsCollapsed={axiomsCollapsed}
                onToggleAxiomsCollapsed={axiom.toggleAxiomsCollapsed}
                showNotes={viewShowNotes}
                paragraphLabelByNodeId={paragraphLabelByNodeId}
                maxVisibleDepth={actualMaxDepth}
                onVisibleDepthChange={syncC2dVisibleDepth}
                treeEditMode={misc.treeEditMode}
                onNodeCommand={runC2DNodeCommand}
                onAddAxiom={axiom.addAxiom}
                onAddAxiomRef={axiom.requestAxiomRef}
              />
            </div>
            <div style={{ display: activeTab === 'ide' ? 'contents' : 'none' }}>
              <IdeView
                tree={frozenIdeTree}
                selectedNodeId={selectedNodeId}
                setSelectedNodeId={setSelectedNodeId}
                collapsed={collapsed}
                expanded={expanded}
                toggleCollapsed={treeViewCommands.toggleCollapsed}
                depthLimit={depthLimit}
                sentenceLabelByNodeId={sentenceLabelByNodeId}
                axioms={currentDoc.axioms}
                showTitles={viewShowTitles}
                showNotes={viewShowNotes}
                showAxioms={viewShowAxioms}
                locateRequest={locateRequest}
              />
            </div>
            <div style={{ display: activeTab === 'rich' ? 'contents' : 'none' }}>
              <RichTextView
                currentDoc={frozenRichDoc}
                docId={currentDoc.doc?.id == null ? null : String(currentDoc.doc.id)}
                selectedNodeId={selectedNodeId}
                setSelectedNodeId={setSelectedNodeId}
                depthLimit={depthLimit}
                collapsed={collapsed}
                expanded={expanded}
                toggleCollapsed={treeViewCommands.toggleCollapsed}
                showLeftInfo={viewShowLeftInfo}
                showTitles={viewShowTitles}
                showNotes={viewShowNotes}
                showAxioms={viewShowAxioms}
                onAddAxiom={axiom.addAxiomFromReadableView}
                locateRequest={locateRequest}
              />
            </div>
            <div style={{ display: activeTab === 'entity' ? 'contents' : 'none' }}>
              <EntityTraceView
                entityQuery={entityQuery}
                setEntityQuery={setEntityQuery}
                entityRows={entityRows}
                entityDetail={entityDetail}
                selectedEntity={selectedEntity}
                onSearchEntities={runEntitySearch}
                onSelectEntity={selectEntityTraceEntity}
                onUseEntityKeyword={useEntityTraceKeyword}
                onEntityDragStart={dragEntityTraceEntity}
                nodeQuery={entityNodeQuery}
                setNodeQuery={changeEntityNodeQuery}
                nodeMatchMode={entityNodeMatchMode}
                setNodeMatchMode={changeEntityNodeMatchMode}
                nodeRows={entityNodeResults}
                nodeGroups={entityNodeGroups}
                nodePage={entityNodePage}
                onSearchNodes={() => runEntityNodeSearch(entityNodeQuery, entityNodeMatchMode, { offset: 0 })}
                onPageNodes={pageEntityNodeSearch}
                onDropEntityTerm={dropEntityIntoNodeSearch}
                onSelectNode={treeViewCommands.selectNodeAndOpenTree}
                disabled={busy}
              />
            </div>
            <div style={{ display: activeTab === 'search' ? 'contents' : 'none' }}>
              <SearchView
                query={search.query}
                setQuery={search.setQuery}
                results={search.results}
                onSearch={search.runVectorSearch}
                selectNode={treeViewCommands.selectNodeAndOpenTree}
                placeholder={search.vectorModuleDisabled ? '向量模块已由用户禁用' : '输入要检索的语义内容'}
                disabled={search.vectorModuleDisabled}
                disabledMessage={String(search.vectorDisabledMessage ?? '')}
              />
            </div>
          </>
        ) : (
          <ViewAlignedEmptyState
            activeTab={activeTab}
            selectedLibraryEntry={selectedLibraryEntry}
            onImport={documentCommands.importFiles}
          />
        )}
      </div>
          </>
        )}
      </WorkspaceHeader>
    </section>
  );
}
