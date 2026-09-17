// 内容寻址对象库（第 4 步 git 对象模型）。
// commit 存根节点 id + 根 tree 的 hash；节点内容（blob）与子树结构（tree）按 hash 去重存进 objects 表。
// blob 用 merkle 的 contentHash（纯内容、位置无关，相同正文跨 commit 跨文档只存一份）；tree 指纹用本文件的
// treeObjectHash（含 node id，见下方「为何 tree 指纹要含 id」），与 merkle 的 subtreeHashFrom 刻意分开。
//
// 两层对象，对齐 git：
//   blob = 单节点内容（merkle CONTENT_FIELDS 5 字段：text/node_title/node_note/node_type/trust_level）
//   tree = { blob_hash, children: [{ id, tree_hash }, ...按 sort_order] }
// node id 存在父 tree 的 children 里（挂在谁下面），不进 blob——id 是位置/结构，不是内容身份。
// 故同内容不同 id（合并/收敛）共用 blob；id 不同体现在各自父节点的 tree。
//
// 根节点没有父 tree，其 id 无处安放——对齐 git（根 tree 无名，由 commit 指向）：
// commit 表存 root_node_id + root_tree_hash 并列，根 id 由 commit 直接指向，restore 时从 commit 取。
//
// created_at / updated_at 不进对象库（第 4 步边界：只追踪子树结构 + 正文）。
//
// 句位（span→node 归属 + nodes.source_position）走**第三类对象** spanmap，由 commit 的
// span_map_hash 单独指向——不进 blob、不进 tree 指纹。早先这里写的是「句位真相由 source_spans 表
// 承载（用 node_id 直挂），restore 时跟着回，不受影响」，那句话与实际行为相反：restoreSnapshot
// 只能把「恢复前 live 的链接」里节点仍在快照中的那部分挂回，拆句后回滚到拆句前，span 的 node_id
// 永久变 NULL。现在归属随 commit 一起内容寻址，restore/revert/undo/redo 到任意带 span_map_hash 的
// commit 都精确还原该 commit 时代的归属。
// 刻意不并进 tree 指纹的理由：source_spans 的写入不触发 nodes 的 hash 失效触发器，
// writeTreeIncremental 会剪掉「归属变、内容不变」的子树而写出错误指纹；且归属并进 contentHash
// 会让「同正文、不同原文出处」的节点不再共享 blob，废掉重复段落的去重。

import { contentHash, sha256_128 } from '../../core/merkle.js';
import type { MerkleNode } from '../../core/merkle.js';
import type { CommitRow, ObjectRow, SourceDocumentRow } from './rows.js';

type DbLike = {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
    all<T = Record<string, unknown>>(...params: unknown[]): T[];
  };
};
// object-store 处理的是「构造出来的部分节点」（blob 内容字段 + id/parent/sort 等结构字段），不是整表
// NodeRow——正对应 merkle 的松节点形状 MerkleNode（带 id + 索引签名），故 contentHash 可直接吃。
type NodeObjectRow = MerkleNode;
type ObjectTree = { blob_hash?: string; children?: Array<{ id: string; tree_hash: string }> };

// blob 内容字段（与 merkle CONTENT_FIELDS 对齐，顺序固定）。
const BLOB_FIELDS = ['text', 'node_title', 'node_note', 'node_type', 'trust_level'];

function blobData(node: NodeObjectRow) {
  const data: Record<string, unknown> = {};
  for (const field of BLOB_FIELDS) {
    data[field] = node[field] ?? '';
  }
  return data;
}

// writeBlob 的 INSERT 语句连接级缓存：better-sqlite3 无自动语句缓存，函数内 prepare 会在
// 每节点循环里各编译一次（保存路径 N 节点 = N 次编译）。WeakMap 按连接持 statement，随连接回收。
const blobInsertStmts = new WeakMap<DbLike, ReturnType<DbLike['prepare']>>();

// 写单节点内容对象。contentHash 当 blob key，已存在则跳过（INSERT OR IGNORE 天然去重）。
export function writeBlob(db: DbLike, node: NodeObjectRow) {
  const hash = contentHash(node);
  let stmt = blobInsertStmts.get(db);
  if (!stmt) {
    stmt = db.prepare('INSERT OR IGNORE INTO objects (hash, kind, data) VALUES (?, ?, ?)');
    blobInsertStmts.set(db, stmt);
  }
  stmt.run(hash, 'blob', JSON.stringify(blobData(node)));
  return hash;
}

