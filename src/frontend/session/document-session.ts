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

import { buildTreeIndex, getDescendants, patchNode, removeNode, sameTreeNodeFields, toTreeNode, type TreeIndex, type TreeNode } from '../../core/node-model.js';
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
  // C2D 思维导图的展开列集（address 键，组件语义即 address；不随后端持久化，恢复走组件的
  // localStorage hotspot 机制）。收编进 view 的动机：驱逐的渲染依赖集必须看得见导图可见性。
  c2dExpanded: Set<string>;
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
  // 后端权威树深（doc.get 的 treeDepthStats.maxDepth；0=未知）。深度 clamp 的天花板用它而非
  // 已加载最大深度——扩散加载初期/驱逐后已加载区变浅，不能把用户持久化的 depthLimit 夹低。
  claimedMaxDepth: number;
  // 已加载区最大深度（ingest 时增量维护的 running max，只增不缩）：maxDepthOf 不再每次全扫 byId。
  // 驱逐后不缩——它只是 claimedMaxDepth（后端权威）未知时的 fallback 天花板，偏高方向与
  // 「不把用户持久化的 depthLimit 夹低」的设计意图同向（旧全扫在驱逐后反而偏低）。
  loadedMaxDepth: number;
  // 子树版本号（结构共享投影的早停判据）：任何内容变更（行替换/子列表变更/删除/驱逐）沿祖先链
  // bump——不变量：子树内任何变化 ⇒ 其根版本号变。投影复用旧节点当且仅当版本号与行引用皆同。
  // 原地可变（与 loadedParents/childPages 同风格），只在 ingest/reconcile/evict 路径写。
  // 条目只增不删（被驱逐/删除节点的版本残留），单条极小；换文档时随 createSession 重建清零。
  subtreeVersions: Map<string, number>;
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
  c2dExpandedAddresses?: string[];
  multiSelectedNodeIds?: string[];
}

export interface LegacyDocProjection {
  tree: (TreeNode & { children: TreeNode[] }) | null;
  idByAddress: Record<string, string>;
  depthStats: { maxDepth: number; depths: number[] };
  // 内部：下次投影的复用索引（id → 上次投影节点）。对外消费方不使用。
  nodeById?: Map<string, NestedTreeNode>;
}

// 投影节点 = TreeNode & children + 结构共享标记（来自的 session 行引用 / 投影时的子树版本号）。
// 复用判据：行引用同 ∧ 版本号同 ⇒（版本不变量：子树内任何变化 ⇒ 根版本变）整棵子树内容相同。
type NestedTreeNode = TreeNode & {
  children: NestedTreeNode[];
  __source?: TreeNode;
  __version?: number;
};

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
    claimedMaxDepth: 0,
    loadedMaxDepth: 0,
    subtreeVersions: new Map<string, number>(),
    view: {
      depthLimit: 1,
      collapsed: new Set<string>(),
      expanded: new Set<string>(),
      outlineCollapsed: new Set<string>(),
      c2dExpanded: new Set<string>(),
      selectedId: null,
      multiSelected: new Set<string>()
    }
  };
}

// 设后端权威树深（loadComplete 从 doc.get 的 treeDepthStats 喂入）。
export function setClaimedMaxDepth(state: Session, value: unknown): Session {
  const next = Math.max(0, Math.floor(Number(value) || 0));
  if (next === state.claimedMaxDepth) return state;
  return bump({ ...state, claimedMaxDepth: next });
}

function bump(state: Session): Session {
  return { ...state, loadSeq: state.loadSeq + 1 };
}

