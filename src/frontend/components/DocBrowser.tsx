// @ts-nocheck
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  ListTree,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Scissors,
  Search as SearchIcon,
  Trash2
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  buildDocBrowser,
  DEFAULT_DOC_FOLDER_NAME,
  DOC_MENU_WIDTH,
  filterLibraryTree,
  isSupportedLibraryImport,
  libraryCollapseKey,
  libraryFolderCollapseKeys,
  limitDocFolderName,
  MAX_DOC_FOLDER_NAME_LENGTH,
  normalizeDocFolderName,
  normalizeFsPath
} from '../lib/doc-utils.js';
import { IconButton } from './common.jsx';
import { useFloatingMenu } from '../hooks/useFloatingMenu.js';

export function DocBrowser({
  busy,
  docs,
  docFolders,
  libraryTree,
  docBySourcePath,
  currentDocId,
  libraryCutPath,
  docPanelRef,
  docPanelHeight,
  onRefreshLibrary,
  onOpenDoc,
  onCreateDoc,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onDeleteDoc,
  onMoveDoc,
  libraryNavigationOpen = false,
  onOpenLibraryNavigation,
  onSelectLibraryFile,
  onMoveLibraryItem,
  onCutLibraryItem,
  onPasteLibraryItem,
  onDeleteLibraryImport
}) {
  const [collapsedDocFolders, setCollapsedDocFolders] = useState(() => new Set());
  const [renamingFolderDraft, setRenamingFolderDraft] = useState(null);
  const [docSearchOpen, setDocSearchOpen] = useState(false);
  const [docSearchQuery, setDocSearchQuery] = useState('');
  const [docDragState, setDocDragState] = useState(null);
  const renameFolderInputRef = useRef(null);
  const docSearchInputRef = useRef(null);
  const renamingFolderRef = useRef(false);
  const skipFolderSaveRef = useRef(false);
  const docDragRef = useRef(null);
  const docDragTimerRef = useRef(null);
  const suppressDocClickRef = useRef(false);
  const libraryCollapseInitializedRef = useRef(false);

  const filteredDocs = useMemo(() => {
    const query = docSearchQuery.trim().toLocaleLowerCase();
    if (!query) return docs;
    return docs.filter((doc) => String(doc.title || '').toLocaleLowerCase().includes(query));
  }, [docs, docSearchQuery]);
  const docBrowser = useMemo(() => buildDocBrowser(docFolders, filteredDocs), [docFolders, filteredDocs]);
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
  const docMenuSpecFor = (menuKey) => ({
    className: 'doc-menu',
    width: DOC_MENU_WIDTH,
    height: docMenuHeightFor(menuKey)
  });
  const docMenu = useFloatingMenu({ specs: docMenuSpecFor, offset: 4 });

  useEffect(() => {
    if (!renamingFolderDraft) return;
    requestAnimationFrame(() => {
      renameFolderInputRef.current?.focus();
      renameFolderInputRef.current?.select();
    });
  }, [renamingFolderDraft]);

  useEffect(() => {
    if (!docSearchOpen) return;
    requestAnimationFrame(() => {
      docSearchInputRef.current?.focus();
      docSearchInputRef.current?.select();
    });
  }, [docSearchOpen]);

  useEffect(() => {
    if (!docSearchOpen) return undefined;
    const closeDocSearchOnOutsidePointer = (event) => {
      if (event.target?.closest?.('.doc-root-row')) return;
      setDocSearchOpen(false);
    };
    window.addEventListener('pointerdown', closeDocSearchOnOutsidePointer);
    return () => {
      window.removeEventListener('pointerdown', closeDocSearchOnOutsidePointer);
    };
  }, [docSearchOpen]);

  function docMenuHeightFor(menuKey) {
    if (String(menuKey).startsWith('library-file:')) return libraryCutPath ? 160 : 128;
    if (String(menuKey).startsWith('library-folder:') || menuKey === 'folder:root') return libraryCutPath ? 150 : 118;
    if (String(menuKey).startsWith('doc:')) return 116;
    return 150;
  }

  function renderDocMenu(menuKey, children) {
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

  function toggleDocFolder(folderId) {
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

  function folderIdFromPoint(clientX, clientY) {
    const element = document.elementFromPoint(clientX, clientY);
    const folderRow = element?.closest?.('[data-doc-folder-id]');
    const raw = folderRow?.getAttribute('data-doc-folder-id');
    if (raw === 'root') return null;
    const folderId = Number(raw);
    return Number.isInteger(folderId) && folderId > 0 ? folderId : undefined;
  }

  function libraryFolderPathFromPoint(clientX, clientY) {
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

  function startLibraryDrag(item, event) {
    if (event.button !== 0 || busy || renamingFolderDraft || !item?.relativePath) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const drag = {
      item,
      active: false,
      startX,
      startY,
      x: startX,
      y: startY,
      overFolderPath: undefined
    };
    docDragRef.current = drag;

    const move = (moveEvent) => {
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
        docId: current.item.relativePath,
        title: current.item.name,
        x: current.x,
        y: current.y,
        overFolderPath: current.overFolderPath
      });
    };

    const stop = () => {
      const current = docDragRef.current;
      const hasTarget = Boolean(current?.active) && current.overFolderPath !== undefined;
      const targetFolderPath = hasTarget ? current.overFolderPath : undefined;
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
        docId: current.item.relativePath,
        title: current.item.name,
        x: current.x,
        y: current.y,
        overFolderPath: undefined
      });
    }, 260);

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }

  function startDocDrag(doc, event) {
    if (event.button !== 0 || busy || renamingFolderDraft) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const drag = {
      doc,
      active: false,
      startX,
      startY,
      x: startX,
      y: startY,
      overFolderId: undefined
    };
    docDragRef.current = drag;

    const move = (moveEvent) => {
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
      current.overFolderId = folderIdFromPoint(moveEvent.clientX, moveEvent.clientY);
      setDocDragState({
        active: true,
        docId: current.doc.id,
        title: current.doc.title,
        x: current.x,
        y: current.y,
        overFolderId: current.overFolderId
      });
    };

    const stop = () => {
      const current = docDragRef.current;
      const hasTarget = Boolean(current?.active) && current.overFolderId !== undefined;
      const targetFolderId = hasTarget ? current.overFolderId : undefined;
      const draggedDoc = current?.doc;
      const didDrag = Boolean(current?.active);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      resetDocDragState();
      if (didDrag) {
        suppressDocClickRef.current = true;
        if (hasTarget && draggedDoc && (draggedDoc.folder_id ?? null) !== (targetFolderId ?? null)) {
          onMoveDoc?.(draggedDoc, targetFolderId);
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
        docId: current.doc.id,
        title: current.doc.title,
        x: current.x,
        y: current.y,
        overFolderId: undefined
      });
    }, 260);

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }

  async function handleCreateFolder(parentId = null) {
    if (busy) return;
    docMenu.close();
    skipFolderSaveRef.current = false;
    setRenamingFolderDraft(null);
    if (parentId !== null && parentId !== undefined) {
      setCollapsedDocFolders((previous) => {
        const next = new Set(previous);
        next.delete(Number(parentId));
        return next;
      });
    }
    const folder = await onCreateFolder?.(parentId);
    if (folder) {
      setRenamingFolderDraft({ folderId: folder.id, name: folder.name || DEFAULT_DOC_FOLDER_NAME });
    }
  }

  function startRenameDocFolder(folder) {
    if (!folder) return;
    docMenu.close();
    skipFolderSaveRef.current = false;
    setRenamingFolderDraft({ folderId: folder.id, name: folder.name || DEFAULT_DOC_FOLDER_NAME });
  }

  async function confirmRenameDocFolder() {
    if (!renamingFolderDraft || renamingFolderRef.current) return;
    if (skipFolderSaveRef.current) {
      skipFolderSaveRef.current = false;
      return;
    }
    const draft = renamingFolderDraft;
    const name = normalizeDocFolderName(draft.name);
    const folder = docFolders.find((item) => item.id === draft.folderId);
    if (folder && name === folder.name) {
      setRenamingFolderDraft(null);
      return;
    }
    renamingFolderRef.current = true;
    setRenamingFolderDraft(null);
    try {
      await onRenameFolder?.(draft.folderId, name);
      docMenu.close();
    } finally {
      renamingFolderRef.current = false;
    }
  }

  function handleCreateDoc(title, folderId = null) {
    docMenu.close();
    onCreateDoc?.(title, folderId);
  }

  function handleCutLibraryItem(item) {
    docMenu.close();
    onCutLibraryItem?.(item);
  }

  function handlePasteLibraryItem(targetFolderRelativePath = '') {
    docMenu.close();
    onPasteLibraryItem?.(targetFolderRelativePath);
  }

  function renderDocBrowserItems(items, depthOffset = 0) {
    return items.map((item) => (
      item.type === 'folder' ? renderDocFolder(item, depthOffset) : renderDocRow(item.doc, item.depth + depthOffset)
    ));
  }

  function renderLibraryItems(items = [], depth = 0) {
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

  function renderLibraryNavigation(depth) {
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

  function renderLibraryFolder(item, depth) {
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

  function renderLibraryFile(item, depth) {
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

  function renderDocFolder(item, depthOffset = 0) {
    const { folder, children, depth } = item;
    const displayDepth = depth + depthOffset;
    const menuKey = `folder:${folder.id}`;
    const collapsedFolder = collapsedDocFolders.has(folder.id);
    const renamingFolder = renamingFolderDraft?.folderId === folder.id;
    return (
      <div key={menuKey} className="doc-folder-block">
        <div
          className={`doc-row doc-folder-row ${docMenu.openId === menuKey ? 'menu-open' : ''} ${docDragState?.overFolderId === folder.id ? 'drop-target' : ''}`}
          data-doc-folder-id={folder.id}
        >
          {renamingFolder ? (
            <div
              className="doc-item doc-folder-item doc-folder-edit-item"
              style={{ paddingLeft: `${displayDepth * 10 + 4}px` }}
              onClick={(event) => event.stopPropagation()}
            >
              {collapsedFolder ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              {collapsedFolder ? <Folder size={12} /> : <FolderOpen size={12} />}
              <input
                ref={renameFolderInputRef}
                type="text"
                maxLength={MAX_DOC_FOLDER_NAME_LENGTH}
                value={renamingFolderDraft?.name || ''}
                onChange={(event) => setRenamingFolderDraft((draft) => (
                  draft ? { ...draft, name: limitDocFolderName(event.target.value) } : draft
                ))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    confirmRenameDocFolder();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    skipFolderSaveRef.current = true;
                    setRenamingFolderDraft(null);
                  }
                }}
                onBlur={confirmRenameDocFolder}
              />
            </div>
          ) : (
            <button
              type="button"
              className="doc-item doc-folder-item"
              style={{ paddingLeft: `${displayDepth * 10 + 4}px` }}
              title={folder.name}
              onClick={() => toggleDocFolder(folder.id)}
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                startRenameDocFolder(folder);
              }}
            >
              {collapsedFolder ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              {collapsedFolder ? <Folder size={12} /> : <FolderOpen size={12} />}
              <span>{folder.name}</span>
            </button>
          )}
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
              <button type="button" onClick={() => handleCreateDoc('未命名条件树文档', folder.id)}>
                <FilePlus2 size={13} />
                新建文档
              </button>
              <button type="button" onClick={() => handleCreateFolder(folder.id)}>
                <FolderPlus size={13} />
                新建子文件夹
              </button>
              <button type="button" onClick={() => startRenameDocFolder(folder)}>
                <Pencil size={13} />
                重命名
              </button>
              <button type="button" className="doc-menu-danger" onClick={() => { docMenu.close(); onDeleteFolder?.(folder); }}>
                <Trash2 size={13} />
                删除文件夹
              </button>
            </>
          ))}
        </div>
        {!collapsedFolder && children.length > 0 && renderDocBrowserItems(children, depthOffset)}
      </div>
    );
  }

  function renderDocRow(doc, depth) {
    const menuKey = `doc:${doc.id}`;
    return (
      <div
        key={menuKey}
        className={`doc-row doc-file-row ${doc.id === currentDocId ? 'active' : ''} ${docMenu.openId === menuKey ? 'menu-open' : ''} ${docDragState?.docId === doc.id ? 'dragging-source' : ''}`}
      >
        <button
          type="button"
          className="doc-item doc-file-item"
          style={{ paddingLeft: `${depth * 10 + 16}px` }}
          title={doc.title}
          onPointerDown={(event) => startDocDrag(doc, event)}
          onClick={(event) => {
            if (suppressDocClickRef.current) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            docMenu.close();
            onOpenDoc?.(doc.id);
          }}
        >
          <FileText size={11} />
          <span>{doc.title}</span>
          <small>{doc.node_count || 0} 个节点</small>
        </button>
        <button
          type="button"
          className="doc-menu-button"
          title="文档操作"
          aria-label="文档操作"
          onClick={(event) => docMenu.toggle(menuKey, event)}
        >
          <MoreHorizontal size={12} />
        </button>
        {renderDocMenu(menuKey, (
          <>
            <label className="doc-menu-field">
              <span>移动到</span>
              <select
                value={doc.folder_id ?? ''}
                onChange={(event) => { docMenu.close(); onMoveDoc?.(doc, event.target.value ? Number(event.target.value) : null); }}
              >
                <option value="">主文件夹</option>
                {docBrowser.flatFolders.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {`${'  '.repeat(folder.depth)}${folder.name}`}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="doc-menu-danger" onClick={() => { docMenu.close(); onDeleteDoc?.(doc); }}>
              <Trash2 size={13} />
              删除文档
            </button>
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