interface CommitSnapshotInput {
  doc?: unknown;
  axioms?: unknown[];
  refs?: unknown[];
  // 只读 source_type/original_path/created_at（均带 ?? null 兜底）；用 Partial 容纳存量迁移那种
  // 只带 raw_markdown 的精简 sourceDocument。
  sourceDocument?: Partial<SourceDocumentRow> | null;
}

// commit 的内联 meta（doc / axioms / refs + 源文档小字段 + edit-branch 操作条目）。createCommit 与
// 迁移脚本共用同一构造，保证存量迁移产出的 meta 与新 commit 逐字节一致。raw_markdown 不在此（走 source 对象）。
export function buildCommitMeta(snapshot: CommitSnapshotInput = {}, entries: unknown[] | null = null) {
  return {
    doc: snapshot.doc ?? null,
    axioms: snapshot.axioms || [],
    refs: snapshot.refs || [],
    sourceDocument: snapshot.sourceDocument
      ? {
        source_type: snapshot.sourceDocument.source_type ?? null,
        original_path: snapshot.sourceDocument.original_path ?? null,
        created_at: snapshot.sourceDocument.created_at ?? null
      }
      : null,
    // 仅 edit-branch 提交带操作条目；save/revert 提交无（其 diff 按需算父→本）。
    entries: Array.isArray(entries) && entries.length > 0 ? entries : undefined
  };
}

// 写导入原文（raw_markdown）为内容寻址 source 对象——快照里最肥最不变的一块，跨 commit 只存一份（A5-7）。
// 空原文不建对象，返回 null（commit.source_hash 置空，重建时回退空串）。
export function writeSource(db: DbLike, rawMarkdown: unknown) {
  const raw = rawMarkdown == null ? '' : String(rawMarkdown);
  if (raw.length === 0) return null;
  const hash = sha256_128(raw);
  db.prepare('INSERT OR IGNORE INTO objects (hash, kind, data) VALUES (?, ?, ?)')
    .run(hash, 'source', raw);
  return hash;
}

// 读 source 对象的原文；hash 为空或对象缺失退回空串（与 writeSource 的空原文约定对称）。
export function readSource(db: DbLike, hash: unknown) {
  if (!hash) return '';
  const row = db.prepare('SELECT data FROM objects WHERE hash = ? AND kind = ?')
    .get<Pick<ObjectRow, 'data'>>(hash, 'source');
  return row ? row.data : '';
}

// ── spanmap：句位归属对象（A5-1/7）────────────────────────────────────────
//
// 承载两件事：① span→node 归属（source_spans 的 sentence_index → node_id）；
// ② nodes.source_position（tree/blob 都不存它，restore 后原本一律变 NULL——段落容器的
// 半步偏移 x-0.5 丢了，编辑分支的段落拆句判据就再也命中不到）。两者同源于「导入原文与节点的
// 对应关系」，共用一个对象、一次 hash、一次写。
//
// 归属键是 (doc_id, sentence_index)，不是 source_spans.id：后者是 SQLite 内部 rowid，
// saveSourceDocument 重导时整批换号，且 A5-9 明文把它排除在身份层外。sentence_index 在每个
// doc 内密集 1..N（实测全库如此），故 dense 布局直接存有序数组、省掉全部 key。
//
// 格式（JSON，v/layout 自描述，留分块等后续扩展位）：
//   { v:1, layout:'dense',  base:1, ids:[nodeId|null, ...] }
//   { v:1, layout:'sparse', pairs:[[sentenceIndex, nodeId|null], ...] }   // 密集性退化时
//   两种布局都可带可选块 nodePositions:[[nodeId, sourcePosition], ...]（只列非 NULL 的）
export type SpanLink = { sentenceIndex: number; nodeId: string | null };
export type NodePosition = { nodeId: string; sourcePosition: number };
export interface SpanMapPayload {
  links: SpanLink[];
  nodePositions?: NodePosition[];
}
type SpanMapObject = {
  v?: unknown;
  layout?: unknown;
  base?: unknown;
  ids?: Array<string | null>;
  pairs?: Array<[number, string | null]>;
  nodePositions?: Array<[string, number]>;
};

