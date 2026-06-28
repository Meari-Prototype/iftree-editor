import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type {
  DocGetNodeRow,
  DocGetRefRow,
  DocGetResult as BackendDocGetResult,
  DocGetSourceSpanRow,
  DocListItem
} from '../../backend/query-api.js';
import type { AxiomRow, DocFolderRow, SourceDocumentRow } from '../../backend/db/schema.js';
import type { EditBranchRow } from '../../backend/db/rows.js';
import type { HistoryEntry } from '../../backend/store/history.js';
import type { LibraryEntry } from '../../backend/library-fs.js';
import {
  NODE_CHILDREN_PAGE_SIZE,
  SOURCE_WINDOW_BEFORE_CHARS,
  SOURCE_WINDOW_CHAR_LIMIT,
  mergeSourceWindow,
  normalizeDocId,
  parseTreeViewState,
  treeDocRequest,
  type DocLike
} from '../lib/doc-utils.js';
import { documentRepository } from '../data/document-repository.js';
import { treeViewRepository } from '../data/repositories.js';
import { useAppUIContext } from './useAppUI.js';
import {
  applyViewSnapshot as viewApplySnapshot,
  applyViewState as viewApplyState,
  createSession,
  expandOneLevel as viewExpandOneLevel,
  ingestChildren,
  ingestRoot,
  nextBackgroundFetch,
  planHotFetches,
  projectToLegacyDoc,
  reconcileChildren as viewReconcileChildren,
  reconcileNode,
  selectNode as viewSelectNode,
  setDepthLimit as viewSetDepthLimit,
  setFocus,
  setMultiSelected as viewSetMultiSelected,
  snapshotView as viewSnapshot,
  toggleCollapsed as viewToggleCollapsed,
  viewStatePayload,
  type Session,
  type ViewSnapshot,
  type ViewSnapshotOut,
  type FetchRequest
} from '../session/document-session.js';

// 前台热区半径：打开/展开/定位时围绕焦点即时铺多少个 DFS 邻居（后台再尽力预取至全量）。
const HOT_REGION_RADIUS = 48;

type AnyRecord = Record<string, unknown>;

// 沿数据流总根：ProjectedDoc 的 nodes/refs/axioms/history 接后端真投影行类型（DocGetNodeRow / DocGetRefRow / AxiomRow / HistoryEntry）。
// editBranch / sourceDocument 同步接 EditBranchRow / SourceDocumentRow；idByAddress 接 Record<string, string>。
// 删 [extra: string]: unknown 兜底——字段写错运行时才炸的真隐患就此消除。
type ProjectedDoc = DocLike & {
  view?: Session['view'];
  editBranch?: EditBranchRow | null;
  sourceWindow?: { sourceSpans?: DocGetSourceSpanRow[]; anchorNodeId?: unknown; [extra: string]: unknown } | null;
  sourceSpans?: DocGetSourceSpanRow[];
  sourceDocument?: SourceDocumentRow | null;
  nodes?: DocGetNodeRow[];
  refs?: DocGetRefRow[];
  axioms?: AxiomRow[];
  history?: HistoryEntry[];
  idByAddress?: Record<string, string>;
  treeIndex?: { nodeOf?: (id: unknown) => { id?: unknown } | null | undefined; hasChildren?: (id: unknown) => boolean } | null;
};

interface DocMeta {
  doc?: BackendDocGetResult['doc'];
  sourceDocument?: SourceDocumentRow | null;
  editBranch?: EditBranchRow | null;
  axioms?: AxiomRow[];
  refs?: DocGetRefRow[];
  history?: HistoryEntry[];
  sourcePdfPages?: BackendDocGetResult['sourcePdfPages'];
  sourceSpans?: DocGetSourceSpanRow[];
  treeDepthStats?: BackendDocGetResult['treeDepthStats'];
}

// 前端 doc.get IPC 返回的本地视图（与后端 BackendDocGetResult 同构，但 nodes/idByAddress 是 useDocumentState 状态机的输入、不是必返）。
interface DocGetResult extends DocMeta {
  tree?: BackendDocGetResult['tree'] | null;
  nodes?: DocGetNodeRow[];
  idByAddress?: Record<string, string>;
  loadedTreeDepth?: unknown;
}

interface LoadCompleteOptions {
  includeEditBranch?: boolean;
  keepLockAfterLoad?: boolean;
}

interface SourceWindowRequest {
  docId?: unknown;
  nodeId?: unknown;
  startOffset?: unknown;
  limit?: number;
  before?: number;
}

interface SnapshotStore {
  snapshot: ProjectedDoc | null;
  listeners: Set<() => void>;
}