// 把一批节点行并入 index（byId / byAddress），不碰 childrenOf 排序——那留给 reorderChildren。
// outlineCollapsed 传入时维护 Outline 默认折叠不变量：新并入（此前不在镜像）的「深度≥2 且声称
// 有子」节点默认折叠，与 doc-utils.defaultCollapsedOutlineIds 同口径。必须在 ingest 时增量做——
// 打开文档时一次性算默认集只覆盖首批投影，后台预取源源并入的深层节点若不折叠，Outline 渲染
// 与驱逐保护集都会随预取膨胀到全量。原地 add（只增不换引用）：ingest 高频，clone Set 是 O(集合)；
// 视图动词换引用的约定不变，这里是加载动词维护默认值的唯一豁免。
function upsertNodes(index: TreeIndex, rows: unknown[], outlineCollapsed?: Set<string>): TreeNode[] {
  const nodes: TreeNode[] = [];
  for (const row of rows) {
    const node = toTreeNode(row as Record<string, unknown> | null);
    if (!node) continue;
    const prev = index.byId.get(node.id);
    if (prev?.address && prev.address !== node.address) index.byAddress.delete(prev.address);
    if (!prev && outlineCollapsed && node.childCount > 0
      && (node.address ? node.address.split('-').length : 1) >= 2) {
      outlineCollapsed.add(node.id);
    }
    // 全字段相同 → 复用旧引用（结构共享投影的不变量：引用相同 ⇒ 内容相同）。
    if (prev && sameTreeNodeFields(prev, node)) {
      nodes.push(prev);
      continue;
    }
    index.byId.set(node.id, node);
    if (node.address) index.byAddress.set(node.address, node);
    nodes.push(node);
  }
  return nodes;
}

// 替换式更新单个节点对象（byId/byAddress/父的子列表/root 四处同步）。childCount 校准等
// 场景禁止原地 mutate——「引用相同 ⇒ 内容相同」不变量一旦破坏，结构共享投影会复用到陈旧内容。
function replaceNodeObject(index: TreeIndex, next: TreeNode): void {
  const prev = index.byId.get(next.id);
  if (!prev || prev === next) return;
  index.byId.set(next.id, next);
  if (next.address) index.byAddress.set(next.address, next);
  const siblings = index.childrenOf.get(next.parentId ?? null);
  if (siblings) {
    const at = siblings.findIndex((node) => node.id === next.id);
    if (at >= 0) siblings[at] = next;
  }
  if (index.root?.id === next.id) index.root = next;
}

// 重建某 parent 的 childrenOf（合并已有 + 本批并入，按 sortOrder 稳定排序）。
// incoming = 本批 upsert 的行（调用方保证是 listChildren(parentId) 的返回）。原先每并入一页就
// 全扫 index.byId 找该 parent 的子——扩散加载 N 节点需 N/页 次全扫，O(N²/页)（20 万节点 ≈ 1.3 亿次
// 迭代）。incoming 已经就是这批子行，合并 existing + incoming 即可；parentId 防御性过滤保数据异常
// 时不把异父行混进来（与旧全扫的过滤效果一致）。
function reorderChildren(index: TreeIndex, parentId: string, incoming: TreeNode[] = []): TreeNode[] {
  const existing = index.childrenOf.get(parentId) || [];
  const merged = new Map<string, TreeNode>(existing.map((node) => [node.id, node]));
  for (const node of incoming) {
    if (node.parentId === parentId) merged.set(node.id, node);
  }
  const list = [...merged.values()].sort(
    (a, b) => a.sortOrder - b.sortOrder || String(a.id).localeCompare(String(b.id))
  );
  // 逐元素引用全同 → 保留旧数组引用（结构共享的早停判据之一就是子列表引用）。
  if (list.length === existing.length && list.every((node, i) => node === existing[i])) return existing;
  index.childrenOf.set(parentId, list);
  return list;
}

// ingest 时增量维护已加载最大深度（running max，只增不缩；驱逐后不缩见 Session.loadedMaxDepth 注释）。
function trackLoadedMaxDepth(state: Session, nodes: TreeNode[]): void {
  for (const node of nodes) {
    const depth = node.address ? node.address.split('-').length : 1;
    if (depth > state.loadedMaxDepth) state.loadedMaxDepth = depth;
  }
}

