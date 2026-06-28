// L3 DocumentSession · 纯逻辑核心
//
// db 镜像（复用 core/node-model 的 TreeIndex）+ DFS 扩散调度。无 React 依赖，可 node --test。
// React 适配（useSyncExternalStore + RPC + idle 预取循环）在 use-document-session.ts，本模块只回答
// 两个问题：「状态怎么增量长」（ingest* / reconcile）和「下一步该取谁」（planHotFetches /
// nextBackgroundFetch）。所有「下一个取谁」都委托 core/tree-cursor 的 DFS 序原语，不另写一份。
//
// 两个 childCount 必须分清：
//   node.childCount（每行自带，来自后端 child_count）—— 「声称」的子节点总数，判断是否还有未取的子。
//   loadedChildCount（已并入 index.childrenOf 的子数）—— 喂给 tree-cursor 的 childCountOf：
//                                                       0 = 叶或未加载=DFS 边界，扩散到此自然停。
// 「声称 > 已加载」即取数边界（有子但子列表没拉）。永驻缓存：ingest 只增不删（结构写另走 reconcile）。

import { buildTreeIndex, getDescendants, patchNode, removeNode, toTreeNode, type TreeIndex, type TreeNode } from '../../core/node-model.js';
import { nextInDfs, spreadAddresses } from '../../core/tree-cursor.js';

const DEFAULT_PAGE_LIMIT = 300;

export interface ChildPageInfo {
  loaded: number;
  total: number;
  hasMore: boolean;
}

export interface SessionView {
  depthLimit: number;
  collapsed: Set<string>;
  expanded: Set<string>;
  outlineCollapsed: Set<string>;
  selectedId: string | null;
  multiSelected: Set<string>;
}

export interface Session {
  docId: string | null;
  index: TreeIndex;
  loadedParents: Set<string>;
  childPages: Map<string, ChildPageInfo>;
  focusId: string | null;
  loadSeq: number;
  view: SessionView;
}

export interface FetchRequest {
  parentId: string;
  offset: number;
  limit: number;
}

export interface IngestChildrenPatch {
  parentId?: unknown;
  rows?: unknown[];
  total?: unknown;
  offset?: unknown;
  hasMore?: boolean;
}

export interface ViewStateRaw {
  depthLimit?: unknown;
  collapsedNodeIds?: unknown;
  expandedNodeIds?: unknown;
  outlineCollapsedNodeIds?: unknown;
}

export interface ViewSnapshot {
  depthLimit?: number;
  selectedNodeId?: string | null;
  collapsedNodeIds?: string[];
  expandedNodeIds?: string[];
  outlineCollapsedNodeIds?: string[];
  multiSelectedNodeIds?: string[];
}

export interface LegacyDocProjection {
  tree: (TreeNode & { children: TreeNode[] }) | null;
  idByAddress: Record<string, string>;
  depthStats: { maxDepth: number; depths: number[] };
}

function normalizeId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

// state 形状（index 内部可变 Map，state 每次换引用 + loadSeq+1 当变化信号；大 Map 不深拷贝）：
//   { docId, index, loadedParents:Set<id>, childPages:Map<id,{loaded,total,hasMore}>, focusId, loadSeq,
//     view:{ depthLimit, collapsed:Set, expanded:Set, outlineCollapsed:Set, selectedId, multiSelected:Set } }
// view = 文档级 UI 瞬态（折叠/展开/深度/选中），全 node_id 键或标量；加载动词不碰它，视图动词只换 view 引用。
// activeTab 是全局 UI（文档无关），不在这里——归 useAppUI。
export function createSession(docId: unknown): Session {
  return {
    docId: normalizeId(docId),
    index: buildTreeIndex([]),
    loadedParents: new Set<string>(),
    childPages: new Map<string, ChildPageInfo>(),
    focusId: null,
    loadSeq: 0,
    view: {
      depthLimit: 1,
      collapsed: new Set<string>(),
      expanded: new Set<string>(),
      outlineCollapsed: new Set<string>(),
      selectedId: null,
      multiSelected: new Set<string>()
    }
  };
}

