// 历史子系统（projectneed 15-5 / 18-3）：内容寻址 commit 之上的读写业务层——文档级历史列表 /
// 节点级历史 / 恢复（reset）/ 反向提交（revert）/ human 背书认证 / 对象库 GC。纯函数模块，门面
// IftreeStore 实例作第一参数传入：底座的快照提交原语（store.createCommit / commitSnapshot /
// commitSnapshotFromRow / createSnapshot / restoreSnapshot / computeDiff）与事务（store.withTransaction）
// 和连接（store.db）经它访问，模块不反向 import 门面。index.mjs 上保留同名方法做一行转调。

import { classifyThreeWayMerge } from '../../core/merkle-merge.js';
import { requireStableId } from '../db/ids.js';
import { computeSnapshotDiff } from '../db/snapshot-history.js';
import { gcObjects } from '../db/object-store.js';
// type-only import 不产生运行时循环：store/index.ts 运行时 import history.ts，反向只取类型。
import type { IftreeStore } from './index.js';
import type { CommitRow, NodeRow } from '../db/schema.js';
import type { MerkleNode } from '../../core/merkle.js';

// 从 head 沿 parent_commit_id 上溯，返回祖先链 commit id（head 在前、根在后）。git log 只走这条链——
// restore/reset 把 head 移到旧 commit 后，被跳过的"未来" commit 不在链上、从 log 消失（仍可凭 id 直接访问，充当 reflog）。
type RowObject = Record<string, unknown>;

// 对外公共 payload 形状：store 门面收到的 args 转调进来时按这几个 interface 解构。
// 所有字段一律 unknown：IPC/CLI 入口给 unknown，函数内 requireStableId / String() 收紧。
export interface SaveHistorySnapshotPayload {
  docId: unknown;
  summary?: unknown;
  owner?: unknown;
}

export interface CertifyNodesPayload {
  docId: unknown;
  nodeId?: unknown;
  address?: unknown;
  scope?: unknown;
  trust?: unknown;
  owner?: unknown;
}

export interface RevertCommitPayload {
  commitId: unknown;
  owner?: unknown;
  summary?: unknown;
}

function commitAncestry(store: IftreeStore, docId: string): string[] {
  const head = store.db!.prepare('SELECT head_commit_id FROM doc_heads WHERE doc_id = ?')
    .get<{ head_commit_id: string | null }>(docId);
  const chain: string[] = [];
  const seen = new Set<string>();
  const parentStmt = store.db!.prepare('SELECT parent_commit_id FROM commits WHERE id = ?');
  let cur: string | null = head?.head_commit_id || null;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    cur = parentStmt.get<{ parent_commit_id: string | null }>(cur)?.parent_commit_id || null;
  }
  return chain;
}

// 子树成员 id 集合（纯快照数据处理，不碰库）：从快照的 parent_id 邻接关系自 rootId 向下收集。
function subtreeMemberIds(snapshot: RowObject | null, rootId: string) {
  const members = new Set();
  if (!snapshot || !Array.isArray(snapshot.nodes)) return members;
  const childrenByParent = new Map();
  for (const node of snapshot.nodes) {
    const parent = node.parent_id ?? node.parentId ?? null;
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
    childrenByParent.get(parent).push(node.id);
  }
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (members.has(id)) continue;
    members.add(id);
    for (const child of childrenByParent.get(id) || []) stack.push(child);
  }
  return members;
}

// 历史项形态：commits 表的子集 + 旧字段名别名（commit_id/saved_at），与 CommitRow 结构兼容。
export type HistoryEntry = Pick<CommitRow, 'id' | 'doc_id' | 'committed_at' | 'summary' | 'author'> & {
  commit_id: string;
  saved_at: string;
};

