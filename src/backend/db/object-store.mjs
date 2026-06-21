// 内容寻址对象库（第 4 步 git 对象模型）。
// commit 存根节点 id + 根 tree 的 hash；节点内容（blob）与子树结构（tree）按 hash 去重存进 objects 表。
// hash 纯复用 core/merkle 的 contentHash / subtreeHash——位置无关，相同子树跨 commit 跨文档只存一份。
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

import { contentHash, subtreeHashFrom, sha256_128 } from '../../core/merkle.mjs';

// blob 内容字段（与 merkle CONTENT_FIELDS 对齐，顺序固定）。
const BLOB_FIELDS = ['text', 'node_title', 'node_note', 'node_type', 'trust_level'];

function blobData(node) {
  const data = {};
  for (const field of BLOB_FIELDS) {
    data[field] = node[field] ?? '';
  }
  return data;
}

// 写单节点内容对象。contentHash 当 blob key，已存在则跳过（INSERT OR IGNORE 天然去重）。
export function writeBlob(db, node) {
  const hash = contentHash(node);
  db.prepare('INSERT OR IGNORE INTO objects (hash, kind, data) VALUES (?, ?, ?)')
    .run(hash, 'blob', JSON.stringify(blobData(node)));
  return hash;
}

// commit 的内联 meta（doc / axioms / refs + 源文档小字段 + edit-branch 操作条目）。createCommit 与
// 迁移脚本共用同一构造，保证存量迁移产出的 meta 与新 commit 逐字节一致。raw_markdown 不在此（走 source 对象）。
export function buildCommitMeta(snapshot = {}, entries = null) {
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
export function writeSource(db, rawMarkdown) {
  const raw = rawMarkdown == null ? '' : String(rawMarkdown);
  if (raw.length === 0) return null;
  const hash = sha256_128(raw);
  db.prepare('INSERT OR IGNORE INTO objects (hash, kind, data) VALUES (?, ?, ?)')
    .run(hash, 'source', raw);
  return hash;
}

// 读 source 对象的原文；hash 为空或对象缺失退回空串（与 writeSource 的空原文约定对称）。
export function readSource(db, hash) {
  if (!hash) return '';
  const row = db.prepare('SELECT data FROM objects WHERE hash = ? AND kind = ?').get(hash, 'source');
  return row ? row.data : '';
}

// 从所有 commit 出发收集可达对象 hash（mark 阶段）。每个 commit 的 root_tree_hash 递归下钻
// tree→blob 与子 tree、外加 source_hash。从「所有 commit」而非仅 head 祖先链出发：被 reset/revert
// 跳过的 commit 仍在 commits 表、其对象仍可达 → 保住「可后悔」窗口（reflog 语义），只有 commit 行
// 真被删（删文档/删 commit）后其独占对象才变孤儿可收。共享子树因 Set 去重只遍历一次。
export function collectReachableHashes(db) {
  const reachable = new Set();
  const treeStmt = db.prepare('SELECT data FROM objects WHERE hash = ? AND kind = ?');
  const visitTree = (treeHash) => {
    if (!treeHash || reachable.has(treeHash)) return;
    reachable.add(treeHash);
    const row = treeStmt.get(treeHash, 'tree');
    if (!row) return;
    const tree = JSON.parse(row.data);
    if (tree.blob_hash) reachable.add(tree.blob_hash);
    for (const child of tree.children || []) visitTree(child.tree_hash);
  };
  for (const commit of db.prepare('SELECT root_tree_hash, source_hash FROM commits').all()) {
    if (commit.root_tree_hash) visitTree(commit.root_tree_hash);
    if (commit.source_hash) reachable.add(commit.source_hash);
  }
  return reachable;
}

// 对象库 GC（mark-sweep，lazy/手动）：删掉不被任何 commit 引用的 blob/tree/source。
// 调用方负责放进事务。返回 { scanned, reachable, deleted }。
export function gcObjects(db) {
  const reachable = collectReachableHashes(db);
  const del = db.prepare('DELETE FROM objects WHERE hash = ?');
  const all = db.prepare('SELECT hash FROM objects').all();
  let deleted = 0;
  for (const row of all) {
    if (!reachable.has(row.hash)) {
      del.run(row.hash);
      deleted += 1;
    }
  }
  return { scanned: all.length, reachable: reachable.size, deleted };
}

// 把一棵树（nodes 数组）后序写进对象库，返回 { root_node_id, root_tree_hash }。
// 父必先有子：叶子 writeBlob → 父 writeTree(自己 blob + 各子 tree_hash) → 一路到根。
// 同结构子树天然跳过（hash 已在），编辑场景只写变化路径。
export function writeTree(db, nodes = []) {
  const byParent = new Map();
  for (const node of nodes) {
    const key = node.parent_id == null ? '__root__' : String(node.parent_id);
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(node);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
  }

  const insertTree = db.prepare('INSERT OR IGNORE INTO objects (hash, kind, data) VALUES (?, ?, ?)');
  const writeNode = (node) => {
    const blobHash = writeBlob(db, node);
    const kids = byParent.get(node.id == null ? '__root__' : String(node.id)) || [];
    const childEntries = kids.map((kid) => ({ id: String(kid.id), tree_hash: writeNode(kid) }));
    const treeHash = subtreeHashFrom(blobHash, childEntries.map((c) => c.tree_hash));
    insertTree.run(treeHash, 'tree', JSON.stringify({ blob_hash: blobHash, children: childEntries }));
    return treeHash;
  };

  const roots = byParent.get('__root__') || [];
  if (roots.length === 0) return null;
  // 文档快照恰好一个根节点（assertRestorableSnapshotPayload 已保证）。
  const root = roots[0];
  return { root_node_id: String(root.id), root_tree_hash: writeNode(root) };
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
export function materializeTree(db, rootTreeHash, rootNodeId) {
  if (!rootTreeHash) return [];
  const treeStmt = db.prepare('SELECT data FROM objects WHERE hash = ? AND kind = ?');
  const blobStmt = db.prepare('SELECT data FROM objects WHERE hash = ? AND kind = ?');
  const treeCache = new Map();
  const loadTree = (hash) => {
    if (!treeCache.has(hash)) {
      const row = treeStmt.get(hash, 'tree');
      treeCache.set(hash, row ? JSON.parse(row.data) : null);
    }
    return treeCache.get(hash);
  };

  const nodes = [];
  const expand = (treeHash, parentId, sortOrder, nodeId, address, depth) => {
    const tree = loadTree(treeHash);
    if (!tree) return;
    const blobRow = blobStmt.get(tree.blob_hash, 'blob');
    if (!blobRow) throw new Error(`对象库缺 blob ${tree.blob_hash}（节点 ${nodeId} / tree ${treeHash}），快照不完整`);
    const blob = JSON.parse(blobRow.data);
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
      expand(kids[i].tree_hash, nodeId, i + 1, kids[i].id, `${address}-${i + 1}`, depth + 1);
    }
  };

  expand(rootTreeHash, null, 1, rootNodeId, '1', 1);
  return nodes;
}