// 子树版本 bump：从 nodeId 沿 parentId 祖先链逐级 +1。任何内容变更入口都必须调它
// （ingest/reconcile/evict），漏一个入口 = 结构共享投影复用到陈旧内容。在删除类操作之前调
// （删完后被删节点从 byId 消失，链从仍存在的节点起算即可）。
function bumpSubtreeChain(state: Session, nodeId: string | null): void {
  let cursor = nodeId ? state.index.byId.get(nodeId) : undefined;
  while (cursor) {
    state.subtreeVersions.set(cursor.id, (state.subtreeVersions.get(cursor.id) || 0) + 1);
    cursor = cursor.parentId ? state.index.byId.get(cursor.parentId) : undefined;
  }
}

// 打开文档第一步：并入根节点（root 不是任何 parent 的子，单独拿）。
export function ingestRoot(state: Session, rootRow: unknown): Session {
  const [root] = upsertNodes(state.index, [rootRow]);
  if (root) state.index.root = root;
  state.index.size = state.index.byId.size;
  trackLoadedMaxDepth(state, root ? [root] : []);
  if (root) bumpSubtreeChain(state, root.id);
  return bump(state);
}

// 并入某 parent 的一窗子节点（listChildren 结果）。永驻只增。
export function ingestChildren(state: Session, patch: IngestChildrenPatch = {}): Session {
  const parentId = normalizeId(patch.parentId);
  if (parentId == null) return state;
  // 孤儿闸：parent 行必须已在镜像里（root 经 ingestRoot 先行，合法 ingest 的 parent 必然先到）。
  // 驱逐与在途 fetch 交错时，祖先已被级联卸载的迟到结果直接丢弃——否则写进从根不可达的
  // 孤儿行：计入窗口 W、planEvictions 又摸不到（byId 查不到 parent 即跳过），成为驱不掉的泄漏。
  if (!state.index.byId.has(parentId)) return state;
  const rows = Array.isArray(patch.rows) ? patch.rows : [];
  const index = state.index;
  const incoming = upsertNodes(index, rows, state.view.outlineCollapsed);
  const children = reorderChildren(index, parentId, incoming);
  index.size = index.byId.size;
  trackLoadedMaxDepth(state, incoming);

  const total = Number.isFinite(Number(patch.total)) ? Number(patch.total) : children.length;
  const offset = Math.max(0, Math.floor(Number(patch.offset) || 0));
  // loaded =「已按页取到的连续前缀长度」，不是 childrenOf 的元素数。二者在纯分页路径上相等，
  // 但 ingestPath 会把祖先链上的那一个子先塞进 childrenOf（它可能落在第 N 页），此时
  // children.length 虚高一位，下一页的 offset（= loaded）就会跳过一条真兄弟，留下补不回的空洞。
  // 取「上一次记录的前缀」与「本页末端」的较大者：顺序取页时等价于旧式 children.length，
  // 重复取已取过的页也不会把前缀缩回去。
  const prevLoaded = state.childPages.get(parentId)?.loaded ?? 0;
  const loaded = Math.max(prevLoaded, offset + rows.length);
  const hasMore = patch.hasMore === true ? true : loaded < total;
  state.childPages.set(parentId, { loaded, total, hasMore });
  state.loadedParents.add(parentId);

  // 校准 parent 的「声称 childCount」——后端 total 比建索引时的旧值权威。替换式更新（不变量见 replaceNodeObject）。
  const parent = index.byId.get(parentId);
  if (parent && total > (parent.childCount || 0)) replaceNodeObject(index, { ...parent, childCount: total });
  bumpSubtreeChain(state, parentId);
  return bump(state);
}

export interface IngestPathPatch {
  // 后端 node.ancestors 的 rows：根 → 目标节点的整条链（含目标自身），行格式同 listChildren。
  rows?: unknown[];
}