export function listHistory(store: IftreeStore, docId: string): HistoryEntry[] {
  // 历史列表以 commits 为事实来源，但只列 head 祖先链（git log 语义）：restore/reset 把 head 移回后，
  // 被跳过的"未来" commit 不再出现在 log/历史里（仍可凭 commit id 直接 diff/restore 跳回）。
  // id 即 commit UUID，commit_id/saved_at 为兼容旧字段名的别名。
  const chain = commitAncestry(store, docId);
  if (chain.length === 0) return [];
  const placeholders = chain.map(() => '?').join(',');
  const rows = store.db!.prepare(`
    SELECT id, doc_id, id AS commit_id, committed_at AS saved_at, summary, author
    FROM commits
    WHERE doc_id = ? AND id IN (${placeholders})
  `).all<HistoryEntry>(docId, ...chain);
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  return chain.map((id) => byId.get(id)).filter((row): row is HistoryEntry => Boolean(row));
}

// 节点级历史（git log <path> 语义）：某地址的节点（scope='node'）或整棵子树（默认）
// 在哪些 commit 被改动。按稳定 id 追——先把 address 解析成当前 node_id，再遍历 commit 链，
// 对相邻快照跑 computeSnapshotDiff 并过滤目标成员；节点历史上换过地址也连得上（git log --follow）。
// 子树成员从相邻两快照并集取，覆盖被删的子节点。
export function nodeHistory(store: IftreeStore, docId: unknown, address: unknown, { scope = 'subtree' } = {}) {
  const normalizedDocId = requireStableId(docId, 'nodeHistory docId');
  const target = store.db!
    .prepare('SELECT id FROM nodes WHERE doc_id = ? AND address = ?')
    .get<Pick<NodeRow, 'id'>>(normalizedDocId, String(address));
  if (!target) throw new Error(`nodeHistory target not found: doc ${normalizedDocId} ${address}`);
  const targetId = target.id;
  // 只遍历 head 祖先链上的 commit（git log 语义，与文档级一致）：reset 后"未来" commit 不计入节点历史。
  const ancestry = new Set(commitAncestry(store, normalizedDocId));
  const commits = store.db!.prepare(`
    SELECT * FROM commits WHERE doc_id = ?
    ORDER BY committed_at ASC, id ASC
  `).all<CommitRow>(normalizedDocId).filter((commit) => ancestry.has(String(commit.id)));

  // 重建走对象库（commitSnapshotFromRow）。当前逐 commit 物化整树再 diff——正确但仍 O(K×M)；
  // 子树 tree_hash 剪枝（相邻 commit 该子树哈希没变就跳过）到 O(K) 作为紧随的增量层接入。
  const entries = [];
  let prevSnapshot = null;
  for (const commit of commits) {
    const snapshot = store.commitSnapshotFromRow(commit) || { nodes: [] };
    const members = scope === 'node'
      ? new Set([targetId])
      : new Set([
        ...subtreeMemberIds(prevSnapshot, targetId),
        ...subtreeMemberIds(snapshot, targetId)
      ]);
    let changes = [];
    let changed = false;
    if (!prevSnapshot) {
      changed = (snapshot.nodes || []).some((node: RowObject) => members.has(node.id));
    } else {
      changes = computeSnapshotDiff(prevSnapshot, snapshot).filter((entry) => members.has(entry.node_id));
      changed = changes.length > 0;
    }
    if (changed) {
      entries.push({
        id: commit.id,
        commit_id: commit.id,
        committed_at: commit.committed_at,
        saved_at: commit.committed_at,
        summary: commit.summary,
        author: commit.author,
        changeCount: changes.length
      });
    }
    prevSnapshot = snapshot;
  }
  entries.reverse();
  return entries;
}

// 对象库 GC（独立运维动词，不在写热路径）：回收没被任何 commit 引用的 blob/tree/source 对象。
// reset/revert 后不自动跑——留「可后悔」窗口；需要时手动触发。
export function gcHistoryObjects(store: IftreeStore) {
  return store.withTransaction(() => gcObjects(store.db!));
}

export function saveHistorySnapshot(store: IftreeStore, { docId, summary = '保存版本', owner = 'human' }: SaveHistorySnapshotPayload) {
  return store.withTransaction(() => {
    const currentSnapshot = store.createSnapshot(docId);
    // diff 不再持久化（按需由 query-api 现算）；createCommit 把快照拆进对象库 + 内联 meta。
    const commit = store.createCommit({
      docId,
      summary,
      snapshot: currentSnapshot,
      author: owner
    });
    if (!commit) throw new Error('saveHistorySnapshot: createCommit returned no row');
    return {
      id: commit.id,
      doc_id: commit.doc_id,
      commit_id: commit.id,
      saved_at: commit.committed_at,
      summary: commit.summary
    };
  });
}