// 归属为空（既无 span 也无 source_position）不建对象，返回 null——与 writeSource 的空原文约定对称，
// commit.span_map_hash 置空。注意「NULL = 旧 commit、退回现行行为」与「空对象 = 该版本确实没有
// 归属」在 restore 侧语义不同，故只有**两者皆空**才返回 null。
export function writeSpanMap(db: DbLike, payload: SpanMapPayload): string | null {
  const links = payload.links || [];
  const nodePositions = payload.nodePositions || [];
  if (links.length === 0 && nodePositions.length === 0) return null;

  // dense 判定：sentence_index 自 base 起严格连续递增。不连续则退 sparse（键值对全存）。
  const base = links.length > 0 ? links[0]!.sentenceIndex : 1;
  const dense = links.every((link, index) => link.sentenceIndex === base + index);
  const object: SpanMapObject = dense
    ? { v: 1, layout: 'dense', base, ids: links.map((link) => link.nodeId ?? null) }
    : { v: 1, layout: 'sparse', pairs: links.map((link) => [link.sentenceIndex, link.nodeId ?? null]) };
  if (nodePositions.length > 0) {
    object.nodePositions = nodePositions.map((entry) => [entry.nodeId, entry.sourcePosition]);
  }

  const data = JSON.stringify(object);
  const hash = sha256_128(data);
  db.prepare('INSERT OR IGNORE INTO objects (hash, kind, data) VALUES (?, ?, ?)').run(hash, 'spanmap', data);
  return hash;
}

// 读 spanmap 对象；hash 为空、对象缺失或格式不认退回 { links: [] }（调用方据此走「无归属」分支）。
export function readSpanMap(db: DbLike, hash: unknown): SpanMapPayload {
  if (!hash) return { links: [] };
  const row = db.prepare('SELECT data FROM objects WHERE hash = ? AND kind = ?')
    .get<Pick<ObjectRow, 'data'>>(hash, 'spanmap');
  if (!row) return { links: [] };
  let object: SpanMapObject;
  try { object = JSON.parse(row.data) as SpanMapObject; } catch { return { links: [] }; }

  const links: SpanLink[] = [];
  if (object.layout === 'dense' && Array.isArray(object.ids)) {
    const base = Number(object.base ?? 1);
    object.ids.forEach((nodeId, index) => {
      links.push({ sentenceIndex: base + index, nodeId: nodeId ?? null });
    });
  } else if (object.layout === 'sparse' && Array.isArray(object.pairs)) {
    for (const pair of object.pairs) {
      if (!Array.isArray(pair)) continue;
      links.push({ sentenceIndex: Number(pair[0]), nodeId: pair[1] ?? null });
    }
  }

  const nodePositions: NodePosition[] = [];
  for (const entry of object.nodePositions || []) {
    if (!Array.isArray(entry)) continue;
    const position = Number(entry[1]);
    if (!entry[0] || !Number.isFinite(position)) continue;
    nodePositions.push({ nodeId: String(entry[0]), sourcePosition: position });
  }
  return nodePositions.length > 0 ? { links, nodePositions } : { links };
}

// gc 的额外可达根：不在 commits 表却仍被引用的对象根——目前是编辑器 undo token（进程内易失，
// 引用对象库里的树/原文而不建 commit 行）。不纳入的话 gc 会把活 token 指向的对象 sweep 掉。
export interface ExtraObjectRoots {
  treeHashes?: Array<string | null | undefined>;
  sourceHashes?: Array<string | null | undefined>;
  spanMapHashes?: Array<string | null | undefined>;
}

