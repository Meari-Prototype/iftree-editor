// 编辑器左栏（frontend-refactor.md §6 阶段 3）：brand + DocBrowser + 分栏拖柄 + OutlinePanel。
// docBySourcePath 投影与 createLibraryActions 装配随 DocBrowser 迁入（deps 全部来自
// context / commands / repository 单例，不再回流装配根）。

import { useMemo } from 'react';
import { Settings } from 'lucide-react';

import { DocBrowser } from '../components/DocBrowser.jsx';
import { OutlinePanel } from '../components/OutlinePanel.jsx';
import { createLibraryActions } from '../features/library/library-actions.js';
import { documentRepository } from '../data/repositories.js';
import { docSourcePath, normalizeFsPath } from '../lib/doc-utils.js';
import { useAppUIContext } from '../hooks/useAppUI.js';
import { useAppState } from '../app-context.js';
import { useCommands } from '../commands/commands-context.js';

export function LeftSidebar() {
  const { busy, setBusy, setNotice } = useAppUIContext();
  const { docState, treeView, selection, layout, misc } = useAppState();
  const { document: documentCommands, editor, treeView: treeViewCommands } = useCommands();
  const {
    docs, libraryTree, libraryCutPath, currentDoc,
    setDocs, setDocFolders, setLibraryTree, setLibraryCutPath, setSelectedLibraryEntry
  } = docState;
  const { leftWidth, leftCollapsed, docPanelHeight, outlineCollapsedDown, leftSidebarRef, docPanelRef, startDocOutlineResize } = layout;

  const docBySourcePath = useMemo(() => {
    const byPath = new Map();
    for (const doc of docs) {
      const sourcePath = docSourcePath(doc);
      if (sourcePath) byPath.set(normalizeFsPath(sourcePath), doc);
    }
    return byPath;
  }, [docs]);

  // createLibraryActions 还返回 createDocFolder / renameDocFolder / deleteDocFolder /
  // moveDocToFolder，这里不取：DocBrowser 的 doc 文件夹渲染是死代码、已删，前端暂无入口。
  // 能力本身保留在 library-actions（及其下的 repository），要接回 UI 时直接解构即可。
  const {
    moveLibraryItem,
    cutLibraryItem,
    pasteLibraryItem,
    deleteLibraryImport,
    selectLibraryFile
  } = createLibraryActions({
    busy,
    currentDoc,
    docBySourcePath,
    libraryCutPath,
    documentRepository,
    refreshDocs: documentCommands.refreshDocs,
    openDoc: documentCommands.openDoc,
    confirmLeaveEditMode: () => editor.confirmLeaveEditMode(),
    showLibraryFileOnly: documentCommands.showLibraryFileOnly,
    setBusy,
    setNotice,
    setDocFolders,
    setDocs,
    setLibraryTree,
    setLibraryCutPath,
    setSelectedLibraryEntry
  });

  const outlineSplitHint = outlineCollapsedDown
    ? '点按展开目录，拖动调整文件和目录占比'
    : '拖动调整文件和目录占比，点按向下收起目录';

  return (
    <aside
      ref={leftSidebarRef}
      className={`sidebar sidebar-left ${leftCollapsed ? 'collapsed' : ''}`}
      style={{ width: leftWidth }}
    >
      <div className="brand">
        <button type="button" className="brand-mark brand-mark-button" title="打开设置" onClick={misc.openSettings}>
          <Settings size={20} />
        </button>
        <div>
          <h1>条件树编辑器</h1>
          <p>折叠即文档，展开即结构</p>
        </div>
      </div>

      <DocBrowser
        busy={busy}
        libraryTree={libraryTree}
        docBySourcePath={docBySourcePath}
        currentDocId={misc.currentVisualDocId as Parameters<typeof DocBrowser>[0]['currentDocId']}
        libraryCutPath={libraryCutPath}
        docPanelRef={docPanelRef}
        docPanelHeight={docPanelHeight}
        onRefreshLibrary={docState.refreshLibrary}
        onOpenDoc={documentCommands.openDoc}
        libraryNavigationOpen={currentDoc?.virtualType === 'libraryNavigation'}
        onOpenLibraryNavigation={documentCommands.openLibraryNavigation}
        onSelectLibraryFile={selectLibraryFile}
        onMoveLibraryItem={moveLibraryItem}
        onCutLibraryItem={cutLibraryItem}
        onPasteLibraryItem={pasteLibraryItem}
        onDeleteLibraryImport={deleteLibraryImport}
      />

      <button
        type="button"
        className={`left-panel-resizer${outlineCollapsedDown ? ' is-collapsed' : ''}`}
        title={outlineSplitHint}
        aria-label={outlineSplitHint}
        onPointerDown={(event) => startDocOutlineResize(event.nativeEvent)}
      />

      <OutlinePanel
        tree={currentDoc?.tree as Parameters<typeof OutlinePanel>[0]['tree']}
        selectedNodeId={selection.selectedNodeId}
        collapsedOutlineNodeIds={treeView.collapsedOutlineNodeIds}
        onToggle={treeViewCommands.toggleOutlineNode}
        onSelect={(id) => selection.setSelectedNodeId?.(id)}
      />
    </aside>
  );
}