// human 节点级背书（projectneed 18-3）：把节点或整棵子树标受控/撤销，作为一次 owner=human 提交进历史。
// trust_level ∈ content_hash（A5-2），改 trust 即改指纹，saveHistorySnapshot 的 computeDiff 据此把变更写进 commit；
// 受控只允许 owner=human（后端档位校验，对应 18-3 写动词 trust 下线、堵 llm 绕过 MCP 直传受控）。
/**
 * @param {*} store
 * @param {{ docId?: unknown, nodeId?: unknown, address?: unknown, scope?: string, trust?: string, owner?: string }} [args]
 */
export function certifyNodes(store: IftreeStore, { docId, nodeId = null, address = null, scope = 'subtree', trust = '受控', owner = 'human' }: CertifyNodesPayload = {} as CertifyNodesPayload) {
  const normalizedDocId = requireStableId(docId, 'certify docId');
  if (trust !== '受控' && trust !== '不受控') throw new Error(`certify trust 只能是 受控/不受控，收到：${trust}`);
  // owner 现为 role:user#ts 编码（18-3 身份），取 role 段判断：标受控只允许 human 角色。
  if (trust === '受控' && String(owner || '').trim().split(':', 1)[0] !== 'human') throw new Error('标受控只允许 owner=human（18-3）');
  return store.withTransaction(() => {
    let targetId = null;
    if (nodeId != null && String(nodeId).length > 0) {
      targetId = String(requireStableId(nodeId, 'certify nodeId'));
    } else if (address != null && String(address).length > 0) {
      const row = store.db!.prepare('SELECT id FROM nodes WHERE doc_id = ? AND address = ?').get(normalizedDocId, String(address));
      if (!row) throw new Error(`certify 找不到地址 ${address} 的节点`);
      targetId = String(row.id);
    } else {
      throw new Error('certify 需要 nodeId 或 address');
    }
    const ids = scope === 'node'
      ? [targetId]
      : store.db!.prepare(`
          WITH RECURSIVE subtree(id) AS (
            SELECT id FROM nodes WHERE id = ? AND doc_id = ?
            UNION ALL
            SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.id
          )
          SELECT id FROM subtree
        `).all(targetId, normalizedDocId).map((row: RowObject) => String(row.id));
    // 只改 trust 与目标不同的节点（NULL 视为不受控），避免无变更的空 commit。
    const update = store.db!.prepare(`
      UPDATE nodes SET trust_level = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND doc_id = ? AND COALESCE(trust_level, '不受控') <> ?
    `);
    const touchedNodeIds = [];
    for (const id of ids) {
      if (update.run(trust, id, normalizedDocId, trust).changes > 0) touchedNodeIds.push(id);
    }
    if (touchedNodeIds.length === 0) {
      return { changed: false, docId: normalizedDocId, certified: 0, trust, touchedNodeIds: [] };
    }
    const history = saveHistorySnapshot(store, {
      docId: normalizedDocId,
      summary: trust === '受控' ? '认证·标受控' : '撤销认证·标不受控',
      owner
    });
    return { changed: true, docId: normalizedDocId, certified: touchedNodeIds.length, trust, touchedNodeIds, commitId: history.commit_id };
  });
}

// 按 commit_id（UUID）从 commits.snapshot 恢复——commits 是历史的事实来源（projectneed 189-191）。
export function restoreCommit(store: IftreeStore, commitId: unknown) {
  return store.withTransaction(() => {
    const commit = store.db!.prepare('SELECT * FROM commits WHERE id = ?').get<CommitRow>(commitId);
    if (!commit) throw new Error(`Commit not found: ${commitId}`);
    const snapshot = store.commitSnapshotFromRow(commit);
    if (!snapshot?.nodes) {
      throw new Error(`Commit is not restorable: ${commitId}`);
    }
    store.restoreSnapshot(commit.doc_id, snapshot);
    // git reset 语义：把 head 移到目标 commit。之前只重写 nodes、head 不动，会让 head_commit_id
    // 与正文脱节（后续 diff/commit 的 parent 链挂错）。被跳过的"未来" commit 仍留在 commits 表，
    // 可凭 commit id 直接 restore 跳回，充当 reflog。
    store.db!.prepare(`
      INSERT INTO doc_heads (doc_id, head_commit_id, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(doc_id) DO UPDATE SET head_commit_id = excluded.head_commit_id, updated_at = CURRENT_TIMESTAMP
    `).run(commit.doc_id, commitId);
    return true;
  });
}