// 从所有 commit 出发收集可达对象 hash（mark 阶段）。每个 commit 的 root_tree_hash 递归下钻
// tree→blob 与子 tree、外加 source_hash。从「所有 commit」而非仅 head 祖先链出发：被 reset/revert
// 跳过的 commit 仍在 commits 表、其对象仍可达 → 保住「可后悔」窗口（reflog 语义），只有 commit 行
// 真被删（删文档/删 commit）后其独占对象才变孤儿可收。共享子树因 Set 去重只遍历一次。
export function collectReachableHashes(db: DbLike, extraRoots: ExtraObjectRoots = {}) {
  const reachable = new Set<string>();
  const treeStmt = db.prepare('SELECT data FROM objects WHERE hash = ? AND kind = ?');
  const visitTree = (treeHash: string) => {
    if (!treeHash || reachable.has(treeHash)) return;
    reachable.add(treeHash);
    const row = treeStmt.get<Pick<ObjectRow, 'data'>>(treeHash, 'tree');
    if (!row) return;
    const tree = JSON.parse(row.data) as ObjectTree;
    if (tree.blob_hash) reachable.add(tree.blob_hash);
    for (const child of tree.children || []) visitTree(child.tree_hash);
  };
  for (const commit of db.prepare('SELECT root_tree_hash, source_hash, span_map_hash FROM commits')
    .all<Pick<CommitRow, 'root_tree_hash' | 'source_hash' | 'span_map_hash'>>()) {
    if (commit.root_tree_hash) visitTree(commit.root_tree_hash);
    if (commit.source_hash) reachable.add(commit.source_hash);
    // spanmap 当前不分块，是叶子对象、无需下钻；将来若加 layout:'chunked'，这里要改成
    // 「读顶层对象、把 chunks 里的块 hash 一并加进可达集」。
    if (commit.span_map_hash) reachable.add(commit.span_map_hash);
  }
  for (const treeHash of extraRoots.treeHashes || []) {
    if (treeHash) visitTree(treeHash);
  }
  for (const sourceHash of extraRoots.sourceHashes || []) {
    if (sourceHash) reachable.add(sourceHash);
  }
  for (const spanMapHash of extraRoots.spanMapHashes || []) {
    if (spanMapHash) reachable.add(spanMapHash);
  }
  return reachable;
}

// 对象库 GC（mark-sweep，lazy/手动）：删掉不被任何 commit（或 extraRoots，如活 undo token）
// 引用的 blob/tree/source。调用方负责放进事务。返回 { scanned, reachable, deleted }。
export function gcObjects(db: DbLike, extraRoots: ExtraObjectRoots = {}) {
  const reachable = collectReachableHashes(db, extraRoots);
  const del = db.prepare('DELETE FROM objects WHERE hash = ?');
  const all = db.prepare('SELECT hash FROM objects').all<Pick<ObjectRow, 'hash'>>();
  let deleted = 0;
  for (const row of all) {
    if (!reachable.has(row.hash)) {
      del.run(row.hash);
      deleted += 1;
    }
  }
  return { scanned: all.length, reachable: reachable.size, deleted };
}

// 对象库 tree 指纹（含 node id）——为何要含 id：tree object 既存内容又存 children 的 id（重建靠它取 id）。
// 若指纹只看内容（如 merkle 的 subtreeHashFrom），「内容相同、id 不同」的两个父节点（EPUB 大量重复段落/
// 标题）会算出同一指纹、被 INSERT OR IGNORE 塌缩成一份、只留先写那份的 children id；materializeTree 重建
// 时这份 id 被复用到所有内容相同的位置 → 同一 id 吐多次 → restore 纯 INSERT 撞 UNIQUE。把 node id 拌进
// 指纹后：身份不同 → 指纹不同 → 不塌缩、各存各 id；同一节点跨 commit（id+内容不变）指纹仍同 → 增量去重
// 保留；正文 blob 仍按 contentHash 去重。与 merkle.subtreeHashFrom（纯内容、给 diff/merge 剪枝）互不影响。
function treeObjectHash(blobHash: string, nodeId: unknown, childTreeHashes: string[] = []): string {
  return sha256_128(JSON.stringify([blobHash, String(nodeId ?? ''), ...childTreeHashes]));
}

