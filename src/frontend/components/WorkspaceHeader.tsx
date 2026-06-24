// @ts-nocheck
import {
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Database,
  GitCompareArrows,
  ListTree,
  Lock,
  MoreHorizontal,
  Redo2,
  RotateCcw,
  Undo2,
  Unlock
} from 'lucide-react';
import * as Tabs from '@radix-ui/react-tabs';
import { useState } from 'react';
import { createPortal } from 'react-dom';

import { DepthCollapseOneIcon, DepthExpandOneIcon, IconButton } from './common.jsx';
import { SummaryConfirmDialog } from './SummaryConfirmDialog.jsx';
import { useFloatingMenu } from '../hooks/useFloatingMenu.js';

const VIEW_MENU_WIDTH = 190;
const VIEW_MENU_HEIGHT = 156;
const DIFF_MENU_WIDTH = 176;
const DIFF_MENU_HEIGHT = 92;
const SUMMARY_MENU_WIDTH = 150;
const SUMMARY_MENU_HEIGHT = 132;
const MENU_OFFSET = 6;

// 三套浮层菜单 id→{className,width,height} 映射。一次只开一个，单一 useFloatingMenu 实例互斥。
const MENU_SPECS = {
  summary: { className: 'summary-menu', width: SUMMARY_MENU_WIDTH, height: SUMMARY_MENU_HEIGHT },
  view: { className: 'view-options-menu', width: VIEW_MENU_WIDTH, height: VIEW_MENU_HEIGHT },
  diff: { className: 'diff-branch-menu', width: DIFF_MENU_WIDTH, height: DIFF_MENU_HEIGHT }
};

