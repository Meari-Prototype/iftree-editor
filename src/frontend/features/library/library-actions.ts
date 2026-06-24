// @ts-nocheck
import {
  DEFAULT_DOC_FOLDER_NAME,
  isSupportedLibraryImport,
  normalizeFsPath
} from '../../lib/doc-utils.js';

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
}) {
  async function createDocFolder(parentId = null) {
    if (busy) return null;
    setBusy(true);
    try {
      const folder = await documentRepository.createDocFolder({ name: DEFAULT_DOC_FOLDER_NAME, parentId });
      await refreshDocs(currentDoc?.doc?.id);
      return folder;
    } catch (error) {
      setNotice(error.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function renameDocFolder(folderId, name) {
    setBusy(true);
    try {
      await documentRepository.updateDocFolder({ folderId, patch: { name } });
      await refreshDocs(currentDoc?.doc?.id);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteDocFolder(folder) {
    const ok = window.confirm(`删除文件夹“${folder.name}”？非空文件夹不会被删除。`);
    if (!ok) return;
    setBusy(true);
    try {
      const folders = await documentRepository.deleteDocFolder({ folderId: folder.id });
      setDocFolders(folders);
      setNotice('已删除文件夹');
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function moveDocToFolder(doc, folderId) {
    setBusy(true);
    try {
      const nextDocs = await documentRepository.moveDocToFolder({ docId: doc.id, folderId: folderId || null });
      setDocs(nextDocs);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function moveLibraryItem(sourceRelativePath, targetFolderRelativePath = '') {
    if (!sourceRelativePath) return;
    setBusy(true);
    try {
      const tree = await documentRepository.moveLibraryEntry({ sourceRelativePath, targetFolderRelativePath });
      setLibraryTree(tree);
      setLibraryCutPath('');
      await refreshDocs(currentDoc?.doc?.id || null);
      setNotice('已移动文件');
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  function cutLibraryItem(item) {
    if (!item?.relativePath) return;
    setLibraryCutPath(item.relativePath);
    setNotice(`已剪切：${item.name}`);
  }

  function pasteLibraryItem(targetFolderRelativePath = '') {
    if (!libraryCutPath) return;
    moveLibraryItem(libraryCutPath, targetFolderRelativePath);
  }

  async function deleteLibraryImport(item, importedDoc) {
    if (!item || !importedDoc) return;
    const ok = window.confirm(`删除“${item.name}”的导入数据？
只会删除数据库里的节点和记录，不会删除原文件。`);
    if (!ok) return;
    setBusy(true);
    try {
      const nextDocs = await documentRepository.deleteDoc({ docId: importedDoc.id });
      setDocs(nextDocs);
      if (currentDoc?.doc?.id === importedDoc.id) {
        showLibraryFileOnly(item, '已删除导入数据，原文件已保留');
      } else {
        setSelectedLibraryEntry(item);
        setNotice('已删除导入数据，原文件已保留');
      }
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function selectLibraryFile(item) {
    const importedDoc = docBySourcePath.get(normalizeFsPath(item?.fullPath));
    if (importedDoc) {
      openDoc(importedDoc.id);
      return;
    }
    const canLeave = await confirmLeaveEditMode();
    if (!canLeave) return;
    if (!isSupportedLibraryImport(item)) {
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
