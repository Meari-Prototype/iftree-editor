// 本组件只渲染 library（主文件夹）树。doc 文件夹 / doc 行那套渲染自仓库 baseline 起就没有
// 入口——`.doc-list` 一直只挂 renderRootDocFolder() → library 树，那批函数只在彼此间递归，
// 从未上屏，已于此次清理删除（含 doc 拖拽、文件夹增删改名、docs/docFolders props）。
// 后端与 repository 侧的 doc folder / moveDoc 能力仍在，未来要接回从那里重新接线即可。

import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  ListTree,
  MoreHorizontal,
  RotateCcw,
  Scissors,
  Search as SearchIcon,
  Trash2
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import type { DocListItem } from '../../backend/query-api.js';
import type { LibraryEntry } from '../../backend/library/library-fs.js';
import {
  DOC_MENU_WIDTH,
  filterLibraryTree,
  isSupportedLibraryImport,
  libraryCollapseKey,
  libraryFolderCollapseKeys,
  normalizeFsPath
} from '../lib/doc-utils.js';
import { IconButton } from './common.jsx';
import { useFloatingMenu } from '../hooks/useFloatingMenu.js';

// 折叠键：只有 library 文件夹一种来源，值恒为 libraryCollapseKey() 的 `library:<path>`。
// （原先还兼容 doc folder 的数值 id，那条路径已随 doc 树渲染一起删除。）
type CollapseKey = string;

// 拖拽中的浮层 ghost 状态。overFolderPath 为 undefined 表示指针下不是可投放的文件夹行，
// 为 '' 表示落在根（主文件夹）——两者必须分开，抹平就再也拖不回根目录了。
interface DocDragState {
  active: boolean;
  docId: string;
  title: string;
  x: number;
  y: number;
  overFolderPath?: string;
}

interface DocDragRefState {
  item?: LibraryEntry;
  active: boolean;
  startX: number;
  startY: number;
  x: number;
  y: number;
  overFolderPath?: string;
}

export interface DocBrowserProps {
  busy: boolean;
  libraryTree: LibraryEntry | null;
  docBySourcePath: Map<string, DocListItem>;
  currentDocId: string | null;
  libraryCutPath: string;
  docPanelRef: RefObject<HTMLElement | null>;
  docPanelHeight?: string | number | null;
  onRefreshLibrary?: () => void;
  onOpenDoc?: (docId: string) => void;
  libraryNavigationOpen?: boolean;
  onOpenLibraryNavigation?: () => void;
  onSelectLibraryFile?: (item: LibraryEntry) => void;
  onMoveLibraryItem?: (sourceRelativePath: string, targetFolderRelativePath: string | undefined) => void;
  onCutLibraryItem?: (item: LibraryEntry) => void;
  onPasteLibraryItem?: (targetFolderRelativePath: string) => void;
  onDeleteLibraryImport?: (item: LibraryEntry, importedDoc: DocListItem) => void;
}

