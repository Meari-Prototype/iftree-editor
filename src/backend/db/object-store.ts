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
// source_position / created_at / updated_at 不进对象库（第 4 步边界：只追踪子树结构 + 正文）。
// 句位真相由 source_spans 表承载（用 node_id 直挂），restore 时跟着回，不受影响。

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

// 写单节点内容对象。contentHash 当 blob key，已存在则跳过（INSERT OR IGNORE 天然去重）。
export function writeBlob(db: DbLike, node: NodeObjectRow) {
  const hash = contentHash(node);
  db.prepare('INSERT OR IGNORE INTO objects (hash, kind, data) VALUES (?, ?, ?)')
    .run(hash, 'blob', JSON.stringify(blobData(node)));
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

// 从所有 commit 出发收集可达对象 hash（mark 阶段）。每个 commit 的 root_tree_hash 递归下钻
// tree→blob 与子 tree、外加 source_hash。从「所有 commit」而非仅 head 祖先链出发：被 reset/revert
// 跳过的 commit 仍在 commits 表、其对象仍可达 → 保住「可后悔」窗口（reflog 语义），只有 commit 行
// 真被删（删文档/删 commit）后其独占对象才变孤儿可收。共享子树因 Set 去重只遍历一次。
export function collectReachableHashes(db: DbLike) {
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
  for (const commit of db.prepare('SELECT root_tree_hash, source_hash FROM commits')
    .all<Pick<CommitRow, 'root_tree_hash' | 'source_hash'>>()) {
    if (commit.root_tree_hash) visitTree(commit.root_tree_hash);
    if (commit.source_hash) reachable.add(commit.source_hash);
  }
  return reachable;
}

// 对象库 GC（mark-sweep，lazy/手动）：删掉不被任何 commit 引用的 blob/tree/source。
// 调用方负责放进事务。返回 { scanned, reachable, deleted }。
export function gcObjects(db: DbLike) {
  const reachable = collectReachableHashes(db);
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
  const byParent = new Map<string, NodeObjectRow[]>();
  for (const node of nodes) {
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
  return nodes;
}