// 把一棵树（nodes 数组）后序写进对象库，返回 { root_node_id, root_tree_hash }。
// 父必先有子：叶子 writeBlob → 父 writeTree(自己 blob + 各子 tree_hash) → 一路到根。
// 同一节点（id+内容）跨 commit 天然跳过（指纹已在），编辑场景只写变化路径。
export function writeTree(db: DbLike, nodes: NodeObjectRow[] = []) {
  // 入口断言：node id 必须唯一。重复 id 写进对象库会在 materialize/restore/三方调和时被 Map
  // 静默塌缩成丢节点（实测 revert 丢 63 节点的根因形态），宁可当场拒绝产出坏快照。
  const seenIds = new Set<string>();
  const byParent = new Map<string, NodeObjectRow[]>();
  for (const node of nodes) {
    const idKey = String(node.id ?? '');
    if (seenIds.has(idKey)) throw new Error(`writeTree 拒绝写入：快照含重复节点 id ${idKey}`);
    seenIds.add(idKey);
    const key = node.parent_id == null ? '__root__' : String(node.parent_id);
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(node);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
  }

  const insertTree = db.prepare('INSERT OR IGNORE INTO objects (hash, kind, data) VALUES (?, ?, ?)');
  const writeNode = (node: NodeObjectRow): string => {
    const blobHash = writeBlob(db, node);
    const kids = byParent.get(node.id == null ? '__root__' : String(node.id)) || [];
    const childEntries = kids.map((kid) => ({ id: String(kid.id), tree_hash: writeNode(kid) }));
    const treeHash = treeObjectHash(blobHash, node.id, childEntries.map((c) => c.tree_hash));
    insertTree.run(treeHash, 'tree', JSON.stringify({ blob_hash: blobHash, children: childEntries }));
    return treeHash;
  };

  const roots = byParent.get('__root__') || [];
  if (roots.length === 0) return null;
  // 文档快照恰好一个根节点（assertRestorableSnapshotPayload 已保证）。
  const root = roots[0];
  return { root_node_id: String(root!.id), root_tree_hash: writeNode(root!) };
}

// 增量写树输入：结构行（不必带正文）+ tree_object_hash 列缓存。
export interface IncrementalTreeRow extends MerkleNode {
  tree_object_hash?: string | null;
}

export interface IncrementalTreeResult {
  root_node_id: string;
  root_tree_hash: string;
  // 本次真正（重新）算了 hash 的节点 → tree hash，调用方回写 tree_object_hash 列。
  recomputed: Map<string, string>;
}

// writeTree 的增量版：tree_object_hash 列缓存有效（非 NULL 且不在「缓存缺失行∪其祖先」集内）的
// 子树整棵剪掉——不取正文、不算 hash、不写对象。正确性同 merkle 增量：缓存缺失行的祖先全在重算集，
// 故集外节点的整棵子树缓存均有效。前提「列上有 hash ⇒ 对象在库里」由两条纪律维持：列只在写完对象
// 后回写（本函数返回 recomputed 由调用方回写）；gc 之后全列作废（见 gcHistoryObjects）。
// 只可用于「行直读自 nodes 表」的调用点——投影/快照行的缓存值对应 base 不对应投影后，禁止走这里。
// getContent(id) 惰性取重算集节点的 5 个内容字段（重算集通常远小于全树，逐条点查比全表拉正文便宜）。
export function writeTreeIncremental(
  db: DbLike,
  rows: IncrementalTreeRow[] = [],
  getContent: (id: string) => MerkleNode | null | undefined
): IncrementalTreeResult | null {
  const seenIds = new Set<string>();
  const byId = new Map<string, IncrementalTreeRow>();
  const byParent = new Map<string, IncrementalTreeRow[]>();
  for (const node of rows) {
    const idKey = String(node.id ?? '');
    if (seenIds.has(idKey)) throw new Error(`writeTreeIncremental 拒绝写入：快照含重复节点 id ${idKey}`);
    seenIds.add(idKey);
    byId.set(idKey, node);
    const key = node.parent_id == null ? '__root__' : String(node.parent_id);
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(node);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
  }

  // 重算集 = 缓存缺失行 ∪ 祖先闭包。
  const staleSet = new Set<string>();
  for (const node of rows) {
    if (node.tree_object_hash) continue;
    let cursor: IncrementalTreeRow | undefined = node;
    while (cursor) {
      const key = String(cursor.id);
      if (staleSet.has(key)) break;
      staleSet.add(key);
      const parentId: number | string | null | undefined = cursor.parent_id ?? cursor.parentId;
      cursor = parentId === null || parentId === undefined ? undefined : byId.get(String(parentId));
    }
  }

  const insertTree = db.prepare('INSERT OR IGNORE INTO objects (hash, kind, data) VALUES (?, ?, ?)');
  const recomputed = new Map<string, string>();
  const writeNode = (node: IncrementalTreeRow): string => {
    const idKey = String(node.id);
    if (!staleSet.has(idKey) && node.tree_object_hash) return node.tree_object_hash; // 整棵剪枝
    const content = getContent(idKey);
    if (!content) throw new Error(`writeTreeIncremental 取不到节点 ${idKey} 的内容行`);
    const blobHash = writeBlob(db, content);
    const kids = byParent.get(idKey) || [];
    const childEntries = kids.map((kid) => ({ id: String(kid.id), tree_hash: writeNode(kid) }));
    const treeHash = treeObjectHash(blobHash, node.id, childEntries.map((c) => c.tree_hash));
    insertTree.run(treeHash, 'tree', JSON.stringify({ blob_hash: blobHash, children: childEntries }));
    recomputed.set(idKey, treeHash);
    return treeHash;
  };

  const roots = byParent.get('__root__') || [];
  if (roots.length === 0) return null;
  const root = roots[0]!;
  return { root_node_id: String(root.id), root_tree_hash: writeNode(root), recomputed };
}