function bump(state: Session): Session {
  return { ...state, loadSeq: state.loadSeq + 1 };
}

// 把一批节点行并入 index（byId / byAddress），不碰 childrenOf 排序——那留给 reorderChildren。
function upsertNodes(index: TreeIndex, rows: unknown[]): TreeNode[] {
  const nodes: TreeNode[] = [];
  for (const row of rows) {
    const node = toTreeNode(row as Record<string, unknown> | null);
    if (!node) continue;
    const prev = index.byId.get(node.id);
    if (prev?.address && prev.address !== node.address) index.byAddress.delete(prev.address);
    index.byId.set(node.id, node);
    if (node.address) index.byAddress.set(node.address, node);
    nodes.push(node);
  }
  return nodes;
}

// 重建某 parent 的 childrenOf（合并已有 + 新并入，按 sortOrder 稳定排序）。
function reorderChildren(index: TreeIndex, parentId: string): TreeNode[] {
  const existing = index.childrenOf.get(parentId) || [];
  const merged = new Map<string, TreeNode>(existing.map((node) => [node.id, node]));
  for (const node of index.byId.values()) {
    if (node.parentId === parentId) merged.set(node.id, node);
  }
  const list = [...merged.values()].sort(
    (a, b) => a.sortOrder - b.sortOrder || String(a.id).localeCompare(String(b.id))
  );
  index.childrenOf.set(parentId, list);
  return list;
}

// 打开文档第一步：并入根节点（root 不是任何 parent 的子，单独拿）。
export function ingestRoot(state: Session, rootRow: unknown): Session {
  const [root] = upsertNodes(state.index, [rootRow]);
  if (root) state.index.root = root;
  state.index.size = state.index.byId.size;
  return bump(state);
}

// 并入某 parent 的一窗子节点（listChildren 结果）。永驻只增。
export function ingestChildren(state: Session, patch: IngestChildrenPatch = {}): Session {
  const parentId = normalizeId(patch.parentId);
  if (parentId == null) return state;
  const rows = Array.isArray(patch.rows) ? patch.rows : [];
  const index = state.index;
  upsertNodes(index, rows);
  const children = reorderChildren(index, parentId);
  index.size = index.byId.size;

  const total = Number.isFinite(Number(patch.total)) ? Number(patch.total) : children.length;
  const offset = Math.max(0, Math.floor(Number(patch.offset) || 0));
  const loaded = Math.max(children.length, offset + rows.length);
  const hasMore = patch.hasMore === true ? true : loaded < total;
  state.childPages.set(parentId, { loaded, total, hasMore });
  state.loadedParents.add(parentId);

  // 校准 parent 的「声称 childCount」——后端 total 比建索引时的旧值权威。
  const parent = index.byId.get(parentId);
  if (parent && total > (parent.childCount || 0)) parent.childCount = total;
  return bump(state);
}

// 内容写回填：单节点 patch（node.update 返回的 kind:'node' 单行结果）。委托 node-model.patchNode
// 统一处理 byId/byAddress/childrenOf 迁移与 root 更新（含单节点 parentId 变化的兄弟迁移），
// 不另写一套索引维护。只回填已加载节点；子树 move/删导致后代 address 全变的结构写不归这里
// （走 reloadStructuralChange 重取受影响子树）。
export function reconcileNode(state: Session, row: { id?: unknown; [extra: string]: unknown } | null | undefined): Session {
  const id = normalizeId(row?.id);
  if (id == null || !state.index.byId.has(id)) return state; // 只回填已加载节点，不新增孤儿
  patchNode(state.index, row as Parameters<typeof patchNode>[1]);
  return bump(state);
}