// 反向提交（projectneed 15-5-3 revert）：撤销目标 commit 对 nodes 的改动、保留其后历史，建一个新 commit
// （不丢历史，区别于 restore 的 reset 式回滚）。三方调和 base=目标 commit / ours=当前主干 / theirs=目标的父：
// 只 C 改过而当前未再动的取父侧（撤销），当前在 C 之后又改的保留；C 删过的节点经 added-theirs 复活。
// 撞冲突（两侧改同字段、或结构性删改）一律 blocked、交人裁、不自动解。v1 聚焦 nodes：axioms 取当前侧不单独反撤，refs 跟随存活节点。
/**
 * @param {*} store
 * @param {{ commitId?: unknown, owner?: string, summary?: unknown }} [args]
 */
export function revertCommit(store: IftreeStore, { commitId, owner = 'human', summary = null }: RevertCommitPayload = {} as RevertCommitPayload) {
  const normalizedCommitId = requireStableId(commitId, 'revert commitId');
  return store.withTransaction(() => {
    const target = store.db!.prepare('SELECT * FROM commits WHERE id = ?').get<CommitRow>(normalizedCommitId);
    if (!target) throw new Error(`revert 找不到 commit ${commitId}`);
    if (!target.parent_commit_id) throw new Error('revert 不能撤销初始提交（无父提交）');
    const parentRow = store.db!.prepare('SELECT * FROM commits WHERE id = ?').get<CommitRow>(target.parent_commit_id);
    if (!parentRow) throw new Error('revert 找不到父提交快照');
    const docId = target.doc_id;
    const baseSnap = store.commitSnapshotFromRow(target) || {};
    const parentSnap = store.commitSnapshotFromRow(parentRow) || {};
    const currentSnap = store.createSnapshot(docId);

    // classifyThreeWayMerge 用 MerkleNode 弱接口；snapshot.nodes 运行时是 NodeRow 形状但 TS 看不出。
    const merge = classifyThreeWayMerge(
      (baseSnap.nodes || []) as unknown as MerkleNode[],
      (currentSnap.nodes || []) as unknown as MerkleNode[],
      (parentSnap.nodes || []) as unknown as MerkleNode[]
    );
    if (merge.hasConflicts) {
      return { changed: false, blocked: true, docId, commitId: normalizedCommitId, conflicts: merge.conflicts };
    }

    // 按 resolution 构造撤销后的目标 nodes：取当前侧 / 父侧 / 合并值；deleted 跳过。address/depth 由 restoreSnapshot 重算，只需 parent_id + sort_order + 内容正确。
    const oursById = new Map<string, RowObject>((currentSnap.nodes || []).map((n: RowObject) => [String(n.id), n]));
    const theirsById = new Map<string, RowObject>((parentSnap.nodes || []).map((n: RowObject) => [String(n.id), n]));
    const targetNodes: RowObject[] = [];
    for (const entry of merge.nodes) {
      const id = String(entry.id);
      if (entry.resolution === 'deleted') continue;
      if (entry.resolution === 'theirs' || entry.resolution === 'added-theirs') {
        const row = theirsById.get(id);
        if (row) targetNodes.push({ ...row });
      } else if (entry.resolution === 'merged') {
        // 合并值覆盖当前侧行（entry.merged 只含 classifyThreeWayMerge 调和过的字段，无冲突——冲突已在上面整体 blocked）。
        const row: RowObject = { ...(oursById.get(id) || theirsById.get(id) || {}) };
        for (const [field, value] of Object.entries(entry.merged || {})) row[field] = value;
        targetNodes.push(row);
      } else {
        // ours / unchanged / added-ours / added-converged / 兜底：取当前侧，保留 C 之后的改动。
        const row = oursById.get(id) || theirsById.get(id);
        if (row) targetNodes.push({ ...row });
      }
    }

    // sort_order 单独逐节点三方调和（revert 撤销移动）：撤销目标 commit 改过的位置、保留其后又改的。
    // classifyThreeWayMerge 的 MERGE_FIELDS 不含 sort，纯位置移动（node.move/moveAfter）会被判 unchanged
    // 而漏撤；这里独立补一次，不动那个共享分类器（免得波及 merge 预览对连带重排的判定）。三侧都在该
    // 节点才调和；新增/复活的节点不在三侧之列，保留所取侧的位置。
    const baseById = new Map<string, RowObject>((baseSnap.nodes || []).map((n: RowObject) => [String(n.id), n]));
    const resolveSort = (base: unknown, ours: unknown, theirs: unknown) => {
      const b = base == null ? null : String(base);
      const o = ours == null ? null : String(ours);
      const t = theirs == null ? null : String(theirs);
      if (o === t) return ours;    // 收敛 / 两侧都没动
      if (o === b) return theirs;  // 当前未再动该位置 → 撤销回父侧
      if (t === b) return ours;    // 父侧未动 → 保留当前
      return ours;                 // 三方分歧：保留当前，不破坏目标 commit 之后的移动
    };
    for (const node of targetNodes) {
      const id = String(node.id);
      const baseSort = baseById.get(id)?.sort_order;
      const oursSort = oursById.get(id)?.sort_order;
      const theirsSort = theirsById.get(id)?.sort_order;
      if (baseSort != null && oursSort != null && theirsSort != null) {
        node.sort_order = resolveSort(baseSort, oursSort, theirsSort);
      }
    }

    // refs 跟随存活节点：父 + 当前并集按 id 去重（当前覆盖父），过滤两端 node 已不在目标集的。
    const targetNodeIds = new Set(targetNodes.map((n) => String(n.id)));
    const refById = new Map();
    for (const ref of [...(parentSnap.refs || []), ...(currentSnap.refs || [])]) refById.set(String(ref.id), ref);
    const targetRefs = [...refById.values()].filter((ref) => (
      (ref.source_type !== 'node' || targetNodeIds.has(String(ref.source_id)))
      && (ref.target_type !== 'node' || targetNodeIds.has(String(ref.target_id)))
    ));

    store.restoreSnapshot(docId, {
      doc: currentSnap.doc,
      sourceDocument: currentSnap.sourceDocument,
      nodes: targetNodes,
      axioms: currentSnap.axioms || [],
      refs: targetRefs
    });

    // 反向提交：parent = 当前 HEAD（createCommit 内部自取），保留历史链。
    const finalSnapshot = store.createSnapshot(docId);
    // 回执 touched 集合 = revert 前后两份 live 快照之差。早先拿 HEAD commit 的 materialize 快照做 prev，
    // 会与 live 的 finalSnapshot 跨口径比较：canonicalNodeContent 把 node_title/node_note 的 null 归一成
    // ''，而 materializeTree 不还原（只还原 trust_level），于是每个标题/备注为 NULL 的节点都被误判改动——
    // 撤一处小改动却报数万 touched。改用 revert 前的 live 快照 currentSnap：两边同口径，touched 恰为本次
    // revert 实际改动的节点。
    const entries = store.computeDiff(currentSnap, finalSnapshot);
    const shortId = String(normalizedCommitId).slice(0, 8);
    const commit = store.createCommit({
      docId,
      summary: summary || `revert ${shortId}${target.summary ? `（${target.summary}）` : ''}`,
      snapshot: finalSnapshot,
      author: owner
    });
    if (!commit) throw new Error('revertCommit: createCommit returned no row');
    const touchedNodeIds = [...new Set(entries.filter((e: RowObject) => e.node_id).map((e: RowObject) => String(e.node_id)))];
    return { changed: true, blocked: false, docId, commitId: normalizedCommitId, revertCommitId: commit.id, touchedNodeIds };
  });
}
