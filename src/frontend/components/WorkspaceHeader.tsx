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
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { DepthCollapseOneIcon, DepthExpandOneIcon, IconButton } from './common.jsx';
import { SummaryConfirmDialog } from './SummaryConfirmDialog.jsx';

const SUMMARY_MENU_WIDTH = 150;
const SUMMARY_MENU_HEIGHT = 132;
const VIEW_MENU_WIDTH = 190;
const VIEW_MENU_HEIGHT = 156;
const DIFF_MENU_WIDTH = 176;
const DIFF_MENU_HEIGHT = 92;

function menuPositionFromButton(button, width, height) {
  const rect = button.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || width;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || height;
  const left = Math.max(8, Math.min(rect.right - width, viewportWidth - width - 8));
  const below = rect.bottom + 6;
  const above = rect.top - height - 6;
  const top = below + height <= viewportHeight - 8
    ? below
    : Math.max(8, above);
  return { left, top, width };
}

function summaryMenuPositionFromButton(button) {
  return menuPositionFromButton(button, SUMMARY_MENU_WIDTH, SUMMARY_MENU_HEIGHT);
}

function viewMenuPositionFromButton(button) {
  return menuPositionFromButton(button, VIEW_MENU_WIDTH, VIEW_MENU_HEIGHT);
}

function diffMenuPositionFromButton(button) {
  return menuPositionFromButton(button, DIFF_MENU_WIDTH, DIFF_MENU_HEIGHT);
}

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
  const [summaryMenuOpen, setSummaryMenuOpen] = useState(false);
  const [summaryMenuPosition, setSummaryMenuPosition] = useState(null);
  const [summaryConfirm, setSummaryConfirm] = useState(null);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [viewMenuPosition, setViewMenuPosition] = useState(null);
  const [diffMenuOpen, setDiffMenuOpen] = useState(false);
  const [diffMenuPosition, setDiffMenuPosition] = useState(null);
  const [viewShowLeftInfo, setViewShowLeftInfo] = useState(true);
  const [viewShowTitles, setViewShowTitles] = useState(true);
  const [viewShowAxioms, setViewShowAxioms] = useState(true);
  const summaryControlRef = useRef(null);
  const viewOptionsButtonRef = useRef(null);
  const diffButtonRef = useRef(null);
  const normalizedDiffBranches = Array.isArray(diffBranches) ? diffBranches : [];
  const enabledDiffBranches = normalizedDiffBranches.filter((branch) => (
    !branch?.disabled && Number(branch?.activeEntryCount) > 0
  ));
  const diffButtonDisabled = !hasTree || enabledDiffBranches.length === 0;

  useEffect(() => {
    if (!summaryMenuOpen) return undefined;
    const close = () => {
      setSummaryMenuOpen(false);
      setSummaryMenuPosition(null);
    };
    const closeOnPointerDown = (event) => {
      if (summaryControlRef.current?.contains(event.target)) return;
      if (event.target?.closest?.('.summary-menu')) return;
      close();
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', closeOnPointerDown);
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown);
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', close);
    };
  }, [summaryMenuOpen]);

  useEffect(() => {
    if (!viewMenuOpen) return undefined;
    const close = () => {
      setViewMenuOpen(false);
      setViewMenuPosition(null);
    };
    const closeOnPointerDown = (event) => {
      if (viewOptionsButtonRef.current?.contains(event.target)) return;
      if (event.target?.closest?.('.view-options-menu')) return;
      close();
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', closeOnPointerDown);
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown);
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', close);
    };
  }, [viewMenuOpen]);

  useEffect(() => {
    if (!diffMenuOpen) return undefined;
    const close = () => {
      setDiffMenuOpen(false);
      setDiffMenuPosition(null);
    };
    const closeOnPointerDown = (event) => {
      if (diffButtonRef.current?.contains(event.target)) return;
      if (event.target?.closest?.('.diff-branch-menu')) return;
      close();
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', closeOnPointerDown);
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown);
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', close);
    };
  }, [diffMenuOpen]);

  function toggleSummaryMenu(event) {
    event.stopPropagation();
    if (summaryMenuOpen) {
      setSummaryMenuOpen(false);
      setSummaryMenuPosition(null);
      return;
    }
    setViewMenuOpen(false);
    setViewMenuPosition(null);
    setDiffMenuOpen(false);
    setDiffMenuPosition(null);
    setSummaryMenuPosition(summaryMenuPositionFromButton(event.currentTarget));
    setSummaryMenuOpen(true);
  }

  function toggleViewMenu(event) {
    event.stopPropagation();
    if (viewMenuOpen) {
      setViewMenuOpen(false);
      setViewMenuPosition(null);
      return;
    }
    setSummaryMenuOpen(false);
    setSummaryMenuPosition(null);
    setDiffMenuOpen(false);
    setDiffMenuPosition(null);
    setViewMenuPosition(viewMenuPositionFromButton(event.currentTarget));
    setViewMenuOpen(true);
  }

  function openDiffBranch(branch) {
    setDiffMenuOpen(false);
    setDiffMenuPosition(null);
    onOpenDiff?.(branch);
  }

  function toggleDiffMenu(event) {
    event.stopPropagation();
    if (diffButtonDisabled) return;
    if (enabledDiffBranches.length === 1) {
      openDiffBranch(enabledDiffBranches[0]);
      return;
    }
    if (diffMenuOpen) {
      setDiffMenuOpen(false);
      setDiffMenuPosition(null);
      return;
    }
    setSummaryMenuOpen(false);
    setSummaryMenuPosition(null);
    setViewMenuOpen(false);
    setViewMenuPosition(null);
    setDiffMenuPosition(diffMenuPositionFromButton(event.currentTarget));
    setDiffMenuOpen(true);
  }

  async function chooseSummaryMode(mode) {
    setSummaryMenuOpen(false);
    setSummaryMenuPosition(null);
    const request = await onGenerateSummary?.(mode);
    if (request) setSummaryConfirm(request);
  }

  function renderSummaryMenu() {
    if (!summaryMenuOpen || !summaryMenuPosition) return null;
    return createPortal(
      <div
        className="summary-menu"
        style={{
          left: `${summaryMenuPosition.left}px`,
          top: `${summaryMenuPosition.top}px`,
          width: `${summaryMenuPosition.width}px`
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
    if (!viewMenuOpen || !viewMenuPosition || !['ide', 'rich'].includes(activeTab)) return null;
    return createPortal(
      <div
        className="view-options-menu"
        style={{
          left: `${viewMenuPosition.left}px`,
          top: `${viewMenuPosition.top}px`,
          width: `${viewMenuPosition.width}px`
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
    if (!diffMenuOpen || !diffMenuPosition || enabledDiffBranches.length <= 1) return null;
    return createPortal(
      <div
        className="diff-branch-menu"
        style={{
          left: `${diffMenuPosition.left}px`,
          top: `${diffMenuPosition.top}px`,
          width: `${diffMenuPosition.width}px`
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
            <div className="diff-branch-control" ref={diffButtonRef}>
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
                <div className="summary-control" ref={summaryControlRef}>
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
                  <div className="view-options-control" ref={viewOptionsButtonRef}>
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