// 结构写回填：用后端权威子列表 replace 某 parent 的 children（不是 merge——结构写 address 全变）。
// 在现有 session 上增量更新，不丢其它已加载节点：删掉旧 children 里不在新列表的（move 走/删除，
// removeNode 级联清其子树）、upsert 留下的（迁移新 address）、加入新增的，再按 sortOrder 重排。
// runWrite 对受影响的每个 parent（目标 + move 的源）各调一次。
export function reconcileChildren(state: Session, patch: IngestChildrenPatch = {}): Session {
  const parentId = normalizeId(patch.parentId);
  if (parentId == null) return state;
  const index = state.index;
  const rows = Array.isArray(patch.rows) ? patch.rows : [];
  const nextIds = new Set<string>();
  for (const row of rows) {
    const id = normalizeId((row as { id?: unknown } | null)?.id);
    if (id) nextIds.add(id);
  }

  const oldChildren = [...(index.childrenOf.get(parentId) || [])];
  for (const child of oldChildren) {
    if (!nextIds.has(child.id)) removeNode(index, child.id);
  }
  upsertNodes(index, rows);
  reorderChildren(index, parentId);
  index.size = index.byId.size;

  const loaded = (index.childrenOf.get(parentId) || []).length;
  const total = Number.isFinite(Number(patch.total)) ? Number(patch.total) : loaded;
  state.childPages.set(parentId, { loaded, total, hasMore: patch.hasMore === true ? true : loaded < total });
  state.loadedParents.add(parentId);
  const parent = index.byId.get(parentId);
  if (parent) parent.childCount = total;
  return bump(state);
}

export function setFocus(state: Session, focusId: unknown): Session {
  const id = normalizeId(focusId);
  if (id === state.focusId) return state;
  return { ...state, focusId: id };
}

// 已并入 index 的子节点数（喂 tree-cursor 的 childCountOf）。未加载父 → 0 = DFS 边界。
function loadedChildCount(state: Session, nodeId: string | null): number {
  if (nodeId == null || !state.loadedParents.has(nodeId)) return 0;
  return (state.index.childrenOf.get(nodeId) || []).length;
}

// 喂给 tree-cursor：address → 已加载子数。tree-cursor 只在已加载区推导 DFS 序，边界即取数前沿。
export function makeChildCountOf(state: Session): (address: unknown) => number {
  return (address) => {
    const node = state.index.byAddress.get(String(address));
    return node ? loadedChildCount(state, node.id) : 0;
  };
}

// 某节点是取数边界？声称有子（childCount>0）但子列表没拉（!loadedParents），或分页还有 hasMore。
function fetchBoundaryOf(state: Session, nodeId: string): FetchRequest | null {
  const node = state.index.byId.get(nodeId);
  if (!node) return null;
  const page = state.childPages.get(nodeId);
  if (!state.loadedParents.has(nodeId)) {
    return node.childCount > 0 ? { parentId: nodeId, offset: 0, limit: DEFAULT_PAGE_LIMIT } : null;
  }
  if (page?.hasMore) return { parentId: nodeId, offset: page.loaded, limit: DEFAULT_PAGE_LIMIT };
  return null;
}