// ── nodeHistory 剪枝原语：在 tree 对象图中定位目标节点，不物化整树 ─────────
//
// 返回目标节点的三类指纹：treeHash（id+内容+全部后代，subtree 口径）、blobHash（纯内容，
// node 口径）、位置（parentNodeId + childIndex）。位置单独给出是因为节点自身的挂载点
// 不在它自己的子树 hash 里（id 存在父 tree 的 children 中）——相邻 commit 两类 hash 全同
// 仍可能发生「目标被移动」（computeSnapshotDiff 的 __moved__），须并入判定。
// childIndex 为父 children 数组次序（1 起），与 materializeTree 还原的 sort_order 同口径。
export interface TreeNodeLocation {
  treeHash: string;
  blobHash: string;
  parentNodeId: string | null;
  childIndex: number;
}

// 跨 commit 复用的缓存（由调用方持有、单次查询生命周期）：
// - containsMemo: `目标id\n树hash` → 该子树（根非目标时）内目标的 tree_hash（null=不含）。
//   tree hash 含节点 id，同 hash ⇒ 同 id 同结构 ⇒ 结果确定；键并入目标 id，同一 caches
//   可安全服务多个目标的查询（不并入会被上一个目标的「不含」判定污染）。
// - treeCache: tree 对象反序列化缓存。
// 相邻 commit 绝大部分子树 hash 相同：不含目标的分支查 memo O(1) 剪掉，每个 commit 只真正
// 遍历「新出现的 tree 对象（≈改动路径）+ 目标祖先链」，K 个 commit 总代价 ~O(M + K×depth)。
export interface TreeLocateCaches {
  containsMemo: Map<string, string | null>;
  treeCache: Map<string, ObjectTree | null>;
}

export function createTreeLocateCaches(): TreeLocateCaches {
  return { containsMemo: new Map(), treeCache: new Map() };
}

export function locateNodeInTree(
  db: DbLike,
  rootTreeHash: unknown,
  rootNodeId: unknown,
  targetId: unknown,
  caches: TreeLocateCaches
): TreeNodeLocation | null {
  if (!rootTreeHash) return null;
  const target = String(targetId);
  const { containsMemo, treeCache } = caches;
  const treeStmt = db.prepare('SELECT data FROM objects WHERE hash = ? AND kind = ?');
  const loadTree = (hash: string): ObjectTree | null => {
    if (!treeCache.has(hash)) {
      const row = treeStmt.get<Pick<ObjectRow, 'data'>>(hash, 'tree');
      treeCache.set(hash, row ? JSON.parse(row.data) as ObjectTree : null);
    }
    return treeCache.get(hash) ?? null;
  };
  const memoKey = (treeHash: string) => `${target}\n${treeHash}`;
  const locate = (treeHash: string, nodeId: string, parentNodeId: string | null, childIndex: number): TreeNodeLocation | null => {
    if (nodeId === target) {
      const tree = loadTree(treeHash);
      if (!tree) return null; // 对象缺失：视为不可定位，调用方回退物化路径（那里会给出明确报错）
      return { treeHash, blobHash: String(tree.blob_hash || ''), parentNodeId, childIndex };
    }
    if (containsMemo.get(memoKey(treeHash)) === null) return null; // 已知不含目标，整棵剪掉
    const tree = loadTree(treeHash);
    const kids = tree?.children || [];
    for (let i = 0; i < kids.length; i += 1) {
      const found = locate(kids[i]!.tree_hash, String(kids[i]!.id), nodeId, i + 1);
      if (found) {
        containsMemo.set(memoKey(treeHash), found.treeHash);
        return found;
      }
    }
    containsMemo.set(memoKey(treeHash), null);
    return null;
  };
  return locate(String(rootTreeHash), String(rootNodeId ?? ''), null, 1);
}