export function WorkspaceHeader({
  title,
  subtitle,
  activeTab,
  setActiveTab,
  undoEdit,
  redoEdit,
  undoDisabled,
  redoDisabled,
  treeEditMode,
  toggleTreeEditMode,
  hasTree,
  busy,
  recomputeCurrentTreeView,
  setVisibleDepth,
  collapseVisibleDepthOne,
  visibleDepthLimit,
  visibleDepthOptions,
  actualMaxDepth,
  summaryNotesVisible = true,
  onToggleSummaryNotes,
  onGenerateSummary,
  onRunSummaryGeneration,
  diffBranches = [],
  onOpenDiff,
  onOpenEntityMaintenance,
  children
}) {
  const [summaryConfirm, setSummaryConfirm] = useState(null);
  const [viewShowLeftInfo, setViewShowLeftInfo] = useState(true);
  const [viewShowTitles, setViewShowTitles] = useState(true);
  const [viewShowAxioms, setViewShowAxioms] = useState(true);

  const normalizedDiffBranches = Array.isArray(diffBranches) ? diffBranches : [];
  const enabledDiffBranches = normalizedDiffBranches.filter((branch) => (
    !branch?.disabled && Number(branch?.activeEntryCount) > 0
  ));
  const diffButtonDisabled = !hasTree || enabledDiffBranches.length === 0;

  // summary / view / diff 三套浮层菜单合一：单一 id-keyed 互斥。
  const menu = useFloatingMenu({
    specs: (id) => MENU_SPECS[id] || null,
    offset: MENU_OFFSET
  });

  function openDiffBranch(branch) {
    menu.close();
    onOpenDiff?.(branch);
  }

  function chooseSummaryMode(mode) {
    menu.close();
    onGenerateSummary?.(mode).then((request) => {
      if (request) setSummaryConfirm(request);
    });
  }

  function renderSummaryMenu() {
    if (menu.openId !== 'summary' || !menu.position) return null;
    return createPortal(
      <div
        className="summary-menu"
        style={{
          left: `${menu.position.left}px`,
          top: `${menu.position.top}px`,
          width: `${menu.position.width}px`
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" onClick={() => chooseSummaryMode('selected')}>当前节点</button>
        <button type="button" onClick={() => chooseSummaryMode('subtree')}>节点及子树</button>
        <button type="button" onClick={() => chooseSummaryMode('depth')}>当前层级</button>
        <button type="button" onClick={() => chooseSummaryMode('article')}>全文</button>
      </div>,
      document.body
    );
  }

  function renderViewMenu() {
    if (menu.openId !== 'view' || !menu.position || !['ide', 'rich'].includes(activeTab)) return null;
    return createPortal(
      <div
        className="view-options-menu"
        style={{
          left: `${menu.position.left}px`,
          top: `${menu.position.top}px`,
          width: `${menu.position.width}px`
        }}
        onClick={(event) => event.stopPropagation()}
      >
        {activeTab === 'rich' ? (
          <button
            type="button"
            className={viewShowLeftInfo ? 'active' : ''}
            onClick={() => setViewShowLeftInfo((value) => !value)}
          >
            左侧节点信息栏
          </button>
        ) : null}
        <button
          type="button"
          className={viewShowTitles ? 'active' : ''}
          onClick={() => setViewShowTitles((value) => !value)}
        >
          节点标题
        </button>
        <button
          type="button"
          className={summaryNotesVisible ? 'active' : ''}
          onClick={() => onToggleSummaryNotes?.()}
        >
          摘要备注
        </button>
        <button
          type="button"
          className={viewShowAxioms ? 'active' : ''}
          onClick={() => setViewShowAxioms((value) => !value)}
        >
          事实前提
        </button>
      </div>,
      document.body
    );
  }

  function renderDiffMenu() {
    if (menu.openId !== 'diff' || !menu.position || enabledDiffBranches.length <= 1) return null;
    return createPortal(
      <div
        className="diff-branch-menu"
        style={{
          left: `${menu.position.left}px`,
          top: `${menu.position.top}px`,
          width: `${menu.position.width}px`
        }}
        onClick={(event) => event.stopPropagation()}
      >
        {enabledDiffBranches.map((branch) => (
          <button
            key={branch.id || branch.owner}
            type="button"
            onClick={() => openDiffBranch(branch)}
          >
            <span>{branch.label || branch.owner || 'diff'}</span>
            <small>{branch.activeEntryCount} diff</small>
          </button>
        ))}
      </div>,
      document.body
    );
  }

  function toggleDiffMenu(event) {
    event.stopPropagation();
    if (diffButtonDisabled) return;
    if (enabledDiffBranches.length === 1) {
      openDiffBranch(enabledDiffBranches[0]);
      return;
    }
    menu.toggle('diff', event);
  }

  function toggleSummaryMenu(event) {
    menu.toggle('summary', event);
  }

  function toggleViewMenu(event) {
    menu.toggle('view', event);
  }

  const renderedChildren = typeof children === 'function'
    ? children({
      viewShowLeftInfo,
      viewShowTitles,
      viewShowNotes: summaryNotesVisible,
      viewShowAxioms
    })
    : children;
  const showSecondaryTools = ['tree', 'ide', 'rich'].includes(activeTab);

  return (
    <>
      <header className="workspace-header">
        <div className="workspace-title">
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
        <div className="workspace-tools">
          <div className="workspace-primary-tools">
            <div className="history-controls" aria-label="编辑历史">
              <IconButton title="撤销 Ctrl+Z" onClick={undoEdit} disabled={undoDisabled}><Undo2 size={16} /></IconButton>
              <IconButton title="重做 Ctrl+Y / Ctrl+Shift+Z" onClick={redoEdit} disabled={redoDisabled}><Redo2 size={16} /></IconButton>
            </div>
            {activeTab === 'entity' ? (
              <button
                type="button"
                className="tree-lock-button entity-maintenance-button"
                title="实体库维护"
                aria-label="实体库维护"
                disabled={!hasTree}
                onClick={onOpenEntityMaintenance}
              >
                <Database size={16} />
                <span>库</span>
              </button>
            ) : (
              <button
                type="button"
                className={`tree-lock-button ${treeEditMode ? 'editing' : ''}`}
                title={treeEditMode ? '退出编辑模式并保存' : '进入编辑模式'}
                aria-pressed={treeEditMode}
                disabled={!hasTree}
                onClick={toggleTreeEditMode}
              >
                {treeEditMode ? <Unlock size={16} /> : <Lock size={16} />}
                <span>{treeEditMode ? '编' : '锁'}</span>
              </button>
            )}
            <div className="diff-branch-control">
              <button
                type="button"
                className="tree-lock-button diff-branch-button"
                title="打开编辑分支对比"
                aria-label="打开编辑分支对比"
                disabled={diffButtonDisabled}
                onClick={toggleDiffMenu}
              >
                <GitCompareArrows size={16} />
                <span>diff</span>
                {enabledDiffBranches.length > 1 ? <ChevronDown size={13} /> : null}
              </button>
              {renderDiffMenu()}
            </div>
            <Tabs.Root value={activeTab} onValueChange={setActiveTab}>
              <Tabs.List className="tab-switcher" aria-label="视图">
                <Tabs.Trigger value="tree" title="树视图" aria-label="树视图" className={activeTab === 'tree' ? 'active' : ''}>树</Tabs.Trigger>
                <Tabs.Trigger value="ide" title="IDE视图" aria-label="IDE视图" className={activeTab === 'ide' ? 'active' : ''}>码</Tabs.Trigger>
                <Tabs.Trigger value="rich" title="富文本" aria-label="富文本" className={activeTab === 'rich' ? 'active' : ''}>富</Tabs.Trigger>
                <Tabs.Trigger value="entity" title="实体追踪" aria-label="实体追踪" className={activeTab === 'entity' ? 'active' : ''}>实</Tabs.Trigger>
                <Tabs.Trigger value="search" title="语义搜索" aria-label="语义搜索" className={activeTab === 'search' ? 'active' : ''}>似</Tabs.Trigger>
              </Tabs.List>
            </Tabs.Root>
          </div>
          <div
            className={`workspace-secondary-tools ${showSecondaryTools ? '' : 'is-placeholder'}`}
            aria-hidden={showSecondaryTools ? undefined : true}
          >
            {showSecondaryTools && (
              <div className="depth-controls">
                <div className="summary-control">
                  <button
                    type="button"
                    className={`summary-button summary-toggle ${summaryNotesVisible ? 'active' : ''}`}
                    title={summaryNotesVisible ? '隐藏摘要备注' : '显示摘要备注'}
                    aria-label={summaryNotesVisible ? '隐藏摘要备注' : '显示摘要备注'}
                    aria-pressed={summaryNotesVisible}
                    disabled={!hasTree || busy}
                    onClick={() => onToggleSummaryNotes?.()}
                  >
                    <span>摘</span>
                  </button>
                  <button
                    type="button"
                    className="summary-button summary-menu-button"
                    title="生成摘要"
                    aria-label="生成摘要"
                    disabled={!hasTree || busy}
                    onClick={toggleSummaryMenu}
                  >
                    <ChevronDown size={14} />
                  </button>
                  {renderSummaryMenu()}
                </div>
                {activeTab === 'tree' && (
                  <button
                    className="depth-icon-button"
                    title="重算树视图"
                    aria-label="重算树视图"
                    disabled={!hasTree || busy}
                    onClick={recomputeCurrentTreeView}
                  >
                    <RotateCcw size={16} />
                  </button>
                )}
                <button className="depth-icon-button" title="全部折叠" aria-label="全部折叠" onClick={() => setVisibleDepth(1, { clearAll: true, action: 'collapseAll' })}><ChevronsDownUp size={16} /></button>
                <button className="depth-icon-button depth-step-button" title="收缩一层" aria-label="收缩一层" disabled={visibleDepthLimit <= 1} onClick={collapseVisibleDepthOne}><DepthCollapseOneIcon size={16} /></button>
                <label title="深度" aria-label="深度">
                  <span><ListTree size={15} /></span>
                  <select
                    title="深度"
                    aria-label="深度"
                    value={visibleDepthLimit}
                    onChange={(event) => setVisibleDepth(event.target.value, { action: 'setDepth' })}
                  >
                    {visibleDepthOptions.map((depth) => (
                      <option key={depth} value={depth}>{depth}</option>
                    ))}
                  </select>
                </label>
                <button className="depth-icon-button depth-step-button" title="展开一层" aria-label="展开一层" onClick={() => setVisibleDepth(visibleDepthLimit + 1, { clearAll: true, action: 'expandOne' })}><DepthExpandOneIcon size={16} /></button>
                <button className="depth-icon-button" title="全部展开" aria-label="全部展开" onClick={() => setVisibleDepth(actualMaxDepth, { clearAll: true, action: 'expandAll' })}><ChevronsUpDown size={16} /></button>
                {['ide', 'rich'].includes(activeTab) && (
                  <div className="view-options-control">
                    <button
                      className="depth-icon-button"
                      title="显示选项"
                      aria-label="显示选项"
                      onClick={toggleViewMenu}
                    >
                      <MoreHorizontal size={16} />
                    </button>
                    {renderViewMenu()}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </header>
      {renderedChildren}
      {summaryConfirm && (
        <SummaryConfirmDialog
          request={summaryConfirm}
          onCancel={() => setSummaryConfirm(null)}
          onConfirm={(strategy) => {
            const request = summaryConfirm;
            setSummaryConfirm(null);
            onRunSummaryGeneration?.(request, strategy);
          }}
        />
      )}
    </>
  );
}