// 前台热区取数：从根到焦点的祖先链 + 焦点周围 DFS 滑窗内，所有取数边界的 listChildren 请求。
// spreadAddresses 用「已加载子数」推导，只在已加载区扩；其中声称有子但未拉的节点即本轮该取。
// 取了 → reconcile → 边界外推 → 下一轮 plan 能扩更远，迭代填满 radius。
export function planHotFetches(state: Session, options: { radius?: number } = {}): FetchRequest[] {
  const radius = Math.max(1, Math.floor(Number(options.radius) || 24));
  const focus = state.focusId ? state.index.byId.get(state.focusId) : state.index.root;
  if (!focus) {
    // 连根都没有 → 第一拉。调用方负责先 ingestRoot；这里至少请求根的子。
    return state.index.root ? collectFetches(state, [state.index.root.id]) : [];
  }
  const childCountOf = makeChildCountOf(state);
  const ids: string[] = [];
  // 祖先链 + 焦点自身：保证从根到焦点路径上每层子列表都在（焦点上下文完整）。
  let cursor: TreeNode | null | undefined = focus;
  const chain: string[] = [];
  while (cursor) {
    chain.unshift(cursor.id);
    cursor = cursor.parentId ? state.index.byId.get(cursor.parentId) : null;
  }
  ids.push(...chain);
  // 焦点周围的 DFS 滑窗（祖先链优先，再向 DFS 前后交替）。
  for (const address of spreadAddresses(focus.address, radius, childCountOf)) {
    const node = state.index.byAddress.get(address);
    if (node) ids.push(node.id);
  }
  return collectFetches(state, ids);
}

function collectFetches(state: Session, nodeIds: string[]): FetchRequest[] {
  const fetches: FetchRequest[] = [];
  const seen = new Set<string>();
  for (const id of nodeIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const boundary = fetchBoundaryOf(state, id);
    if (boundary) fetches.push(boundary);
  }
  return fetches;
}

// 后台预取：沿 DFS 全序（从根，nextInDfs 走已加载区）找第一个取数边界。null = 全量加载完。
// 与前台 planHotFetches 同序同源，只是不受 radius 约束——「所有要取的」。
export function nextBackgroundFetch(state: Session): FetchRequest | null {
  const root = state.index.root;
  if (!root) return null;
  const childCountOf = makeChildCountOf(state);
  let address: string | null = root.address;
  while (address) {
    const node = state.index.byAddress.get(address);
    if (node) {
      const boundary = fetchBoundaryOf(state, node.id);
      if (boundary) return boundary;
    }
    address = nextInDfs(address, childCountOf);
  }
  return null;
}

export function isFullyLoaded(state: Session): boolean {
  return nextBackgroundFetch(state) === null;
}

// ─── 视图瞬态：折叠 / 展开 / 深度 / 选中 / 标签 ─────────────────────────────
// 全部纯函数：输入 state + 参数，输出新 state（view 子对象换引用 + bump）。可见性模型沿用
// (depthLimit, collapsed, expanded) 三元——depthLimit 内默认展开；collapsed 盖掉浅层默认展开；
// expanded 盖掉深层默认折叠。深度/子/后代均由 index 推导（O(局部)，不投影整树）。
// 折叠/深度逻辑从 AppBody.toggleCollapsed/expandNodeOneLevel + doc-utils.promote 收编到这一处。

function clampDepth(value: unknown, maxDepth: unknown): number {
  const max = Math.max(1, Number(maxDepth) || 1);
  return Math.min(max, Math.max(1, Number(value) || 1));
}

function idSet(value: unknown): Set<string> {
  const out = new Set<string>();
  const source: Iterable<unknown> = value instanceof Set ? value : (Array.isArray(value) ? value : []);
  for (const item of source) {
    const id = normalizeId(item);
    if (id) out.add(id);
  }
  return out;
}

function depthOfId(state: Session, id: string): number {
  const node = state.index.byId.get(id);
  return node?.address ? node.address.split('-').length : 1;
}

function hasChildrenById(state: Session, id: string): boolean {
  const node = state.index.byId.get(id);
  if (!node) return false;
  return node.childCount > 0 || (state.index.childrenOf.get(id)?.length || 0) > 0;
}

// 已加载区的最大深度（扩散加载下随预取增长；深度调节与 promote 的天花板都用它）。
export function maxDepthOf(state: Session): number {
  let max = 1;
  for (const node of state.index.byId.values()) {
    const depth = node.address ? node.address.split('-').length : 1;
    if (depth > max) max = depth;
  }
  return max;
}

function commitView(state: Session, patch: Partial<SessionView>): Session {
  return { ...state, view: { ...state.view, ...patch }, loadSeq: state.loadSeq + 1 };
}