// 并入「根 → 某节点」的祖先链（定位到尚未加载 / 已被驱逐的节点时用）。
//
// 与 ingestChildren 的根本区别：链上每个父只带来「通往目标的那一个子」，不是它的完整子列表。
// 所以本动词：
//   · 把整条链 upsert 进 byId/byAddress，并把每一环挂到父的 childrenOf 上——投影因此能从根走到
//     目标（selectedNode / findNode 立刻可见），这是定位能成立的前提；
//   · 绝不写 loadedParents / childPages——链上的父在取数口径上仍是「声称有子、子列表没拉」的
//     边界，planHotFetches/nextBackgroundFetch 照常给它们排分页请求，缺的兄弟随后按页补齐
//     （childPages.loaded 的连续前缀语义见 ingestChildren 内注释）；
//   · 不碰驱逐语义：链上的父不在 loadedParents，planEvictions 扫不到它们（也就驱不掉这一条链），
//     但祖先整棵被驱逐时 removeNode 沿 childrenOf 级联，链会随之消失——不留不可达孤儿。
//     调用方随后会把焦点/选中落到目标上，焦点祖先链本就受 planEvictions 保护。
// 行序不作要求：先整批 upsert 再逐条接父子链接，父行与子行同批到达也能接上。
export function ingestPath(state: Session, patch: IngestPathPatch = {}): Session {
  const rows = Array.isArray(patch.rows) ? patch.rows : [];
  if (rows.length === 0) return state;
  const candidates: TreeNode[] = [];
  for (const row of rows) {
    const node = toTreeNode(row as Record<string, unknown> | null);
    if (node) candidates.push(node);
  }
  if (candidates.length === 0) return state;

  // 孤儿闸（与 ingestChildren 同规）：每一环都要么自己就是本文档的根、要么父在本批或已在镜像里。
  // 断链 / 跨文档的批次整批丢弃——写进去就是从根不可达的行：计入窗口 W，planEvictions 又扫不到。
  const incomingIds = new Set(candidates.map((node) => node.id));
  const rooted = candidates.every((node) => (node.parentId == null
    ? (!state.index.root || state.index.root.id === node.id)
    : incomingIds.has(node.parentId) || state.index.byId.has(node.parentId)));
  if (!rooted) return state;

  const index = state.index;
  // upsert 前记下已在镜像的那些环的旧父：链给的是权威位置，若与镜像不符（分支投影里被
  // reparent、或主干结构写后镜像还没对账），必须把它从旧父的子列表摘掉——否则同一个 id
  // 新旧两处都挂着，投影里出现重影。
  const prevParentOf = new Map<string, string | null>();
  for (const node of candidates) {
    const prev = index.byId.get(node.id);
    if (prev) prevParentOf.set(node.id, prev.parentId);
  }

  const incoming = upsertNodes(index, rows, state.view.outlineCollapsed);
  let deepest: TreeNode | null = null;
  for (const node of incoming) {
    const prevParent = prevParentOf.get(node.id);
    if (prevParent != null && prevParent !== node.parentId) {
      const siblings = index.childrenOf.get(prevParent);
      const at = siblings ? siblings.findIndex((sibling) => sibling.id === node.id) : -1;
      if (siblings && at >= 0) siblings.splice(at, 1);
      bumpSubtreeChain(state, prevParent); // 旧父的子树内容变了，版本必须跟着动（结构共享早停的前提）
    }
    if (node.parentId == null) {
      // 链首就是文档根：镜像还没有根（定位早于 ingestRoot 的极端时序）时补上，已有则不动。
      if (!index.root) index.root = node;
    } else {
      reorderChildren(index, node.parentId, [node]);
    }
    if (!deepest || nodeDepth(node) > nodeDepth(deepest)) deepest = node;
  }
  index.size = index.byId.size;
  trackLoadedMaxDepth(state, incoming);
  // 链尾（最深的一环）= 目标节点；bumpSubtreeChain 从它沿父链上溯，整条链的子树版本一次带到。
  if (deepest) bumpSubtreeChain(state, deepest.id);
  return bump(state);
}

