import type { Dispatch, SetStateAction } from 'react';

import type { DocListItem } from '../../../backend/query-api.js';
import type { DocFolderRow } from '../../../backend/db/schema.js';
import type { LibraryEntry } from '../../../backend/library-fs.js';
import {
  DEFAULT_DOC_FOLDER_NAME,
  isSupportedLibraryImport,
  normalizeFsPath
} from '../../lib/doc-utils.js';

// 仓库的最小结构（本文件用到的写动词；与 settings-actions 的 RepositoryLike 同惯例）。
interface DocumentRepositoryLike {
  createDocFolder(payload: { name: string; parentId?: unknown }): Promise<unknown>;
  updateDocFolder(payload: { folderId: unknown; patch: { name: string } }): Promise<unknown>;
  deleteDocFolder(payload: { folderId: unknown }): Promise<unknown>;
  moveDocToFolder(payload: { docId: unknown; folderId: unknown }): Promise<unknown>;
  moveLibraryEntry(payload: { sourceRelativePath: string; targetFolderRelativePath: string }): Promise<unknown>;
  deleteDoc(payload: { docId: unknown }): Promise<unknown>;
}

interface DocRef { id?: unknown; }
// 库文件树条目（前端视图）。
interface LibraryItem {
  relativePath?: string;
  name?: unknown;
  fullPath?: string;
  extension?: unknown;
}

interface LibraryActionsDeps {
  busy?: boolean;
  currentDoc?: { doc?: { id?: unknown } | null } | null;
  docBySourcePath: Map<string, DocRef>;
  libraryCutPath?: string;
  documentRepository: DocumentRepositoryLike;
  refreshDocs: (docId?: unknown) => Promise<unknown>;
  openDoc: (docId: unknown) => unknown;
  confirmLeaveEditMode: () => Promise<boolean>;
  showLibraryFileOnly: (item: unknown, notice?: string) => unknown;
  setBusy: (value: boolean) => void;
  setNotice: (message: string) => void;
  setDocFolders: Dispatch<SetStateAction<DocFolderRow[]>>;
  setDocs: Dispatch<SetStateAction<DocListItem[]>>;
  setLibraryTree: Dispatch<SetStateAction<LibraryEntry | null>>;
  setLibraryCutPath: (path: string) => void;
  setSelectedLibraryEntry: Dispatch<SetStateAction<LibraryEntry | null>>;
}

function errorMessage(error: unknown) {
  return (error as { message?: string })?.message || String(error);
}

export function createLibraryActions({
  busy,
  currentDoc,
  docBySourcePath,
  libraryCutPath,
  documentRepository,
  refreshDocs,
  openDoc,
  confirmLeaveEditMode,
  showLibraryFileOnly,
  setBusy,
  setNotice,
  setDocFolders,
  setDocs,
  setLibraryTree,
  setLibraryCutPath,
  setSelectedLibraryEntry
}: LibraryActionsDeps) {
  async function createDocFolder(parentId = null) {
    if (busy) return null;
    setBusy(true);
    try {
      const folder = await documentRepository.createDocFolder({ name: DEFAULT_DOC_FOLDER_NAME, parentId });
      await refreshDocs(currentDoc?.doc?.id);
      return folder;
    } catch (error) {
      setNotice(errorMessage(error));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function renameDocFolder(folderId: unknown, name: string) {
    setBusy(true);
    try {
      await documentRepository.updateDocFolder({ folderId, patch: { name } });
      await refreshDocs(currentDoc?.doc?.id);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function deleteDocFolder(folder: { id?: unknown; name?: unknown }) {
    const ok = window.confirm(`删除文件夹“${folder.name}”？非空文件夹不会被删除。`);
    if (!ok) return;
    setBusy(true);
    try {
      const folders = await documentRepository.deleteDocFolder({ folderId: folder.id });
      setDocFolders(folders as DocFolderRow[]);
      setNotice('已删除文件夹');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function moveDocToFolder(doc: { id?: unknown }, folderId: unknown) {
    setBusy(true);
    try {
      const nextDocs = await documentRepository.moveDocToFolder({ docId: doc.id, folderId: folderId || null });
      setDocs(nextDocs as DocListItem[]);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function moveLibraryItem(sourceRelativePath: string, targetFolderRelativePath = '') {
    if (!sourceRelativePath) return;
    setBusy(true);
    try {
      const tree = await documentRepository.moveLibraryEntry({ sourceRelativePath, targetFolderRelativePath });
      setLibraryTree(tree as LibraryEntry);
      setLibraryCutPath('');
      await refreshDocs(currentDoc?.doc?.id || null);
      setNotice('已移动文件');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function cutLibraryItem(item: LibraryItem) {
    if (!item?.relativePath) return;
    setLibraryCutPath(item.relativePath);
    setNotice(`已剪切：${item.name}`);
  }

  function pasteLibraryItem(targetFolderRelativePath = '') {
    if (!libraryCutPath) return;
    moveLibraryItem(libraryCutPath, targetFolderRelativePath);
  }

  async function deleteLibraryImport(item: LibraryItem, importedDoc: DocRef) {
    if (!item || !importedDoc) return;
    const ok = window.confirm(`删除“${item.name}”的导入数据？
只会删除数据库里的节点和记录，不会删除原文件。`);
    if (!ok) return;
    setBusy(true);
    try {
      const nextDocs = await documentRepository.deleteDoc({ docId: importedDoc.id });
      setDocs(nextDocs as DocListItem[]);
      if (currentDoc?.doc?.id === importedDoc.id) {
        showLibraryFileOnly(item, '已删除导入数据，原文件已保留');
      } else {
        setSelectedLibraryEntry(item as LibraryEntry);
        setNotice('已删除导入数据，原文件已保留');
      }
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function selectLibraryFile(item: LibraryItem) {
    const importedDoc = docBySourcePath.get(normalizeFsPath(item?.fullPath));
    if (importedDoc) {
      openDoc(importedDoc.id);
      return;
    }
    const canLeave = await confirmLeaveEditMode();
    if (!canLeave) return;
    if (!isSupportedLibraryImport(item as LibraryEntry)) {
      setNotice(`不支持导入格式：${item.extension || '未知格式'}`);
      return;
    }
    showLibraryFileOnly(item);
  }

  return {
    createDocFolder,
    renameDocFolder,
    deleteDocFolder,
    moveDocToFolder,
    moveLibraryItem,
    cutLibraryItem,
    pasteLibraryItem,
    deleteLibraryImport,
    selectLibraryFile
  };
}