// 收紧 collapsed：只留深度 >= limit 的（< limit 的折叠在新深度下无意义）。index 版 collapsedForDepthLimit。
function collapsedForDepth(state: Session, collapsed: Set<string>, limit: number): Set<string> {
  const next = new Set<string>();
  for (const id of collapsed) if (depthOfId(state, id) >= limit) next.add(id);
  return next;
}

interface PromoteResult {
  depthLimit: number;
  collapsed: Set<string>;
  expanded: Set<string>;
}

// 整层展开自动提深度：当前 depthLimit 层的所有「有子节点」都被显式 expanded → depthLimit+1，
// 并清掉新深度内冗余的 expanded/collapsed。返回 null 表示无需提升。
function promoteIfLayerExpanded(state: Session, { depthLimit, collapsed, expanded }: PromoteResult): PromoteResult | null {
  const cap = maxDepthOf(state);
  const cur = Math.max(1, Number(depthLimit) || 1);
  if (cur >= cap) return null;
  const layer: TreeNode[] = [];
  for (const node of state.index.byId.values()) {
    if ((node.address ? node.address.split('-').length : 1) === cur && hasChildrenById(state, node.id)) layer.push(node);
  }
  if (layer.length === 0) return null;
  if (!layer.every((node) => !collapsed.has(node.id) && expanded.has(node.id))) return null;
  const next = Math.min(cap, cur + 1);
  const nextExpanded = new Set<string>();
  for (const id of expanded) if (depthOfId(state, id) >= next) nextExpanded.add(id);
  return { depthLimit: next, collapsed: collapsedForDepth(state, collapsed, next), expanded: nextExpanded };
}

export function selectNode(state: Session, nodeId: unknown): Session {
  const id = normalizeId(nodeId);
  return id === state.view.selectedId ? state : commitView(state, { selectedId: id });
}

export function setMultiSelected(state: Session, ids: unknown): Session {
  return commitView(state, { multiSelected: idSet(ids) });
}

export function setDepthLimit(state: Session, value: unknown): Session {
  const next = clampDepth(value, maxDepthOf(state));
  return next === state.view.depthLimit ? state : commitView(state, { depthLimit: next });
}

// 从后端 doc.tree_view_state（解析后的 raw）恢复视图态。outlineCollapsedNodeIds 缺省则保留现状。
export function applyViewState(state: Session, raw: ViewStateRaw = {}): Session {
  const cap = maxDepthOf(state);
  return commitView(state, {
    depthLimit: clampDepth(raw.depthLimit || cap, cap),
    collapsed: idSet(raw.collapsedNodeIds),
    expanded: idSet(raw.expandedNodeIds),
    outlineCollapsed: raw.outlineCollapsedNodeIds != null ? idSet(raw.outlineCollapsedNodeIds) : state.view.outlineCollapsed
  });
}

// 序列化视图态 → 存回后端 doc.tree_view_state 的 payload（适配层 saveTreeViewState 用）。
export function viewStatePayload(state: Session): { depthLimit: number; collapsedNodeIds: string[]; expandedNodeIds: string[]; outlineCollapsedNodeIds: string[] } {
  const list = (s: Set<string> | null | undefined): string[] => [...(s || new Set<string>())]
    .map(normalizeId)
    .filter((value): value is string => Boolean(value));
  const view = state.view;
  return {
    depthLimit: Math.max(1, Number(view.depthLimit) || 1),
    collapsedNodeIds: list(view.collapsed),
    expandedNodeIds: list(view.expanded),
    outlineCollapsedNodeIds: list(view.outlineCollapsed)
  };
}