// 节点深度：address 优先（ingest 时按真实位置存），缺失时退回行自带的 depth。
function nodeDepth(node: TreeNode): number {
  return node.address ? node.address.split('-').length : Math.max(1, Number(node.depth) || 1);
}

// 内容写回填：单节点 patch（node.update 返回的 kind:'node' 单行结果）。委托 node-model.patchNode
// 统一处理 byId/byAddress/childrenOf 迁移与 root 更新（含单节点 parentId 变化的兄弟迁移），
// 不另写一套索引维护。只回填已加载节点；子树 move/删导致后代 address 全变的结构写不归这里
// （走 reloadStructuralChange 重取受影响子树）。
export function reconcileNode(state: Session, row: { id?: unknown; [extra: string]: unknown } | null | undefined): Session {
  const id = normalizeId(row?.id);
  if (id == null || !state.index.byId.has(id)) return state; // 只回填已加载节点，不新增孤儿
  const prevParentId = state.index.byId.get(id)?.parentId ?? null;
  patchNode(state.index, row as Parameters<typeof patchNode>[1]);
  // 版本 bump：新旧父链都兜（patchNode 可能发生单节点 parentId 迁移）。
  bumpSubtreeChain(state, id);
  if (prevParentId && prevParentId !== (state.index.byId.get(id)?.parentId ?? null)) {
    bumpSubtreeChain(state, prevParentId);
  }
  return bump(state);
}