// 从根 tree hash 展开对象库，还原 nodes 数组（带 id/parent/sort/address/depth + blob 内容）。
// 前序递归：根 tree → 取 blob 内容 + children → 逐子 materialize。restore/读取的路径，有读放大（已接受）。
// 根 id 由调用方从 commit 取（commit 存 root_node_id）。
// address/depth 顺带算（与 refreshDocAddresses 同口径：根 "1"、子 父-序号；单根文档根恒 "1"）——
//   restore 路径会再 refreshDocAddresses 重算（这里的值被覆盖），但历史 diff/--at 展示直接用它，省一趟。
// sort_order = 位置序号（子在父 children 数组里的次序，1 起）。对象库不存绝对值（它是位置/派生量，
//   同 source_position 一类）；系统恒把 live 的 sort_order 维持成密集 1..n（全库已核 0 例外），
//   故位置序号 == live 值，head↔历史 diff 的「移动」判定与 revert 的位置三方调和都不受重建影响。
// source_position = null（对象库不存位置/派生字段，restore 时由 source_spans 重建）。
export function materializeTree(db: DbLike, rootTreeHash: unknown, rootNodeId: string | number | null) {
  if (!rootTreeHash) return [];
  const treeStmt = db.prepare('SELECT data FROM objects WHERE hash = ? AND kind = ?');
  const blobStmt = db.prepare('SELECT data FROM objects WHERE hash = ? AND kind = ?');
  const treeCache = new Map<string, ObjectTree | null>();
  const loadTree = (hash: string) => {
    if (!treeCache.has(hash)) {
      const row = treeStmt.get<Pick<ObjectRow, 'data'>>(hash, 'tree');
      treeCache.set(hash, row ? JSON.parse(row.data) as ObjectTree : null);
    }
    return treeCache.get(hash);
  };

  const nodes: NodeObjectRow[] = [];
  const expand = (
    treeHash: string,
    parentId: string | number | null,
    sortOrder: number,
    nodeId: string | number | null,
    address: string,
    depth: number
  ) => {
    const tree = loadTree(treeHash);
    if (!tree) return;
    const blobRow = blobStmt.get<Pick<ObjectRow, 'data'>>(tree.blob_hash, 'blob');
    if (!blobRow) throw new Error(`对象库缺 blob ${tree.blob_hash}（节点 ${nodeId} / tree ${treeHash}），快照不完整`);
    const blob = JSON.parse(blobRow.data) as NodeObjectRow;
    nodes.push({
      ...blob,
      id: nodeId,
      parent_id: parentId,
      sort_order: sortOrder,
      address,
      depth,
      source_position: null,
      // blobData 把 trust 的 null 归一成 ''（与 contentHash 取字段口径一致）；重建时还原 null，
      // 否则触发 nodes.trust_level 的 CHECK（只允许 受控/不受控/NULL）。'' 与 null 对 trust 同义。
      trust_level: blob.trust_level || null
    });
    const kids = tree.children || [];
    for (let i = 0; i < kids.length; i += 1) {
      expand(kids[i]!.tree_hash, nodeId, i + 1, kids[i]!.id, `${address}-${i + 1}`, depth + 1);
    }
  };

  expand(String(rootTreeHash), null, 1, rootNodeId, '1', 1);
  // 出口断言：treeObjectHash 混入 node id 之前写入的旧对象（内容相同的节点被 INSERT OR IGNORE
  // 塌缩共享一份 tree）会在这里把同一 id 展开到多个位置。放行会让下游（restore 纯 INSERT、
  // revert 三方调和的按 id Map）要么撞 UNIQUE 要么静默丢节点——当场报错，指明该 commit 不可恢复。
  const seenIds = new Set<string>();
  for (const node of nodes) {
    const idKey = String(node.id ?? '');
    if (seenIds.has(idKey)) {
      throw new Error(`对象库快照含重复节点 id ${idKey}（tree ${rootTreeHash}）：历史对象为旧版塌缩产物，该 commit 不可恢复`);
    }
    seenIds.add(idKey);
  }
  return nodes;
}