// 折叠/展开一个节点（无子则无操作）。语义搬自 AppBody.toggleCollapsed：
//   已折叠 → 展开（深层补进 expanded）；当前显示子 → 折叠（自身 + 后代移出 expanded）；当前不显示子 → 展开。
// singlePath（手风琴）：清掉比本节点更深的 expanded/collapsed。promoteDepth!==false 时展开后试提层。
export function toggleCollapsed(state: Session, nodeId: unknown, options: { singlePath?: boolean; promoteDepth?: boolean } = {}): Session {
  const id = normalizeId(nodeId);
  if (id == null || !hasChildrenById(state, id)) return state;
  const view = state.view;
  const nextCollapsed = new Set(view.collapsed);
  const nextExpanded = new Set(view.expanded);
  const nodeDepth = depthOfId(state, id);

  if (options.singlePath === true) {
    for (const other of [...nextExpanded]) if (depthOfId(state, other) > nodeDepth) nextExpanded.delete(other);
    for (const other of [...nextCollapsed]) if (depthOfId(state, other) > nodeDepth) nextCollapsed.delete(other);
  }

  let expandedNode = false;
  if (nextCollapsed.has(id)) {
    nextCollapsed.delete(id);
    if (nodeDepth >= view.depthLimit) nextExpanded.add(id);
    expandedNode = true;
  } else if (nextExpanded.has(id) || nodeDepth < view.depthLimit) {
    nextCollapsed.add(id);
    nextExpanded.delete(id); // 自身移出（getDescendants 不含自身，手工补，对齐 AppBody）
    for (const node of getDescendants(state.index, id)) nextExpanded.delete(node.id);
  } else {
    nextExpanded.add(id);
    expandedNode = true;
  }

  let result: PromoteResult = { depthLimit: view.depthLimit, collapsed: nextCollapsed, expanded: nextExpanded };
  if (expandedNode && options.promoteDepth !== false) result = promoteIfLayerExpanded(state, result) || result;
  return commitView(state, result);
}

// 展开一个节点一层（搬 AppBody.expandNodeOneLevel）：设 depthLimit ≥ minDepth、把它加进 expanded。
// singlePath 用 >= 本节点深度（与 toggle 的 > 不同，保持各自原语义）。
export function expandOneLevel(state: Session, nodeId: unknown, options: { singlePath?: boolean; minDepth?: number } = {}): Session {
  const id = normalizeId(nodeId);
  if (id == null || !state.index.byId.has(id)) return state;
  const view = state.view;
  const nextCollapsed = new Set(view.collapsed);
  const nextExpanded = new Set(view.expanded);
  const nextDepthLimit = clampDepth(Math.max(view.depthLimit, Math.floor(Number(options.minDepth) || 0)), maxDepthOf(state));
  const nodeDepth = depthOfId(state, id);

  if (options.singlePath === true) {
    for (const other of [...nextExpanded]) if (depthOfId(state, other) >= nodeDepth) nextExpanded.delete(other);
    for (const other of [...nextCollapsed]) if (depthOfId(state, other) >= nodeDepth) nextCollapsed.delete(other);
  }
  nextCollapsed.delete(id);
  nextExpanded.add(id);

  const result: PromoteResult = { depthLimit: nextDepthLimit, collapsed: nextCollapsed, expanded: nextExpanded };
  return commitView(state, promoteIfLayerExpanded(state, result) || result);
}

export interface ViewSnapshotOut {
  depthLimit: number;
  selectedNodeId: string | null;
  collapsedNodeIds: string[];
  expandedNodeIds: string[];
  outlineCollapsedNodeIds: string[];
  multiSelectedNodeIds: string[];
}

// 拍一整套视图态快照（撤销 capture / 切文档保留视图共用）。Set → 数组，便于存入撤销 token 或跨文档迁移。
// 字段名对齐现有 editorHistoryViewState（selectedNodeId / collapsedNodeIds …），撤销 token 可直接喂 applyViewSnapshot。
export function snapshotView(state: Session): ViewSnapshotOut {
  const v = state.view;
  return {
    depthLimit: v.depthLimit,
    selectedNodeId: v.selectedId,
    collapsedNodeIds: [...v.collapsed],
    expandedNodeIds: [...v.expanded],
    outlineCollapsedNodeIds: [...v.outlineCollapsed],
    multiSelectedNodeIds: [...v.multiSelected]
  };
}