export function DocBrowser({
  busy,
  libraryTree,
  docBySourcePath,
  currentDocId,
  libraryCutPath,
  docPanelRef,
  docPanelHeight,
  onRefreshLibrary,
  onOpenDoc,
  libraryNavigationOpen = false,
  onOpenLibraryNavigation,
  onSelectLibraryFile,
  onMoveLibraryItem,
  onCutLibraryItem,
  onPasteLibraryItem,
  onDeleteLibraryImport
}: DocBrowserProps) {
  const [collapsedDocFolders, setCollapsedDocFolders] = useState<Set<CollapseKey>>(() => new Set());
  const [docSearchOpen, setDocSearchOpen] = useState<boolean>(false);
  const [docSearchQuery, setDocSearchQuery] = useState<string>('');
  const [docDragState, setDocDragState] = useState<DocDragState | null>(null);
  const docSearchInputRef = useRef<HTMLInputElement | null>(null);
  const docDragRef = useRef<DocDragRefState | null>(null);
  const docDragTimerRef = useRef<number | null>(null);
  const suppressDocClickRef = useRef<boolean>(false);
  const libraryCollapseInitializedRef = useRef<boolean>(false);

  const visibleLibraryTree = useMemo(
    () => filterLibraryTree(libraryTree, docSearchQuery),
    [libraryTree, docSearchQuery]
  );

  useEffect(() => {
    if (!libraryTree || libraryCollapseInitializedRef.current) return;
    libraryCollapseInitializedRef.current = true;
    setCollapsedDocFolders((previous) => {
      const next = new Set(previous);
      for (const key of libraryFolderCollapseKeys(libraryTree)) next.add(key);
      return next;
    });
  }, [libraryTree]);

  // 文档/文件夹行的右键浮层菜单：单一 hook 实例，id 即 menuKey。
  // 高度随 menuKey 与 libraryCutPath 变化，所以 specs 每次渲染重算（hook 内用 specsRef 拿最新）。
  const docMenuSpecFor = (menuKey: string) => ({
    className: 'doc-menu',
    width: DOC_MENU_WIDTH,
    height: docMenuHeightFor(menuKey)
  });
  const docMenu = useFloatingMenu({ specs: docMenuSpecFor, offset: 4 });

  useEffect(() => {
    if (!docSearchOpen) return;
    requestAnimationFrame(() => {
      docSearchInputRef.current?.focus();
      docSearchInputRef.current?.select();
    });
  }, [docSearchOpen]);

  useEffect(() => {
    if (!docSearchOpen) return undefined;
    const closeDocSearchOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.('.doc-root-row')) return;
      setDocSearchOpen(false);
    };
    window.addEventListener('pointerdown', closeDocSearchOnOutsidePointer);
    return () => {
      window.removeEventListener('pointerdown', closeDocSearchOnOutsidePointer);
    };
  }, [docSearchOpen]);

  function docMenuHeightFor(menuKey: string): number {
    if (String(menuKey).startsWith('library-file:')) return libraryCutPath ? 160 : 128;
    if (String(menuKey).startsWith('library-folder:') || menuKey === 'folder:root') return libraryCutPath ? 150 : 118;
    return 150;
  }

  function renderDocMenu(menuKey: string, children: React.ReactNode) {
    if (docMenu.openId !== menuKey || !docMenu.position) return null;
    return createPortal(
      <div
        className="doc-menu"
        style={{
          left: `${docMenu.position.left}px`,
          top: `${docMenu.position.top}px`,
          width: `${docMenu.position.width}px`
        }}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>,
      document.body
    );
  }

  function toggleDocFolder(folderId: CollapseKey) {
    setCollapsedDocFolders((previous) => {
      const next = new Set(previous);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  function clearDocDragTimer() {
    if (docDragTimerRef.current) {
      window.clearTimeout(docDragTimerRef.current);
      docDragTimerRef.current = null;
    }
  }

  function libraryFolderPathFromPoint(clientX: number, clientY: number): string | undefined {
    const element = document.elementFromPoint(clientX, clientY);
    const folderRow = element?.closest?.('[data-library-folder-path]');
    if (!folderRow) return undefined;
    return folderRow.getAttribute('data-library-folder-path') || '';
  }

  function resetDocDragState() {
    clearDocDragTimer();
    document.body.classList.remove('is-dragging-doc');
    setDocDragState(null);
    docDragRef.current = null;
  }

  function startLibraryDrag(item: LibraryEntry, event: React.PointerEvent<HTMLElement>) {
    if (event.button !== 0 || busy || !item?.relativePath) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const drag: DocDragRefState = {
      item,
      active: false,
      startX,
      startY,
      x: startX,
      y: startY,
      overFolderPath: undefined
    };
    docDragRef.current = drag;

    const move = (moveEvent: PointerEvent) => {
      const current = docDragRef.current;
      if (!current) return;
      const distance = Math.hypot(moveEvent.clientX - current.startX, moveEvent.clientY - current.startY);
      if (!current.active) {
        if (distance > 7) stop();
        return;
      }
      moveEvent.preventDefault();
      current.x = moveEvent.clientX;
      current.y = moveEvent.clientY;
      current.overFolderPath = libraryFolderPathFromPoint(moveEvent.clientX, moveEvent.clientY);
      setDocDragState({
        active: true,
        docId: current.item!.relativePath,
        title: current.item!.name,
        x: current.x,
        y: current.y,
        overFolderPath: current.overFolderPath
      });
    };

    const stop = () => {
      const current = docDragRef.current;
      const hasTarget = Boolean(current?.active) && current?.overFolderPath !== undefined;
      const targetFolderPath = hasTarget ? current?.overFolderPath : undefined;
      const draggedItem = current?.item;
      const didDrag = Boolean(current?.active);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      resetDocDragState();
      if (didDrag) {
        suppressDocClickRef.current = true;
        if (hasTarget && draggedItem && draggedItem.relativePath !== targetFolderPath) {
          onMoveLibraryItem?.(draggedItem.relativePath, targetFolderPath);
        }
        window.setTimeout(() => {
          suppressDocClickRef.current = false;
        }, 120);
      }
    };

    docDragTimerRef.current = window.setTimeout(() => {
      const current = docDragRef.current;
      if (!current) return;
      current.active = true;
      suppressDocClickRef.current = true;
      document.body.classList.add('is-dragging-doc');
      setDocDragState({
        active: true,
        docId: current.item!.relativePath,
        title: current.item!.name,
        x: current.x,
        y: current.y,
        overFolderPath: undefined
      });
    }, 260);

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }

  function handleCutLibraryItem(item: LibraryEntry) {
    docMenu.close();
    onCutLibraryItem?.(item);
  }

  function handlePasteLibraryItem(targetFolderRelativePath: string = '') {
    docMenu.close();
    onPasteLibraryItem?.(targetFolderRelativePath);
  }

  function renderLibraryItems(items: LibraryEntry[] = [], depth = 0) {
    return items.map((item) => (
      item.type === 'folder' ? renderLibraryFolder(item, depth) : renderLibraryFile(item, depth)
    ));
  }

  function renderRootDocFolder() {
    const menuKey = 'folder:root';
    return (
      <div className="doc-folder-block doc-root-block">
        <div
          className={`doc-row doc-folder-row doc-root-row ${docMenu.openId === menuKey ? 'menu-open' : ''} ${docDragState?.overFolderPath === '' ? 'drop-target' : ''} ${docSearchOpen ? 'search-open' : ''}`}
          data-library-folder-path=""
        >
          <div
            className="doc-item doc-folder-item doc-root-item"
            title={libraryTree?.fullPath || '主文件夹'}
            onClick={() => {
              if (docSearchOpen) docSearchInputRef.current?.focus();
            }}
          >
            <ChevronDown size={12} />
            <FolderOpen size={12} />
            {docSearchOpen ? (
              <input
                ref={docSearchInputRef}
                type="text"
                value={docSearchQuery}
                placeholder="搜索文件"
                onChange={(event) => setDocSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setDocSearchOpen(false);
                    setDocSearchQuery('');
                  }
                }}
                onClick={(event) => event.stopPropagation()}
              />
            ) : (
              <span>主文件夹</span>
            )}
          </div>
          <button
            type="button"
            className="doc-search-button"
            title="搜索文件"
            aria-label="搜索文件"
            onClick={(event) => {
              event.stopPropagation();
              setDocSearchOpen(true);
            }}
          >
            <SearchIcon size={12} />
          </button>
          <button
            type="button"
            className="doc-menu-button"
            title="主文件夹操作"
            aria-label="主文件夹操作"
            onClick={(event) => docMenu.toggle(menuKey, event)}
          >
            <MoreHorizontal size={12} />
          </button>
          {renderDocMenu(menuKey, (
            <>
              <button type="button" onClick={() => { docMenu.close(); onRefreshLibrary?.(); }}>
                <RotateCcw size={13} />
                刷新文件夹
              </button>
              {libraryCutPath && (
                <button type="button" onClick={() => handlePasteLibraryItem('')}>
                  <FolderOpen size={13} />
                  粘贴到这里
                </button>
              )}
              {docSearchQuery && (
                <button type="button" onClick={() => { docMenu.close(); setDocSearchQuery(''); }}>
                  <SearchIcon size={13} />
                  清空搜索
                </button>
              )}
            </>
          ))}
        </div>
        {renderLibraryNavigation(1)}
        {renderLibraryItems(visibleLibraryTree?.children || [], 1)}
      </div>
    );
  }

  function renderLibraryNavigation(depth: number) {
    return (
      <div className={`doc-row doc-file-row library-navigation-row ${libraryNavigationOpen ? 'active' : ''}`}>
        <button
          type="button"
          className="doc-item doc-file-item"
          style={{ paddingLeft: `${depth * 10 + 16}px` }}
          title="导航"
          onClick={() => {
            docMenu.close();
            onOpenLibraryNavigation?.();
          }}
        >
          <ListTree size={11} />
          <span>导航</span>
          <small>虚拟文档</small>
        </button>
      </div>
    );
  }

  function renderLibraryFolder(item: LibraryEntry, depth: number) {
    const menuKey = `library-folder:${item.relativePath || 'root'}`;
    const collapsedFolder = collapsedDocFolders.has(libraryCollapseKey(item.relativePath));
    return (
      <div key={menuKey} className="doc-folder-block">
        <div
          className={`doc-row doc-folder-row ${docMenu.openId === menuKey ? 'menu-open' : ''} ${docDragState?.overFolderPath === item.relativePath ? 'drop-target' : ''} ${libraryCutPath === item.relativePath ? 'cut-source' : ''}`}
          data-library-folder-path={item.relativePath}
        >
          <button
            type="button"
            className="doc-item doc-folder-item"
            style={{ paddingLeft: `${depth * 10 + 4}px` }}
            title={item.fullPath}
            onPointerDown={(event) => startLibraryDrag(item, event)}
            onClick={(event) => {
              if (suppressDocClickRef.current) {
                event.preventDefault();
                event.stopPropagation();
                return;
              }
              toggleDocFolder(libraryCollapseKey(item.relativePath));
            }}
          >
            {collapsedFolder ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            {collapsedFolder ? <Folder size={12} /> : <FolderOpen size={12} />}
            <span>{item.name}</span>
          </button>
          <button
            type="button"
            className="doc-menu-button"
            title="文件夹操作"
            aria-label="文件夹操作"
            onClick={(event) => docMenu.toggle(menuKey, event)}
          >
            <MoreHorizontal size={12} />
          </button>
          {renderDocMenu(menuKey, (
            <>
              <button type="button" onClick={() => handleCutLibraryItem(item)}>
                <Scissors size={13} />
                剪切
              </button>
              {libraryCutPath && libraryCutPath !== item.relativePath && (
                <button type="button" onClick={() => handlePasteLibraryItem(item.relativePath)}>
                  <FolderOpen size={13} />
                  粘贴到这里
                </button>
              )}
            </>
          ))}
        </div>
        {!collapsedFolder && renderLibraryItems(item.children || [], depth + 1)}
      </div>
    );
  }

  function renderLibraryFile(item: LibraryEntry, depth: number) {
    const importedDoc = docBySourcePath.get(normalizeFsPath(item.fullPath));
    const supportedImport = isSupportedLibraryImport(item);
    const active = Boolean(importedDoc && currentDocId && importedDoc.id === currentDocId);
    const menuKey = `library-file:${item.relativePath}`;
    return (
      <div
        key={menuKey}
        className={`doc-row doc-file-row ${active ? 'active' : ''} ${!importedDoc ? 'unimported' : ''} ${!importedDoc && !supportedImport ? 'unsupported-file' : ''} ${docMenu.openId === menuKey ? 'menu-open' : ''} ${docDragState?.docId === item.relativePath ? 'dragging-source' : ''} ${libraryCutPath === item.relativePath ? 'cut-source' : ''}`}
      >
        <button
          type="button"
          className="doc-item doc-file-item"
          style={{ paddingLeft: `${depth * 10 + 16}px` }}
          title={item.fullPath}
          onPointerDown={(event) => startLibraryDrag(item, event)}
          onClick={(event) => {
            if (suppressDocClickRef.current) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            docMenu.close();
            onSelectLibraryFile?.(item);
          }}
        >
          <FileText size={11} />
          <span>{item.name}</span>
          <small>{importedDoc ? `${importedDoc.node_count || 0} 个节点` : (supportedImport ? '未导入' : '不支持')}</small>
        </button>
        <button
          type="button"
          className="doc-menu-button"
          title="文件操作"
          aria-label="文件操作"
          onClick={(event) => docMenu.toggle(menuKey, event)}
        >
          <MoreHorizontal size={12} />
        </button>
        {renderDocMenu(menuKey, (
          <>
            {importedDoc && (
              <button type="button" onClick={() => { docMenu.close(); onOpenDoc?.(importedDoc.id); }}>
                <FileText size={13} />
                打开导入文档
              </button>
            )}
            <button type="button" onClick={() => handleCutLibraryItem(item)}>
              <Scissors size={13} />
              剪切
            </button>
            {importedDoc && (
              <button type="button" className="doc-menu-danger" onClick={() => { docMenu.close(); onDeleteLibraryImport?.(item, importedDoc); }}>
                <Trash2 size={13} />
                删除导入
              </button>
            )}
          </>
        ))}
      </div>
    );
  }

  return (
    <>
      {docDragState?.active && (
        <div
          className="doc-drag-ghost"
          style={{ transform: `translate(${docDragState.x + 12}px, ${docDragState.y + 10}px)` }}
        >
          <FileText size={12} />
          <span>{docDragState.title}</span>
        </div>
      )}

      <div className="toolbar">
        <IconButton title="刷新主文件夹" onClick={onRefreshLibrary}><RotateCcw size={17} /></IconButton>
      </div>

      <section
        ref={docPanelRef}
        className="panel doc-panel"
        style={{ flexBasis: docPanelHeight ?? '50%' }}
      >
        <header className="panel-header">
          <span>文件</span>
        </header>
        <div className="doc-list">
          {renderRootDocFolder()}
        </div>
      </section>
    </>
  );
}
