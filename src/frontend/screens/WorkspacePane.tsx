// 编辑器中栏（frontend-refactor.md §6 阶段 3）：WorkspaceHeader + 五视图（tree/ide/rich/
// entity/search）+ 空态。useEntityTrace 与 C2D 命令分发随视图迁入（deps 全部来自
// context / commands，无外部消费者）。undo/redo 可用性经 editorStore selector 订阅。

import { useCallback, useMemo } from 'react';

import { buildNodeSentenceLabelMap } from '../../core/source-ranges.js';
import {
  buildParagraphLabelMap,
  docDisplayTitle
} from '../lib/doc-utils.js';
import { debugPerfBegin, debugPerfEnd } from '../lib/debug-log.js';
import { ViewAlignedEmptyState } from '../components/common.jsx';
import { C2DMapView } from '../components/MindMapView';
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

export function WorkspacePane() {
  const { busy, notice, activeTab, setNotice } = useAppUIContext();
  const { docState, treeView, entityTrace, selection, layout, editorStore, summary, search, startup, dialogs, misc } = useAppState();
  const { editor, treeView: treeViewCommands, axiom, document: documentCommands } = useCommands();
  const { currentDoc, selectedLibraryEntry, sourceWindowLoading, loadSourceWindow } = docState;
  const {
    depthLimit, axiomsCollapsed, collapsed, expanded,
    actualMaxDepth, depthOptions,
    c2dDepthControlSeq, c2dDepthControlAction,
    setVisibleDepth, collapseVisibleDepthOne, syncC2dVisibleDepth
  } = treeView;
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
  const sentenceLabelByNodeId = useMemo(() => {
    if (!((activeSourceSpans?.length ?? 0) > 0)) return new Map();
    // debug 模式下测全树 sentence label 聚合耗时——这个会在 sourceSpans 变化（如翻窗口）时重跑
    const perfToken = debugPerfBegin('buildNodeSentenceLabelMap');
    const map = buildNodeSentenceLabelMap(currentDoc?.tree ?? null, activeSourceSpans as Parameters<typeof buildNodeSentenceLabelMap>[1]) as Map<string, string>;
    debugPerfEnd('buildNodeSentenceLabelMap', perfToken, { spans: activeSourceSpans!.length, nodes: map.size });
    return map;
  }, [currentDoc?.tree, currentDoc?.sourceSpans, currentDoc?.sourceWindow?.sourceSpans]);
  const paragraphLabelByNodeId = useMemo(() => {
    // debug 模式下测段落 label 聚合耗时
    const perfToken = debugPerfBegin('buildParagraphLabelMap');
    const map = buildParagraphLabelMap(currentDoc?.tree) as Map<string, string>;
    debugPerfEnd('buildParagraphLabelMap', perfToken, { nodes: map?.size ?? 0 });
    return map;
  }, [currentDoc?.tree]);

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
        activeTab={activeTab as Parameters<typeof WorkspaceHeader>[0]['activeTab']}
        setActiveTab={misc.changeActiveTab}
        undoEdit={editor.undoEdit}
        redoEdit={editor.redoEdit}
        undoDisabled={undoDepth === 0 || busy}
        redoDisabled={redoDepth === 0 || busy}
        treeEditMode={misc.treeEditMode}
        toggleTreeEditMode={editor.toggleTreeEditMode}
        hasTree={Boolean(currentDoc?.tree && !currentDoc?.virtual)}
        busy={busy}
        recomputeCurrentTreeView={() => setVisibleDepth(depthLimit, { clearAll: false })}
        setVisibleDepth={setVisibleDepth}
        collapseVisibleDepthOne={collapseVisibleDepthOne}
        visibleDepthLimit={depthLimit}
        visibleDepthOptions={depthOptions}
        actualMaxDepth={actualMaxDepth}
        summaryNotesVisible={summary.summaryNotesVisible}
        onToggleSummaryNotes={summary.toggleSummaryNotesVisible}
        onGenerateSummary={summary.generateSummary as Parameters<typeof WorkspaceHeader>[0]['onGenerateSummary']}
        onRunSummaryGeneration={(req, strat) => { void summary.runSummaryGeneration(req as Parameters<typeof summary.runSummaryGeneration>[0], strat as Parameters<typeof summary.runSummaryGeneration>[1]); }}
        diffBranches={diffBranchOptions as Parameters<typeof WorkspaceHeader>[0]['diffBranches']}
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
                docId={currentDoc.doc?.id as Parameters<typeof C2DMapView>[0]['docId']}
                rootNode={currentDoc.tree as Parameters<typeof C2DMapView>[0]['rootNode']}
                expanded={treeView.c2dExpanded}
                onExpandedChange={treeView.setC2dExpanded}
                selectedNodeId={selectedNodeId as Parameters<typeof C2DMapView>[0]['selectedNodeId']}
                setSelectedNodeId={setSelectedNodeId}
                setMultiSelectedIds={setMultiSelectedNodeIds}
                onRenderReady={(info: unknown) => startup.handleMindMapRenderReady(info)}
                onNotice={setNotice}
                locateRequest={locateRequest}
                axioms={currentDoc.axioms}
                axiomsCollapsed={axiomsCollapsed}
                onToggleAxiomsCollapsed={axiom.toggleAxiomsCollapsed}
                showNotes={viewShowNotes}
                paragraphLabelByNodeId={paragraphLabelByNodeId}
                visibleDepthLimit={depthLimit}
                depthControlSeq={c2dDepthControlSeq}
                depthControlAction={c2dDepthControlAction}
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
                tree={currentDoc.tree}
                selectedNodeId={selectedNodeId}
                setSelectedNodeId={setSelectedNodeId}
                collapsed={collapsed}
                expanded={expanded}
                toggleCollapsed={treeViewCommands.toggleCollapsed}
                depthLimit={depthLimit}
                sentenceLabelByNodeId={sentenceLabelByNodeId}
                axioms={currentDoc.axioms as Parameters<typeof IdeView>[0]['axioms']}
                showTitles={viewShowTitles}
                showNotes={viewShowNotes}
                showAxioms={viewShowAxioms}
                locateRequest={locateRequest}
              />
            </div>
            <div style={{ display: activeTab === 'rich' ? 'contents' : 'none' }}>
              <RichTextView
                currentDoc={currentDoc as Parameters<typeof RichTextView>[0]['currentDoc']}
                docId={currentDoc.doc?.id}
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
                loadSourceWindow={loadSourceWindow as Parameters<typeof RichTextView>[0]['loadSourceWindow']}
                sourceWindowLoading={sourceWindowLoading}
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
                results={search.results as Parameters<typeof SearchView>[0]['results']}
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
            selectedLibraryEntry={selectedLibraryEntry as Parameters<typeof ViewAlignedEmptyState>[0]['selectedLibraryEntry']}
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