// 结构写回填：用后端权威子列表 replace 某 parent 的 children（不是 merge——结构写 address 全变）。
// 在现有 session 上增量更新，不丢其它已加载节点：删掉旧 children 里不在新列表的（move 走/删除，
// removeNode 级联清其子树）、upsert 留下的（迁移新 address）、加入新增的，再按 sortOrder 重排。
// runWrite 对受影响的每个 parent（目标 + move 的源）各调一次。
export function reconcileChildren(state: Session, patch: IngestChildrenPatch = {}): Session {
  const parentId = normalizeId(patch.parentId);
  if (parentId == null) return state;
  // 孤儿闸（与 ingestChildren 同规）：本函数语义是「结构写后重取」，parent 必然已加载；
  // 迟到/错代的调用（await 期间换文档、祖先被驱逐）直接丢弃，不把孤儿行写进镜像。
  if (!state.index.byId.has(parentId)) return state;
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
  const incoming = upsertNodes(index, rows);
  reorderChildren(index, parentId, incoming);
  index.size = index.byId.size;
  trackLoadedMaxDepth(state, incoming);

  const loaded = (index.childrenOf.get(parentId) || []).length;
  const total = Number.isFinite(Number(patch.total)) ? Number(patch.total) : loaded;
  state.childPages.set(parentId, { loaded, total, hasMore: patch.hasMore === true ? true : loaded < total });
  state.loadedParents.add(parentId);
  const parent = index.byId.get(parentId);
  if (parent && parent.childCount !== total) replaceNodeObject(index, { ...parent, childCount: total });
  bumpSubtreeChain(state, parentId);
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

// ─── 投影窗口 W 与驱逐（frontend-refactor.md §5 方案 II，阶段 4） ────────────────
// 驱逐 = 逆 ingestChildren：卸载某 parent 的整个已加载子树（parent 行自身保留，childCount
// 「声称」不动）→ 该 parent 回到「声称有子但未拉取」的取数边界态，再次访问经现有扩散加载
// 重取，零新回源机制。node id 稳定，view 里指向被驱逐节点的 collapsed/expanded/selected
// 记录原样保留，重载后自动重新生效——驱逐对视图态透明。
// 只读驱逐（§5.5）：编辑模式不驱逐由调用方（useDocumentState.maybeEvict）把关，
// 被驱逐节点必然干净、无需回写。

// W 静态保守值起步（§7：先 ~20 万节点，后续按机器内存自适应）。
export const DEFAULT_EVICT_WINDOW = 200_000;

export function loadedNodeCount(state: Session): number {
  return state.index.byId.size;
}

// 卸载某 parent 的已加载子树。未加载或无已加载子返回原引用（不 bump）。
export function evictChildren(state: Session, parentId: unknown): Session {
  const id = normalizeId(parentId);
  if (id == null || !state.loadedParents.has(id)) return state;
  const index = state.index;
  const children = [...(index.childrenOf.get(id) || [])];
  if (children.length === 0) return state;
  bumpSubtreeChain(state, id); // 先 bump（删除后子节点从 byId 消失，链从 id 起算不受影响）
  for (const child of children) removeNode(index, child.id); // 级联清子树 + byAddress + childrenOf
  index.childrenOf.delete(id);
  index.size = index.byId.size;
  state.loadedParents.delete(id);
  state.childPages.delete(id);
  // 级联删掉的后代里可能有已加载 parent，其 loadedParents/childPages 记录一并清理，
  // 否则 fetchBoundaryOf 会把「幽灵已加载」当非边界、该子树永远取不回来。
  for (const pid of [...state.loadedParents]) {
    if (!index.byId.has(pid)) {
      state.loadedParents.delete(pid);
      state.childPages.delete(pid);
    }
  }
  return bump(state);
}

// 「其子应被渲染」的节点集 = 三个同时挂载的视图（display 切换、不卸载）各自可见性的并集，
// 与渲染层同源（§5.4：渲染依赖集 ⊆ 投影窗口）：
//   主树视图：(depthLimit 内默认展开) ⊕ collapsed 盖掉浅层 ⊕ expanded 盖掉深层；
//   Outline 面板：无 depthLimit，仅 outlineCollapsed（默认折叠深度≥2 有子节点，ingest 增量维护）；
//   C2D 思维导图：root 列恒显 + c2dExpanded（address 键）各开一列。祖先收起的展开项也保护——
//   9-2-7 语义要求父级再展开时内部状态自动还原，还原的前提是数据还在。
function childrenVisibleSet(state: Session): Set<string> {
  const out = new Set<string>();
  const root = state.index.root;
  if (!root) return out;
  const view = state.view;
  const stack: TreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const depth = node.address ? node.address.split('-').length : 1;
    const childrenVisible = !view.collapsed.has(node.id) && (depth < view.depthLimit || view.expanded.has(node.id));
    if (!childrenVisible) continue;
    out.add(node.id);
    for (const child of state.index.childrenOf.get(node.id) || []) stack.push(child);
  }
  const outlineStack: TreeNode[] = [root];
  while (outlineStack.length > 0) {
    const node = outlineStack.pop()!;
    if (view.outlineCollapsed.has(node.id)) continue;
    out.add(node.id);
    for (const child of state.index.childrenOf.get(node.id) || []) outlineStack.push(child);
  }
  out.add(root.id);
  for (const address of view.c2dExpanded) {
    const node = state.index.byAddress.get(address);
    if (node) out.add(node.id);
  }
  return out;
}

function addressSegments(address: string | null | undefined): string[] {
  return String(address || '1').split('-');
}