export function useDocumentState() {
  const { setNotice, setProgress, lock, unlock } = useAppUIContext();
  const [docs, setDocs] = useState<DocListItem[]>([]);
  const [docFolders, setDocFolders] = useState<DocFolderRow[]>([]);
  const [libraryTree, setLibraryTree] = useState<LibraryEntry | null>(null);
  const [selectedLibraryEntry, setSelectedLibraryEntry] = useState<LibraryEntry | null>(null);
  const [libraryCutPath, setLibraryCutPath] = useState<string>('');
  // L3 投影快照走 useSyncExternalStore 外部 store（替代 useState 的全量广播）：project/setCurrentDoc
  // 改 store 快照 + 通知订阅者；组件经 currentDoc 读整快照。selector 按需订阅留后续（瓶颈不在重渲染）。
  const storeRef = useRef<SnapshotStore>({ snapshot: null, listeners: new Set() });
  const subscribeSnapshot = useCallback((listener: () => void) => {
    storeRef.current.listeners.add(listener);
    return () => { storeRef.current.listeners.delete(listener); };
  }, []);
  const getSnapshot = useCallback(() => storeRef.current.snapshot, []);
  const currentDoc = useSyncExternalStore(subscribeSnapshot, getSnapshot);
  const setCurrentDocState = useCallback((next: ProjectedDoc | null | ((prev: ProjectedDoc | null) => ProjectedDoc | null)) => {
    storeRef.current.snapshot = typeof next === 'function' ? (next as (prev: ProjectedDoc | null) => ProjectedDoc | null)(storeRef.current.snapshot) : next;
    for (const listener of storeRef.current.listeners) listener();
  }, []);
  const [sourceWindowLoading, setSourceWindowLoading] = useState<boolean>(false);
  const startupOpenRequestedRef = useRef<boolean>(false);

  // L3 状态机：session 是节点树的单一真相；docMetaRef 持非树部分（doc / axioms / refs /
  // sourceDocument / editBranch / sourceSpans …）；currentDoc 退化成「docMeta + 投影树」的只读快照。
  // bgRef.token 用来作废上一个文档的后台预取循环（换文档/卸载时旧循环自然停）。
  const sessionRef = useRef<Session | null>(null);
  const docMetaRef = useRef<DocMeta | null>(null);

  const bgRef = useRef<{ token: number }>({ token: 0 });

  // 把状态机投影成 currentDoc 并触发渲染。所有改动（加载/展开/写/预取）末尾调它。
  const project = useCallback((): ProjectedDoc | null => {
    const session = sessionRef.current;
    const meta = docMetaRef.current;
    if (!session || !meta) return null;
    // meta（DocMeta）+ LegacyDocProjection（tree/idByAddress/depthStats）+ view 合成 ProjectedDoc——字段集相容但 TS 不直接 narrow，边界 cast 收口。
    const projected = { ...meta, ...projectToLegacyDoc(session), view: session.view } as ProjectedDoc;
    setCurrentDocState(projected);
    return projected;
  }, [setCurrentDocState]);

  // 从 doc.get 结果剥出非树部分（树改由 session 投影提供，避免浅树覆盖状态机的全量）。
  function metaFromDocResult(result: DocGetResult | null | undefined): DocMeta | null {
    if (!result) return null;
    const { tree, nodes, idByAddress, treeDepthStats, loadedTreeDepth, ...meta } = result;
    void tree; void nodes; void idByAddress; void treeDepthStats; void loadedTreeDepth;
    return meta;
  }

  // 取一个 parent 的一窗子节点并入 session（前台热区 / 后台预取 / 手动展开共用）。
  async function fetchChildrenInto(fetch: FetchRequest | { parentId?: unknown; offset?: number; limit?: number }): Promise<void> {
    const docId = sessionRef.current?.docId;
    if (!docId || !fetch?.parentId || !sessionRef.current) return;
    const result = await documentRepository.getNodeChildren({
      docId,
      parentId: fetch.parentId,
      offset: fetch.offset || 0,
      limit: fetch.limit || NODE_CHILDREN_PAGE_SIZE
    }) as { rows?: unknown[]; total?: number; offset?: number; hasMore?: boolean } | null | undefined;
    sessionRef.current = ingestChildren(sessionRef.current, {
      parentId: fetch.parentId,
      rows: result?.rows || [],
      total: result?.total,
      offset: result?.offset ?? fetch.offset ?? 0,
      hasMore: result?.hasMore
    });
  }

  // 结构写后用后端权威 replace 重取某 parent 的子（更新 address、级联删 move 走/删除的）。
  // 注：宽节点（>一页子）这里只取首页 replace，超页部分会被删——宽节点结构写是已知边缘，待实机。
  async function reconcileChildrenFromServer(parentId: unknown): Promise<void> {
    const docId = sessionRef.current?.docId;
    if (!docId || !parentId || !sessionRef.current) return;
    const result = await documentRepository.getNodeChildren({
      docId,
      parentId,
      offset: 0,
      limit: NODE_CHILDREN_PAGE_SIZE
    }) as { rows?: unknown[]; total?: number; hasMore?: boolean } | null | undefined;
    sessionRef.current = viewReconcileChildren(sessionRef.current, {
      parentId,
      rows: result?.rows || [],
      total: result?.total,
      hasMore: result?.hasMore
    });
  }

  // 前台热区：以 focusId 为中心迭代取边界，每轮 reconcile 后边界外推，填满 radius（~100ms 即可操作）。
  async function fillHotRegion(focusId: unknown, radius: number = HOT_REGION_RADIUS): Promise<void> {
    if (focusId && sessionRef.current) sessionRef.current = setFocus(sessionRef.current, focusId);
    for (let round = 0; round < 64; round += 1) {
      if (!sessionRef.current) break;
      const fetches = planHotFetches(sessionRef.current, { radius });
      if (fetches.length === 0) break;
      for (const fetch of fetches) await fetchChildrenInto(fetch);
    }
  }

  // 后台预取至全量：idle 逐个取边界、永驻常驻；token 变了立即停（换文档/卸载作废旧循环）。
  function startBackgroundPrefetch(): void {
    const token = ++bgRef.current.token;
    const step = async (): Promise<void> => {
      if (bgRef.current.token !== token) return;
      if (!sessionRef.current) return;
      const fetch = nextBackgroundFetch(sessionRef.current);
      if (!fetch) return; // 全量加载完，循环自然结束
      try {
        await fetchChildrenInto(fetch);
        if (bgRef.current.token !== token) return;
        project();
      } catch {
        // 预取是可丢弃的，失败不阻塞、不报错，下一轮继续。
      }
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  }

  async function refreshList(): Promise<DocListItem[]> {
    const [nextDocs, nextFolders, nextLibraryTree] = await Promise.all([
      documentRepository.listDocs(),
      documentRepository.listDocFolders(),
      documentRepository.readLibraryTree()
    ]);
    // IPC 返回 unknown：repository 那层未给具体类型，沿数据流在此处收口为投影类型。
    const docList = (nextDocs as DocListItem[] | null | undefined) || [];
    setDocs(docList);
    setDocFolders((nextFolders as DocFolderRow[] | null | undefined) || []);
    if (nextLibraryTree) setLibraryTree(nextLibraryTree as LibraryEntry);
    return docList;
  }

  async function refreshLibrary(): Promise<LibraryEntry | null> {
    try {
      const tree = await documentRepository.readLibraryTree() as LibraryEntry | null;
      setLibraryTree(tree);
      return tree;
    } catch (error) {
      setNotice?.((error as { message?: string }).message || '');
      return null;
    }
  }

  // 打开文档：doc.get(depth1) 拿 doc 元/axioms/refs/源文，建状态机 ingest 根 + 无条件取根的子，
  // 再扩散填热区（前台即时），最后启动后台预取至全量。返回投影后的 currentDoc。
  async function loadComplete(docId: unknown, label: string = '正在打开文档……', options: LoadCompleteOptions = {}): Promise<ProjectedDoc | DocGetResult | null> {
    lock?.({ label, step: 0, total: 0 });
    try {
      const initial = await documentRepository.getDoc(treeDocRequest(docId, 1, {
        includeEditBranch: options.includeEditBranch
      }) as never) as DocGetResult | null | undefined;
      const normalizedDocId = normalizeDocId(initial?.doc?.id || docId);
      if (!normalizedDocId) return initial ?? null;

      bgRef.current.token += 1; // 作废上一个文档的后台预取
      docMetaRef.current = metaFromDocResult(initial);
      // 死分支清理：DocRow 没有 root_id 字段（之前的 `initial.doc.root_id` 永远 undefined、走不到兜底）。
      const rootRow = initial?.tree || null;
      if (!rootRow) return initial ?? null;
      sessionRef.current = ingestRoot(createSession(normalizedDocId), rootRow);

      const rootId = sessionRef.current.index.root?.id;
      // 无条件取根的直接子（不依赖 doc.get 是否带 child_count），再以根为焦点扩散填热区。
      await fetchChildrenInto({ parentId: rootId, offset: 0 });
      await fillHotRegion(rootId);
      // 从后端 doc.tree_view_state 恢复折叠/深度（选中由各打开/新建编排显式设，不在此默认选根）。
      sessionRef.current = viewApplyState(sessionRef.current, parseTreeViewState(initial?.doc?.tree_view_state));
      const projected = project();
      startBackgroundPrefetch();
      return projected;
    } catch (error) {
      setNotice?.((error as { message?: string }).message || '');
      return null;
    } finally {
      if (!options.keepLockAfterLoad) unlock?.();
    }
  }

  // 深度调节 / 视图重载：扩散加载下深度不再是加载维度（后台预取会拉到所有深度）。
  // 保留签名兼容调用方，触发一次以当前焦点为中心的热区补齐 + 投影。
  async function loadTreeDepth(): Promise<ProjectedDoc | null> {
    if (!sessionRef.current || !docMetaRef.current) return currentDoc;
    await fillHotRegion(sessionRef.current.focusId || sessionRef.current.index.root?.id);
    return project();
  }

  // 展开一个节点：聚焦它、取它的子（及周围热区），reconcile 进状态机后投影。
  async function ensureNodeChildren(nodeId: unknown, options: AnyRecord = {}): Promise<void> {
    if (!sessionRef.current || !nodeId) return;
    void options;
    sessionRef.current = setFocus(sessionRef.current, nodeId);
    await fetchChildrenInto({ parentId: nodeId, offset: 0 });
    await fillHotRegion(nodeId);
    project();
  }

  // 内容写后回填：单节点 patch 进状态机再投影（结构写见 reparentReload）。
  function reconcileWrittenNode(row: { id?: unknown; [extra: string]: unknown } | null | undefined): void {
    if (!sessionRef.current || !row?.id) return;
    sessionRef.current = reconcileNode(sessionRef.current, row);
    project();
  }

  // 结构写 / 落主干等 address 全变的场景：用后端权威 replace 重取受影响 parent（更新 address、
  // 删 move 走的），其它已加载节点不动。parentIds 为空则重取根 + 焦点热区兜底。
  async function reloadStructuralChange(parentIds: unknown[] | null = null): Promise<ProjectedDoc | null> {
    if (!sessionRef.current) return null;
    const root = sessionRef.current.index.root?.id;
    const ids = Array.isArray(parentIds) && parentIds.length > 0 ? parentIds : [root];
    for (const id of ids) {
      if (id) await reconcileChildrenFromServer(id);
    }
    await fillHotRegion(sessionRef.current.focusId || root);
    return project();
  }

  // 更新非树元数据（axioms/refs/editBranch/doc 字段写后），不动状态机的节点树。
  function patchDocMeta(patch: Partial<DocMeta> | null | undefined): ProjectedDoc | null {
    if (!docMetaRef.current || !patch) return null;
    docMetaRef.current = { ...docMetaRef.current, ...patch };
    return project();
  }

  // 直接设投影（关闭文档 setCurrentDoc(null)、或外部已构造好快照的兼容路径）。
  function setCurrentDoc(next: ProjectedDoc | null | ((prev: ProjectedDoc | null) => ProjectedDoc | null)): void {
    if (typeof next === 'function') {
      setCurrentDocState((current) => {
        const resolved = (next as (prev: ProjectedDoc | null) => ProjectedDoc | null)(current);
        return resolved;
      });
      return;
    }
    if (next === null) {
      bgRef.current.token += 1;
      sessionRef.current = null;
      docMetaRef.current = null;
    }
    setCurrentDocState(next);
  }

  async function loadSourceWindow(request: SourceWindowRequest = {}): Promise<unknown> {
    const docId = normalizeDocId(request.docId ?? docMetaRef.current?.doc?.id);
    if (!docId || !documentRepository.canRead()) return null;
    setSourceWindowLoading(true);
    try {
      const sourceWindow = await documentRepository.getSourceWindow({
        docId,
        nodeId: request.nodeId ?? null,
        startOffset: request.startOffset,
        limit: request.limit || SOURCE_WINDOW_CHAR_LIMIT,
        before: request.before ?? SOURCE_WINDOW_BEFORE_CHARS
      }) as { docId?: unknown; sourceDocument?: Record<string, unknown> | null; [extra: string]: unknown } | null | undefined;
      if (sourceWindow) {
        docMetaRef.current = (mergeSourceWindow(docMetaRef.current as DocLike | null, sourceWindow) as DocMeta | null) || docMetaRef.current;
        project();
      }
      return sourceWindow;
    } catch (error) {
      setNotice?.((error as { message?: string }).message || '');
      return null;
    } finally {
      setSourceWindowLoading(false);
    }
  }

  // ─── 视图瞬态：调 session 动词 → project → 持久化 ──────────────────────────
  // 折叠/展开/深度/outline 改后存回后端 doc.tree_view_state；选中/标签是会话级、不持久（进撤销快照）。
  // 展开类动作顺带 setFocus + fillHotRegion（幂等取子，已加载不重取），把扩散加载焦点对齐到操作点。

  function persistTreeViewState(): void {
    const session = sessionRef.current;
    const docId = session?.docId;
    if (!docId || !treeViewRepository.canSaveTreeViewState?.()) return;
    treeViewRepository.saveTreeViewState({ docId, state: viewStatePayload(session!) })
      .then((updated) => {
        const meta = docMetaRef.current;
        const updatedDoc = (updated as { doc?: { tree_view_state?: unknown } } | null | undefined)?.doc;
        if (updatedDoc && normalizeDocId(meta?.doc?.id) === normalizeDocId(docId)) {
          docMetaRef.current = { ...meta!, doc: { ...meta!.doc!, tree_view_state: String(updatedDoc.tree_view_state ?? '') } };
        }
      })
      .catch((error: unknown) => setNotice?.((error as { message?: string }).message || ''));
  }

  async function toggleCollapsed(nodeId: unknown, options: AnyRecord = {}): Promise<void> {
    if (!sessionRef.current) return;
    sessionRef.current = viewToggleCollapsed(sessionRef.current, nodeId, options);
    sessionRef.current = setFocus(sessionRef.current, nodeId);
    await fillHotRegion(nodeId);
    project();
    persistTreeViewState();
  }

  async function expandNodeOneLevel(nodeId: unknown, options: AnyRecord = {}): Promise<void> {
    if (!sessionRef.current) return;
    sessionRef.current = setFocus(sessionRef.current, nodeId);
    await fetchChildrenInto({ parentId: nodeId, offset: 0 });
    await fillHotRegion(nodeId);
    sessionRef.current = viewExpandOneLevel(sessionRef.current, nodeId, options);
    project();
    persistTreeViewState();
  }

  async function setVisibleDepth(nextDepth: unknown): Promise<void> {
    if (!sessionRef.current) return;
    sessionRef.current = viewSetDepthLimit(sessionRef.current, nextDepth);
    await fillHotRegion(sessionRef.current.focusId || sessionRef.current.index.root?.id);
    project();
    persistTreeViewState();
  }

  function applyDocViewState(raw: AnyRecord | null | undefined): void {
    if (!sessionRef.current) return;
    sessionRef.current = viewApplyState(sessionRef.current, raw || {});
    project();
  }

  function selectNode(nodeId: unknown): void {
    if (!sessionRef.current) return;
    sessionRef.current = viewSelectNode(sessionRef.current, nodeId);
    project();
  }

  function setMultiSelected(ids: unknown): void {
    if (!sessionRef.current) return;
    sessionRef.current = viewSetMultiSelected(sessionRef.current, ids);
    project();
  }

  // 整套视图态批量设（切文档保留视图 / 撤销恢复共用）。options.persist 时存回后端。
  function setViewSnapshot(snapshot: ViewSnapshot, options: { persist?: boolean } = {}): void {
    if (!sessionRef.current) return;
    const next = viewApplySnapshot(sessionRef.current, snapshot);
    // 视图无实质变化（applyViewSnapshot 返回原引用）：不重建投影、不持久。project() 每次都造新 currentDoc，
    // 会让 docState 及其派生回调 churn，触发依赖回调的 effect（如 C2D 深度同步）重跑 → 无限回环 / React #185。
    if (next === sessionRef.current) return;
    sessionRef.current = next;
    project();
    if (options.persist) persistTreeViewState();
  }

  // 拍当前视图态快照（撤销 capture 用）。
  function snapshotView(): ViewSnapshotOut | null {
    return sessionRef.current ? viewSnapshot(sessionRef.current) : null;
  }

  return useMemo(() => ({
    docs,
    docFolders,
    libraryTree,
    selectedLibraryEntry,
    libraryCutPath,
    currentDoc,
    view: currentDoc?.view || null,
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
    ensureNodeChildren,
    reconcileWrittenNode,
    reloadStructuralChange,
    patchDocMeta,
    toggleCollapsed,
    expandNodeOneLevel,
    setVisibleDepth,
    applyDocViewState,
    setViewSnapshot,
    snapshotView,
    selectNode,
    setMultiSelected,
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
    setProgress,
    project
  ]);
}
