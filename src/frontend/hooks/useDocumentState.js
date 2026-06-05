import { useMemo, useRef, useState } from 'react';



import {
  DEFAULT_TREE_LOAD_DEPTH,
  SOURCE_WINDOW_BEFORE_CHARS,
  SOURCE_WINDOW_CHAR_LIMIT,
  TREE_FULL_NODE_PAGE_SIZE,
  loadedDepthForDoc,
  mergeDocView,
  mergeSourceWindow,
  normalizeDocId,
  sameDocId,
  treeDocRequest,
  treeLoadDepthForView
} from '../lib/doc-utils.mjs';
import { buildTreeWithIndex, nextFrame } from '../lib/mindmap-utils.mjs';
import { debugPerfBegin, debugPerfEnd } from '../lib/debug-log.mjs';
import { documentRepository } from '../data/document-repository.js';

export function useDocumentState({ setNotice, setProgress, lock, unlock } = {}) {
  const [docs, setDocs] = useState([]);
  const [docFolders, setDocFolders] = useState([]);
  const [libraryTree, setLibraryTree] = useState(null);
  const [selectedLibraryEntry, setSelectedLibraryEntry] = useState(null);
  const [libraryCutPath, setLibraryCutPath] = useState('');
  const [currentDoc, setCurrentDoc] = useState(null);
  const [sourceWindowLoading, setSourceWindowLoading] = useState(false);
  const startupOpenRequestedRef = useRef(false);

  async function refreshList() {
    const [nextDocs, nextFolders, nextLibraryTree] = await Promise.all([
      documentRepository.listDocs(),
      documentRepository.listDocFolders(),
      documentRepository.readLibraryTree()
    ]);
    setDocs(nextDocs);
    setDocFolders(nextFolders);
    if (nextLibraryTree) setLibraryTree(nextLibraryTree);
    return nextDocs;
  }

  async function refreshLibrary() {
    try {
      const tree = await documentRepository.readLibraryTree();
      setLibraryTree(tree);
      return tree;
    } catch (error) {
      setNotice?.(error.message);
      return null;
    }
  }

  async function loadComplete(docId, label = '正在打开文档……', options = {}) {
    lock?.({ label, step: 0, total: 0 });
    // debug 模式下记录文档加载总耗时（网络 + 分页拉节点 + 构建树索引）
    const perfToken = debugPerfBegin('loadComplete');
    let perfRowCount = 0;
    try {
      const initial = await documentRepository.getDoc(treeDocRequest(docId, DEFAULT_TREE_LOAD_DEPTH, {
        includeEditBranch: options.includeEditBranch
      }));
      const normalizedDocId = normalizeDocId(initial?.doc?.id || docId);
      if (!normalizedDocId) return initial;

      const total = Number(initial?.doc?.node_count) || 0;
      if (!documentRepository.canRead()) return initial;

      const rows = [];
      const seen = new Set();
      let afterId = '';
      const maxPages = Math.max(500, Math.ceil((total || 50000) / TREE_FULL_NODE_PAGE_SIZE) * 2);
      setProgress?.({ label, step: 0, total });

      for (let page = 0; page < maxPages; page++) {
        const result = await documentRepository.getDocNodesPage({
          docId: normalizedDocId,
          afterId,
          limit: TREE_FULL_NODE_PAGE_SIZE
        });
        const pageRows = Array.isArray(result?.rows) ? result.rows : [];
        if (pageRows.length === 0) break;

        for (const row of pageRows) {
          const id = String(row.id || '').trim();
          if (!id || seen.has(id)) continue;
          seen.add(id);
          rows.push(row);
        }

        setProgress?.({
          label,
          step: rows.length,
          total: total || rows.length
        });
        const nextAfterId = String(result?.nextAfterId || pageRows[pageRows.length - 1]?.id || '').trim();
        if (nextAfterId === afterId) break;
        afterId = nextAfterId;
        if (!result?.hasMore) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      if (rows.length === 0) return initial;
      perfRowCount = rows.length;
      setProgress?.({
        label: '正在构建树索引……',
        step: rows.length,
        total: total || rows.length,
        countLabel: `${rows.length} / ${total || rows.length}`
      });
      await nextFrame();
      const { tree, idByAddress, depthStats } = await buildTreeWithIndex(rows, ({ label: progressLabel, step, total: phaseTotal }) => {
        setProgress?.({
          label: String(progressLabel || ''),
          step,
          total: phaseTotal || rows.length,
          countLabel: `${Math.min(step, phaseTotal || rows.length)} / ${phaseTotal || rows.length}`
        });
      });
      if (!tree) return initial;
      return {
        ...initial,
        nodes: rows,
        tree,
        idByAddress,
        treeDepthStats: depthStats,
        loadedTreeDepth: depthStats?.maxDepth || loadedDepthForDoc({ tree })
      };
    } finally {
      debugPerfEnd('loadComplete', perfToken, { docId, nodes: perfRowCount });
      if (!options.keepLockAfterLoad) {
        unlock?.();
      }
    }
  }

  async function loadTreeDepth(nextDepth, targetDocId = currentDoc?.doc?.id) {
    const docId = normalizeDocId(targetDocId);
    if (!docId) return null;
    const requestedDepth = treeLoadDepthForView(nextDepth);
    if (loadedDepthForDoc(currentDoc) >= requestedDepth && sameDocId(currentDoc?.doc?.id, docId)) return currentDoc;
    const next = await documentRepository.getDoc(treeDocRequest(docId, requestedDepth));
    setCurrentDoc((current) => mergeDocView(current, next));
    return next;
  }

  async function loadSourceWindow(request = {}) {
    const docId = normalizeDocId(request.docId ?? currentDoc?.doc?.id);
    if (!docId || !documentRepository.canRead()) return null;
    setSourceWindowLoading(true);
    try {
      const sourceWindow = await documentRepository.getSourceWindow({
        docId,
        nodeId: request.nodeId ?? null,
        startOffset: request.startOffset,
        limit: request.limit || SOURCE_WINDOW_CHAR_LIMIT,
        before: request.before ?? SOURCE_WINDOW_BEFORE_CHARS
      });
      if (sourceWindow) setCurrentDoc((current) => mergeSourceWindow(current, sourceWindow));
      return sourceWindow;
    } catch (error) {
      setNotice?.(error.message);
      return null;
    } finally {
      setSourceWindowLoading(false);
    }
  }

  return useMemo(() => ({
    docs,
    docFolders,
    libraryTree,
    selectedLibraryEntry,
    libraryCutPath,
    currentDoc,
    sourceWindowLoading,
    setDocs,
    setDocFolders,
    setLibraryTree,
    setSelectedLibraryEntry,
    setLibraryCutPath,
    setCurrentDoc,
    setSourceWindowLoading,
    startupOpenRequestedRef,
    loadComplete,
    loadTreeDepth,
    loadSourceWindow,
    refreshLibrary,
    refreshList
  }), [
    currentDoc,
    docFolders,
    docs,
    libraryCutPath,
    libraryTree,
    selectedLibraryEntry,
    sourceWindowLoading,
    lock,
    unlock,
    setNotice,
    setProgress
  ]);
}