function commonPrefixLen(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

// 驱逐候选（只计划不执行）：loadedParents 中「子不可见、不在焦点/选中祖先链、有已加载子」的
// parent，按离焦点最远（地址公共前缀短）优先、同距离深层优先（先卸叶子层）排序。
// 不变量 1（§5.4）：可见子树 + 焦点/选中祖先链 = 渲染依赖集，永不出现在候选里。
export function planEvictions(state: Session, options: { protectIds?: Iterable<unknown> } = {}): string[] {
  const visible = childrenVisibleSet(state);
  const protect = new Set<string>();
  for (const raw of options.protectIds || []) {
    const id = normalizeId(raw);
    if (id) protect.add(id);
  }
  const protectChain = (startId: string | null) => {
    let cursor: TreeNode | null | undefined = startId ? state.index.byId.get(startId) : null;
    while (cursor) {
      protect.add(cursor.id);
      cursor = cursor.parentId ? state.index.byId.get(cursor.parentId) : null;
    }
  };
  protectChain(state.focusId);
  protectChain(state.view.selectedId);
  for (const id of state.view.multiSelected) protectChain(id);

  const focusNode = state.focusId ? state.index.byId.get(state.focusId) : null;
  const focusSegments = addressSegments(focusNode?.address || state.index.root?.address);
  const candidates: Array<{ id: string; distance: number; depth: number }> = [];
  for (const parentId of state.loadedParents) {
    if (visible.has(parentId) || protect.has(parentId)) continue;
    const node = state.index.byId.get(parentId);
    if (!node) continue;
    if ((state.index.childrenOf.get(parentId)?.length || 0) === 0) continue;
    const segments = addressSegments(node.address);
    candidates.push({
      id: parentId,
      distance: commonPrefixLen(segments, focusSegments),
      depth: segments.length
    });
  }
  candidates.sort((a, b) => a.distance - b.distance || b.depth - a.depth);
  return candidates.map((candidate) => candidate.id);
}

// 驱逐至窗口以内。≤ limit 直接返回原引用——文档不超窗口时驱逐路径完全不跑，
// (II) 在小文档下逐字节等同全量物化 (I)（§5.7 不分档）。
// maxEvictions 节流单轮工作量（低优先级空闲任务，不做长任务）。
export function evictToWindow(
  state: Session,
  options: { limit?: number; protectIds?: Iterable<unknown>; maxEvictions?: number } = {}
): Session {
  const limit = Math.max(1, Math.floor(Number(options.limit) || DEFAULT_EVICT_WINDOW));
  if (state.index.byId.size <= limit) return state;
  const maxEvictions = Math.max(1, Math.floor(Number(options.maxEvictions) || 64));
  const plan = planEvictions(state, { protectIds: options.protectIds });
  let next = state;
  let evicted = 0;
  for (const parentId of plan) {
    if (next.index.byId.size <= limit || evicted >= maxEvictions) break;
    const after = evictChildren(next, parentId);
    if (after !== next) evicted += 1; // 已被前序级联卸掉的候选是空操作，不计数
    next = after;
  }
  return next;
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

// address 键集合（C2D 展开列）：归一化口径与 id 相同（非空字符串），单独具名以示键型不同。
const addressSet = idSet;

function depthOfId(state: Session, id: string): number {
  const node = state.index.byId.get(id);
  return node?.address ? node.address.split('-').length : 1;
}

function hasChildrenById(state: Session, id: string): boolean {
  const node = state.index.byId.get(id);
  if (!node) return false;
  return node.childCount > 0 || (state.index.childrenOf.get(id)?.length || 0) > 0;
}

// 树深天花板（深度调节与 promote 的 clamp 都用它）：后端权威深度（claimedMaxDepth，loadComplete
// 喂入）优先；未知时退回已加载最大深度标量（ingest 时增量维护）。不再每次全扫 byId——旧实现
// 在 toggleCollapsed/expandOneLevel/setDepthLimit 等视图动词上都是 O(N) 全表扫。
export function maxDepthOf(state: Session): number {
  return Math.max(1, state.claimedMaxDepth, state.loadedMaxDepth);
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
  c2dExpandedAddresses: string[];
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
    c2dExpandedAddresses: [...v.c2dExpanded],
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
  if (snapshot.c2dExpandedAddresses !== undefined) patch.c2dExpanded = addressSet(snapshot.c2dExpandedAddresses);
  if (snapshot.multiSelectedNodeIds !== undefined) patch.multiSelected = idSet(snapshot.multiSelectedNodeIds);
  if (viewPatchUnchanged(state.view, patch)) return state;
  return commitView(state, patch);
}

// 把 L3 镜像投影成现有渲染吃的兼容形状 { tree(嵌套), idByAddress, depthStats }——与
// mindmap-utils.buildTreeWithIndex 同形（node 都是 toTreeNode + children + address）。这是
// 渲染层切到 L5 视图模型之前的过渡桥：扩散加载下 tree 是「已加载的那部分」，未加载子树缺位。
// 迭代组装（不递归）避免极深树爆栈；address 用 ingest 时按真实位置存的值，不重算。
//
// 结构共享（prev 传入时）：每节点先查「prevNode.__source === node && prevNode.__version === 当前子树版本」，
// 命中即复用旧投影节点、不进栈——变化路径外的子树零对象重建、引用稳定（对象复用是 O(1) 早停；
// idByAddress/nodeById/depths 的收录仍要遍历复用子树，O(子树) 但只读引用、不建对象）。
// 版本号不变量（见 bumpSubtreeChain）：子树内任何变化 ⇒ 根版本号变，故版本同 ⇒ 复用安全。
// 下游所有 useMemo([tree]) / 卡片 memo 因此在「无变化 project」下全部命中；
// 原先每次 project（含每个预取页）全量 clone 出新对象图，下游缓存被尽数击穿。
export function projectToLegacyDoc(state: Session, prev?: LegacyDocProjection | null): LegacyDocProjection {
  const root = state.index.root;
  if (!root) return { tree: null, idByAddress: {}, depthStats: { maxDepth: 1, depths: [1] } };
  const prevById = prev?.nodeById;
  const versionOf = (id: unknown): number => state.subtreeVersions.get(String(id)) || 0;

  const reuseFor = (node: TreeNode): NestedTreeNode | null => {
    const prevNode = prevById?.get(node.id);
    if (prevNode && prevNode.__source === node && prevNode.__version === versionOf(node.id)) {
      return prevNode;
    }
    return null;
  };

  // 整树未变快路径：连 idByAddress/depthStats/nodeById 一起复用。
  const rootReuse = reuseFor(root);
  if (rootReuse && prev) {
    return { tree: rootReuse, idByAddress: prev.idByAddress, depthStats: prev.depthStats, nodeById: prev.nodeById };
  }

  const idByAddress: Record<string, string> = {};
  const nodeById = new Map<string, NestedTreeNode>();
  const depths = new Set<number>();
  let maxDepth = 1;

  // 复用子树的索引收录：只读引用收进 idByAddress/nodeById/depths，不建对象。
  const collectReused = (projected: NestedTreeNode) => {
    const reusedStack: NestedTreeNode[] = [projected];
    while (reusedStack.length > 0) {
      const node = reusedStack.pop()!;
      nodeById.set(node.id, node);
      const address = node.address || '1';
      idByAddress[address] = node.id;
      const depth = address.split('-').length;
      depths.add(depth);
      if (depth > maxDepth) maxDepth = depth;
      for (let i = node.children.length - 1; i >= 0; i -= 1) reusedStack.push(node.children[i]!);
    }
  };

  const tree: NestedTreeNode = { ...root, children: [], __source: root, __version: versionOf(root.id) };
  const stack: NestedTreeNode[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    nodeById.set(node.id, node);
    const address = node.address || '1';
    idByAddress[address] = node.id;
    const depth = address.split('-').length;
    depths.add(depth);
    if (depth > maxDepth) maxDepth = depth;
    const childRows = state.index.childrenOf.get(node.id) || [];
    node.children = new Array<NestedTreeNode>(childRows.length);
    for (let i = childRows.length - 1; i >= 0; i -= 1) {
      const child = childRows[i]!;
      const reused = reuseFor(child);
      if (reused) {
        node.children[i] = reused;
        collectReused(reused);
      } else {
        const projected: NestedTreeNode = { ...child, children: [], __source: child, __version: versionOf(child.id) };
        node.children[i] = projected;
        stack.push(projected);
      }
    }
  }

  return {
    tree,
    idByAddress,
    nodeById,
    depthStats: { maxDepth, depths: [...depths].sort((a, b) => a - b) }
  };
}