// patch 各字段与当前 view 逐一等价（Set 比内容、标量比值）即无实质变化。
function viewPatchUnchanged(view: SessionView, patch: Partial<SessionView>): boolean {
  for (const key of Object.keys(patch) as Array<keyof SessionView>) {
    const next = patch[key];
    const cur = view[key];
    if (next instanceof Set || cur instanceof Set) {
      if (!(cur instanceof Set) || !(next instanceof Set) || cur.size !== next.size) return false;
      for (const item of next) if (!cur.has(item)) return false;
    } else if (cur !== next) {
      return false;
    }
  }
  return true;
}

// 应用一整套视图态快照（撤销 restore / 切文档保留视图）。只设 snapshot 显式给出的字段，缺省保留现状。
// 无实质变化返回原 state（不 bump）——与 setDepthLimit/selectNode 一致，调用方据引用是否变化决定是否重投影，
// 避免「写入未改变视图也造新 session → project 造新 currentDoc → 派生回调 churn → 依赖回调的 effect 重跑」的无谓回环。
export function applyViewSnapshot(state: Session, snapshot: ViewSnapshot = {}): Session {
  const patch: Partial<SessionView> = {};
  if (snapshot.depthLimit !== undefined) patch.depthLimit = clampDepth(snapshot.depthLimit, maxDepthOf(state));
  if (snapshot.selectedNodeId !== undefined) patch.selectedId = normalizeId(snapshot.selectedNodeId);
  if (snapshot.collapsedNodeIds !== undefined) patch.collapsed = idSet(snapshot.collapsedNodeIds);
  if (snapshot.expandedNodeIds !== undefined) patch.expanded = idSet(snapshot.expandedNodeIds);
  if (snapshot.outlineCollapsedNodeIds !== undefined) patch.outlineCollapsed = idSet(snapshot.outlineCollapsedNodeIds);
  if (snapshot.multiSelectedNodeIds !== undefined) patch.multiSelected = idSet(snapshot.multiSelectedNodeIds);
  if (viewPatchUnchanged(state.view, patch)) return state;
  return commitView(state, patch);
}

// 把 L3 镜像投影成现有渲染吃的兼容形状 { tree(嵌套), idByAddress, depthStats }——与
// mindmap-utils.buildTreeWithIndex 同形（node 都是 toTreeNode + children + address）。这是
// 渲染层切到 L5 视图模型之前的过渡桥：扩散加载下 tree 是「已加载的那部分」，未加载子树缺位。
// 迭代组装（不递归）避免极深树爆栈；address 用 ingest 时按真实位置存的值，不重算。
export function projectToLegacyDoc(state: Session): LegacyDocProjection {
  const root = state.index.root;
  if (!root) return { tree: null, idByAddress: {}, depthStats: { maxDepth: 1, depths: [1] } };

  type NestedTreeNode = TreeNode & { children: NestedTreeNode[] };
  const cloneNode = (node: TreeNode): NestedTreeNode => ({ ...node, children: [] });
  const tree = cloneNode(root);
  const idByAddress: Record<string, string> = {};
  const depths = new Set<number>();
  let maxDepth = 1;

  const stack: NestedTreeNode[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const address = node.address || '1';
    idByAddress[address] = node.id;
    const depth = address.split('-').length;
    depths.add(depth);
    if (depth > maxDepth) maxDepth = depth;
    const childRows = state.index.childrenOf.get(node.id) || [];
    node.children = childRows.map(cloneNode);
    for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push(node.children[i]);
  }

  return {
    tree,
    idByAddress,
    depthStats: { maxDepth, depths: [...depths].sort((a, b) => a - b) }
  };
}
