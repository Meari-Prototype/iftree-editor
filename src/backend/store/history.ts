// 历史子系统（projectneed 15-5 / 18-3）：内容寻址 commit 之上的读写业务层——文档级历史列表 /
// 节点级历史 / 恢复（reset）/ 反向提交（revert）/ human 背书认证 / 对象库 GC。纯函数模块，门面
// IftreeStore 实例作第一参数传入：commit / 对象库快照原语与历史业务统一归本模块；尚留门面的
// live snapshot/restore 原语（createSnapshot / restoreSnapshot）和事务（store.withTransaction）经它访问。
// 模块不运行时反向 import 门面，index.ts 上保留同名方法做一行转调。

import { classifyThreeWayMerge } from '../../core/merkle-merge.js';
import type Database from 'better-sqlite3';
import { normalizeNodeType } from '../../core/node-model.js';
import { newStableId, requireStableId } from '../db/ids.js';
import { assertRestorableSnapshotPayload, computeSnapshotDiff } from '../db/snapshot-history.js';
import {
  normalizeNodeSizeMode,
  normalizePositiveNumber,
  normalizeSourcePosition,
  normalizeTreeViewState
} from '../db/normalizers.js';
import {
  buildCommitMeta,
  createTreeLocateCaches,
  gcObjects,
  locateNodeInTree,
  materializeTree,
  readSource,
  readSpanMap,
  writeSource,
  writeSpanMap,
  writeTreeIncremental,
  writeTree as writeCommitTree
} from '../db/object-store.js';
import type { NodePosition, SpanLink, SpanMapPayload } from '../db/object-store.js';
import type { TreeNodeLocation } from '../db/object-store.js';
import type { IncrementalTreeRow } from '../db/object-store.js';
import { parseJsonObject } from '../shared.js';
import type { AxiomRow, CommitRow, DocRow, EntityNodeBindingRow, NodeRow, RefRow, SourceDocumentRow, SourceSpanRow } from '../db/schema.js';
import type { MerkleNode } from '../../core/merkle.js';

// 从 head 沿 parent_commit_id 上溯，返回祖先链 commit id（head 在前、根在后）。git log 只走这条链——
// restore/reset 把 head 移到旧 commit 后，被跳过的"未来" commit 不在链上、从 log 消失（仍可凭 id 直接访问，充当 reflog）。
type RowObject = Record<string, unknown>;
type SnapshotHistoryPayload = Parameters<typeof computeSnapshotDiff>[0];
// live 快照标记：createSnapshot 直读 nodes 表的产物才带（Symbol 键——对象 spread 保留、
// JSON.stringify 丢弃，投影/对象库重建的快照天然没有）。createCommit 凭它决定走增量写树：
// writeTreeIncremental 的前提正是「行直读自 nodes 表」（tree_object_hash 列缓存对应 live 行）。
const LIVE_ROWS_SNAPSHOT: unique symbol = Symbol('liveRowsSnapshot');
export type SnapshotPayload = SnapshotHistoryPayload & {
  doc?: RowObject | null;
  sourceDocument?: (Partial<SourceDocumentRow> & { raw_markdown?: unknown }) | null;
  // 句位归属（span→node + nodes.source_position）。两个字段互斥地表达同一件事：
  // - spanMapHash：docs 列缓存命中（归属自上次写快照以来没动），createCommit 直接复用该 hash、零重算。
  // - spanMap：脏位为 1 时 createSnapshot 现扫出的内容，由 createCommit 写成对象。
  // restoreSnapshot 只看 spanMap，且用 hasOwnProperty 区分「字段缺失」（旧 commit / revert 自构造
  // 快照 → 退回现行行为）与「字段在但 links 为空」（该版本确实没有归属 → 全置 NULL）。
  spanMapHash?: string | null;
  spanMap?: SpanMapPayload;
  [LIVE_ROWS_SNAPSHOT]?: true;
};
export type CommitPayload = {
  docId?: unknown;
  summary?: unknown;
  snapshot?: SnapshotPayload;
  entries?: unknown[] | null;
  committedAt?: unknown;
  author?: unknown;
};
export type CommitSnapshotRow = CommitRow & { snapshot?: string | null; diff?: string | null };
type SnapshotRow = NonNullable<SnapshotPayload['nodes']>[number];
type NodeHashContentRow = Pick<NodeRow, 'id' | 'text' | 'node_title' | 'node_note' | 'node_type' | 'trust_level'> & MerkleNode;

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

export interface HistoryStore {
  db: Database | null;
  readonly: boolean;
  editorSnapshots: { liveRoots(): { treeHashes: string[]; sourceHashes: string[]; spanMapHashes: string[] } };
  listAxioms(docId: unknown): AxiomRow[];
  refreshDocAddresses(docId: unknown): { updated: number };
  removeRootAxiomRefs(docId?: unknown): void;
  touchDoc(docId: unknown): void;
  withTransaction<T>(fn: () => T): T;
}

// 句位归属采集（只读，供 createSnapshot / writeDocSnapshotObjects 共用）。
// 脏位为 0 且列缓存在 → 返回 { spanMapHash }，一行不读；否则现扫 source_spans + nodes.source_position。
// 扫描顺序必须确定（ORDER BY 全给足），否则同一份归属会因行序不同算出不同 hash、白白多存对象。
function collectSpanMap(store: HistoryStore, docId: unknown): Pick<SnapshotPayload, 'spanMapHash' | 'spanMap'> {
  const doc = store.db!.prepare('SELECT span_map_hash, span_map_dirty FROM docs WHERE id = ?')
    .get<Pick<DocRow, 'span_map_hash' | 'span_map_dirty'>>(docId);
  if (doc && Number(doc.span_map_dirty) === 0) return { spanMapHash: doc.span_map_hash ?? null };

  const links = store.db!.prepare(`
    SELECT sentence_index, node_id FROM source_spans
    WHERE doc_id = ? ORDER BY sentence_index, id
  `).all<Pick<SourceSpanRow, 'sentence_index' | 'node_id'>>(docId)
    .map((row): SpanLink => ({ sentenceIndex: Number(row.sentence_index), nodeId: row.node_id ?? null }));
  const nodePositions = store.db!.prepare(`
    SELECT id, source_position FROM nodes
    WHERE doc_id = ? AND source_position IS NOT NULL ORDER BY id
  `).all<Pick<NodeRow, 'id' | 'source_position'>>(docId)
    .map((row): NodePosition => ({ nodeId: String(row.id), sourcePosition: Number(row.source_position) }));
  return { spanMap: nodePositions.length > 0 ? { links, nodePositions } : { links } };
}

// 快照的句位归属 → 对象库，返回 commit.span_map_hash 该写什么。缓存命中直接透传 hash；
// 现扫过则写对象并回写 docs 列缓存 + 清脏位（纪律同 tree_object_hash：**对象写完才回写列**，
// 保证「列上有 hash ⇒ 对象在库里」；gc 之后全列作废，见 gcHistoryObjects）。
function persistSpanMap(store: HistoryStore, docId: unknown, snapshot: SnapshotPayload): string | null {
  if (!Object.prototype.hasOwnProperty.call(snapshot, 'spanMap')) {
    return snapshot.spanMapHash ?? null;
  }
  const hash = writeSpanMap(store.db!, snapshot.spanMap || { links: [] });
  if (!store.readonly) {
    store.db!.prepare('UPDATE docs SET span_map_hash = ?, span_map_dirty = 0 WHERE id = ?').run(hash, docId);
  }
  return hash;
}

// commit 写入（内容寻址）：节点树与源文写对象库，doc/axioms/refs 与 operation entries 内联 meta。
export function createCommit(store: HistoryStore, {
  docId,
  summary = null,
  snapshot = {},
  entries = null,
  committedAt = null,
  author = null
}: CommitPayload) {
  const normalizedDocId = requireStableId(docId, 'commit docId');
  const head = store.db!.prepare('SELECT head_commit_id FROM doc_heads WHERE doc_id = ?')
    .get<Pick<CommitRow, 'parent_commit_id'> & { head_commit_id: string | null }>(normalizedDocId);
  const commitId = newStableId();
  const snapshotNodes = (snapshot.nodes || []) as MerkleNode[];
  let tree: { root_node_id: string; root_tree_hash: string } | null;
  if (snapshot[LIVE_ROWS_SNAPSHOT] === true) {
    // live 直读快照 → 增量写树：列缓存有效的子树整棵剪掉（不算 hash、不写对象），
    // 稳态保存 O(N) → O(脏节点 ∪ 祖先链)。重算过的节点回写 tree_object_hash 列
    // （纪律：对象写完才回写；触发器不监听该列，回写不自我失效）。
    const rowsById = new Map(snapshotNodes.map((node) => [String(node.id), node]));
    const incremental = writeTreeIncremental(
      store.db!,
      snapshotNodes as IncrementalTreeRow[],
      (id) => rowsById.get(id) || null
    );
    if (incremental && !store.readonly && incremental.recomputed.size > 0) {
      const updateHash = store.db!.prepare('UPDATE nodes SET tree_object_hash = ? WHERE id = ?');
      for (const [id, hash] of incremental.recomputed) updateHash.run(hash, id);
    }
    tree = incremental;
  } else {
    tree = writeCommitTree(store.db!, snapshotNodes);
  }
  const sourceHash = writeSource(store.db!, snapshot.sourceDocument?.raw_markdown);
  const spanMapHash = persistSpanMap(store, normalizedDocId, snapshot);
  const meta = buildCommitMeta(snapshot, entries);

  store.db!.prepare(`
    INSERT INTO commits (id, doc_id, parent_commit_id, committed_at, summary, author, root_node_id, root_tree_hash, source_hash, span_map_hash, meta)
    VALUES (?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?, ?, ?, ?, ?, ?)
  `).run(
    commitId,
    normalizedDocId,
    head?.head_commit_id || null,
    committedAt,
    summary,
    author || null,
    tree?.root_node_id || null,
    tree?.root_tree_hash || null,
    sourceHash,
    spanMapHash,
    JSON.stringify(meta)
  );
  store.db!.prepare(`
    INSERT INTO doc_heads (doc_id, head_commit_id, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(doc_id) DO UPDATE SET
      head_commit_id = excluded.head_commit_id,
      updated_at = CURRENT_TIMESTAMP
  `).run(normalizedDocId, commitId);
  return store.db!.prepare('SELECT * FROM commits WHERE id = ?').get<CommitRow>(commitId);
}

function legacyCommitSnapshot(row: CommitSnapshotRow | null | undefined) {
  if (!row) return null;
  try {
    const snapshot = JSON.parse(row.snapshot || 'null');
    if (snapshot?.nodes) return snapshot;
  } catch { /* fall through */ }
  try {
    const diff = JSON.parse(row.diff || '{}');
    const snapshot = diff.snapshot || (diff.kind === 'snapshot' ? diff : null);
    if (snapshot?.nodes) return snapshot;
  } catch { /* ignore */ }
  return null;
}

// commit 行 → 完整快照的唯一重建口；未迁移旧行回退 legacy snapshot/diff 列。
export function commitSnapshotFromRow(store: HistoryStore, row: CommitSnapshotRow | null | undefined) {
  if (!row) return null;
  if (!row.root_tree_hash) {
    const legacy = legacyCommitSnapshot(row);
    return legacy?.nodes ? legacy : null;
  }
  const nodes = materializeTree(store.db!, row.root_tree_hash, row.root_node_id);
  const meta = parseJsonObject(row.meta) || {};
  const sourceMeta = meta.sourceDocument || null;
  const rawMarkdown = readSource(store.db!, row.source_hash);
  return {
    doc: meta.doc ?? null,
    nodes,
    axioms: Array.isArray(meta.axioms) ? meta.axioms : [],
    refs: Array.isArray(meta.refs) ? meta.refs : [],
    sourceDocument: sourceMeta
      ? { ...sourceMeta, raw_markdown: rawMarkdown }
      : (row.source_hash ? { raw_markdown: rawMarkdown } : null),
    // 句位归属：只在该 commit 真带 span_map_hash 时才设这个字段。旧 commit（本机制之前的行）
    // 一律不设——restoreSnapshot 据 hasOwnProperty 退回现行行为（按恢复前 live 链接过滤）。
    ...(row.span_map_hash ? { spanMap: readSpanMap(store.db!, row.span_map_hash) } : {})
  };
}

export function commitSnapshot(store: HistoryStore, commitId: unknown) {
  const row = store.db!.prepare('SELECT * FROM commits WHERE id = ?').get<CommitSnapshotRow>(commitId);
  return commitSnapshotFromRow(store, row);
}

export function computeDiff(_store: HistoryStore, prevSnapshot: SnapshotPayload, currentSnapshot: SnapshotPayload) {
  return computeSnapshotDiff(prevSnapshot, currentSnapshot);
}

export function createSnapshot(store: HistoryStore, docId: unknown): SnapshotPayload {
  const doc = store.db!.prepare('SELECT id, meta, axioms_collapsed, tree_view_state FROM docs WHERE id = ?')
    .get<Pick<DocRow, 'id' | 'meta' | 'axioms_collapsed' | 'tree_view_state'>>(docId) || null;
  const sourceDocument = store.db!.prepare('SELECT * FROM source_documents WHERE doc_id = ?').get<SourceDocumentRow>(docId) || null;
  const nodes = store.db!.prepare('SELECT * FROM nodes WHERE doc_id = ? ORDER BY id').all<NodeRow>(docId);
  const refs = nodes.length === 0
    ? []
    : store.db!.prepare(`
      SELECT * FROM refs
      WHERE (source_type = 'node' AND source_id IN (SELECT id FROM nodes WHERE doc_id = ?))
         OR (target_type = 'node' AND target_id IN (SELECT id FROM nodes WHERE doc_id = ?))
      ORDER BY id
    `).all<RefRow>(docId, docId);
  return {
    // 直读 nodes 表的标记：createCommit 凭它走增量写树（见 LIVE_ROWS_SNAPSHOT）。
    [LIVE_ROWS_SNAPSHOT]: true,
    doc,
    nodes: nodes as unknown as SnapshotPayload['nodes'],
    axioms: store.listAxioms(docId) as unknown as SnapshotPayload['axioms'],
    refs: refs as unknown as SnapshotPayload['refs'],
    sourceDocument,
    // 句位归属：脏位为 0 时这里零读、只带一个缓存 hash（稳态保存的常态）。
    ...collectSpanMap(store, docId)
  };
}

export function assertRestorableSnapshot(_store: HistoryStore, snapshot: SnapshotPayload | null | undefined) {
  return assertRestorableSnapshotPayload(snapshot);
}

// live 文档直接写对象库快照，供 editor undo token 持有，不建 commits/doc_heads 行。
export function writeDocSnapshotObjects(store: HistoryStore, docId: unknown) {
  return store.withTransaction(() => {
    const rows = store.db!.prepare(
      'SELECT id, parent_id, sort_order, tree_object_hash FROM nodes WHERE doc_id = ?'
    ).all<Pick<NodeRow, 'id' | 'parent_id' | 'sort_order' | 'tree_object_hash'> & MerkleNode>(docId);
    const rootCount = rows.reduce((count, row) => (row.parent_id === null ? count + 1 : count), 0);
    if (rows.length === 0 || rootCount !== 1) throw new Error('Refusing to restore an incomplete document snapshot');
    const contentStmt = store.db!.prepare(
      'SELECT id, text, node_title, node_note, node_type, trust_level FROM nodes WHERE id = ? AND doc_id = ?'
    );
    const tree = writeTreeIncremental(store.db!, rows, (id) => contentStmt.get<NodeHashContentRow>(id, docId));
    if (!tree) throw new Error('Refusing to restore an incomplete document snapshot');
    if (!store.readonly && tree.recomputed.size > 0) {
      const update = store.db!.prepare('UPDATE nodes SET tree_object_hash = ? WHERE id = ?');
      for (const [id, hash] of tree.recomputed) update.run(hash, id);
    }
    const doc = store.db!.prepare('SELECT id, meta, axioms_collapsed, tree_view_state FROM docs WHERE id = ?')
      .get<Pick<DocRow, 'id' | 'meta' | 'axioms_collapsed' | 'tree_view_state'>>(docId) || null;
    const sourceDocument = store.db!.prepare('SELECT * FROM source_documents WHERE doc_id = ?').get<SourceDocumentRow>(docId) || null;
    const refs = store.db!.prepare(`
      SELECT * FROM refs
      WHERE (source_type = 'node' AND source_id IN (SELECT id FROM nodes WHERE doc_id = ?))
         OR (target_type = 'node' AND target_id IN (SELECT id FROM nodes WHERE doc_id = ?))
      ORDER BY id
    `).all<RefRow>(docId, docId);
    const meta = buildCommitMeta({
      doc,
      axioms: store.listAxioms(docId) as unknown[],
      refs,
      sourceDocument
    });
    return {
      id: '',
      doc_id: String(docId),
      parent_commit_id: null,
      committed_at: '',
      summary: null,
      author: null,
      root_node_id: tree.root_node_id,
      root_tree_hash: tree.root_tree_hash,
      source_hash: writeSource(store.db!, sourceDocument?.raw_markdown),
      // undo token 与历史 commit 同一条口径：不写 spanmap，undo/redo 跨拆句边界照样丢归属。
      span_map_hash: persistSpanMap(store, docId, collectSpanMap(store, docId)),
      meta: JSON.stringify(meta)
    };
  });
}

export function insertSnapshotNodes(store: HistoryStore, nodes: SnapshotRow[], docId: unknown = null) {
  const nowIso = new Date().toISOString();
  const insertNode = store.db!.prepare(`
    INSERT INTO nodes (
      id, doc_id, parent_id, sort_order, node_type, text, node_title, node_note, source_position,
      trust_level, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const runInsert = (node: SnapshotRow) => insertNode.run(
    node.id,
    docId ?? node.doc_id,
    node.parent_id,
    node.sort_order,
    normalizeNodeType(node.node_type),
    node.text,
    node.node_title || '',
    node.node_note || '',
    normalizeSourcePosition(node.source_position),
    node.trust_level,
    node.created_at ?? nowIso,
    node.updated_at ?? nowIso
  );
  const childrenByParent = new Map<string, SnapshotRow[]>();
  const roots: SnapshotRow[] = [];
  for (const node of nodes) {
    if (node.parent_id === null || node.parent_id === undefined) {
      roots.push(node);
      continue;
    }
    const key = String(node.parent_id);
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key)!.push(node);
  }
  const queue = [...roots];
  let head = 0;
  while (head < queue.length) {
    const node = queue[head]!;
    head += 1;
    runInsert(node);
    const children = childrenByParent.get(String(node.id));
    if (children) for (const child of children) queue.push(child);
  }
  if (head !== nodes.length) throw new Error('Snapshot contains unresolved node parents');
}

// 句位归属写回（restore 的精确分支）。调用方保证：本文档的节点刚被 DELETE+重插，故所有
// source_spans.node_id 已被 ON DELETE SET NULL 清成 NULL、nodes.source_position 已被
// insertSnapshotNodes 写成 NULL（对象库不存该列）——这里只管把该 commit 时代的值盖回去。
//
// 走 temp 表 + UPDATE…FROM 而不是逐行 run：50 万 span 的文档逐行要 50 万次 JS↔C 往返 + 50 万次
// 索引查找 + 50 万次脏位触发器（首行之后全是不命中的 no-op，但仍要执行）。temp 表由 json_each
// 一次灌满（零 JS 循环），UPDATE 侧走 idx_source_spans_doc 覆盖索引 + temp 表主键查找。
//
// snapshotNodeIds 过滤是硬要求，不是防御性洁癖：source_spans.node_id 有 FK，指向快照里不存在的
// 节点会直接 FOREIGN KEY constraint failed 炸掉整个 restore 事务。不在快照里的一律写 NULL。
function restoreSpanMap(
  store: HistoryStore,
  docId: unknown,
  spanMap: SpanMapPayload,
  snapshotNodeIds: Set<unknown>
) {
  const linkPairs: Array<[number, string | null]> = [];
  for (const link of spanMap.links || []) {
    const sentenceIndex = Number(link.sentenceIndex);
    if (!Number.isFinite(sentenceIndex)) continue;
    const nodeId = link.nodeId != null && snapshotNodeIds.has(link.nodeId) ? link.nodeId : null;
    linkPairs.push([sentenceIndex, nodeId]);
  }
  if (linkPairs.length > 0) {
    store.db!.prepare(
      'CREATE TEMP TABLE IF NOT EXISTS _restore_span_links (sentence_index INTEGER PRIMARY KEY, node_id TEXT)'
    ).run();
    store.db!.prepare('DELETE FROM _restore_span_links').run();
    store.db!.prepare(`
      INSERT OR REPLACE INTO _restore_span_links (sentence_index, node_id)
      SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)
    `).run(JSON.stringify(linkPairs));
    store.db!.prepare(`
      UPDATE source_spans SET node_id = l.node_id
      FROM _restore_span_links l
      WHERE l.sentence_index = source_spans.sentence_index AND source_spans.doc_id = ?
    `).run(docId);
    store.db!.prepare('DELETE FROM _restore_span_links').run();
  }

  const positionPairs: Array<[string, number]> = [];
  for (const entry of spanMap.nodePositions || []) {
    const position = Number(entry.sourcePosition);
    if (!entry.nodeId || !Number.isFinite(position) || !snapshotNodeIds.has(entry.nodeId)) continue;
    positionPairs.push([String(entry.nodeId), position]);
  }
  if (positionPairs.length > 0) {
    store.db!.prepare(
      'CREATE TEMP TABLE IF NOT EXISTS _restore_node_positions (node_id TEXT PRIMARY KEY, source_position REAL)'
    ).run();
    store.db!.prepare('DELETE FROM _restore_node_positions').run();
    store.db!.prepare(`
      INSERT OR REPLACE INTO _restore_node_positions (node_id, source_position)
      SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)
    `).run(JSON.stringify(positionPairs));
    store.db!.prepare(`
      UPDATE nodes SET source_position = p.source_position
      FROM _restore_node_positions p
      WHERE p.node_id = nodes.id AND nodes.doc_id = ?
    `).run(docId);
    store.db!.prepare('DELETE FROM _restore_node_positions').run();
  }
}

export function restoreSnapshot(store: HistoryStore, docId: unknown, snapshot: SnapshotPayload) {
  const snapshotNodes = assertRestorableSnapshot(store, snapshot);
  store.withTransaction(() => {
    if (snapshot.doc) {
      const hasMeta = Object.prototype.hasOwnProperty.call(snapshot.doc, 'meta');
      const hasAxiomsCollapsed = Object.prototype.hasOwnProperty.call(snapshot.doc, 'axioms_collapsed');
      const hasTreeViewState = Object.prototype.hasOwnProperty.call(snapshot.doc, 'tree_view_state');
      if (hasMeta || hasAxiomsCollapsed || hasTreeViewState) {
        const current = store.db!.prepare('SELECT meta, axioms_collapsed, tree_view_state FROM docs WHERE id = ?')
          .get<Pick<DocRow, 'meta' | 'axioms_collapsed' | 'tree_view_state'>>(docId) ?? {
            meta: null,
            axioms_collapsed: 0,
            tree_view_state: '{}'
          };
        store.db!.prepare('UPDATE docs SET meta = ?, axioms_collapsed = ?, tree_view_state = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(
            hasMeta ? (snapshot.doc.meta || null) : current.meta,
            hasAxiomsCollapsed ? (snapshot.doc.axioms_collapsed ? 1 : 0) : (current.axioms_collapsed ? 1 : 0),
            hasTreeViewState ? normalizeTreeViewState(snapshot.doc.tree_view_state) : (current.tree_view_state || '{}'),
            docId
          );
      }
    }
    if (Object.prototype.hasOwnProperty.call(snapshot, 'sourceDocument')) {
      store.db!.prepare('DELETE FROM source_documents WHERE doc_id = ?').run(docId);
      if (snapshot.sourceDocument) {
        store.db!.prepare(`
          INSERT INTO source_documents (doc_id, source_type, original_path, raw_markdown, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          docId,
          snapshot.sourceDocument.source_type || 'file',
          snapshot.sourceDocument.original_path || null,
          snapshot.sourceDocument.raw_markdown || '',
          snapshot.sourceDocument.created_at || new Date().toISOString()
        );
      }
    }
    // 句位归属分两条路，由「快照有没有 spanMap 字段」决定（hasOwnProperty，不是真假值——
    // 「字段在但 links 为空」表示该版本确实没有归属，要全置 NULL，与「字段缺失」语义不同）：
    //   有 → 该 commit 带了自己的归属对象，按 (doc_id, sentence_index) 精确还原到那个时代；
    //   无 → 旧 commit（本机制之前的行）或 revertCommit 自构造的快照，退回现行行为：
    //        只把「恢复前 live 的链接」中节点仍在快照里的那部分挂回，其余留 NULL。
    const hasSpanMap = Object.prototype.hasOwnProperty.call(snapshot, 'spanMap');
    // 现行行为要的 live 链接：只在没有 spanMap 时才读（有 spanMap 时这趟 O(N) 读纯属浪费）。
    const sourceSpanLinks = hasSpanMap ? [] : store.db!.prepare(`
      SELECT id, node_id FROM source_spans
      WHERE doc_id = ? AND node_id IS NOT NULL
    `).all<Pick<SourceSpanRow, 'id' | 'node_id'>>(docId);
    // 实体绑定（13 章）：entity_node_bindings.node_id 是 ON DELETE CASCADE，下面的
    // DELETE FROM nodes 会连带清空本文档的全部绑定，而快照里不含绑定、重插节点也不会带回来——
    // 不先存后补，undo/restore/revert 就会静默清空实体标注。照 sourceSpanLinks 的做法先读后写回。
    const entityBindings = store.db!.prepare(`
      SELECT entity_id, node_id, status, created_at, updated_at FROM entity_node_bindings
      WHERE node_id IN (SELECT id FROM nodes WHERE doc_id = ?)
    `).all<Omit<EntityNodeBindingRow, 'id'>>(docId);
    const snapshotNodeIds = new Set(snapshotNodes.map((node) => node.id));
    store.db!.prepare(`
      DELETE FROM refs
      WHERE (source_type = 'node' AND source_id IN (SELECT id FROM nodes WHERE doc_id = ?))
         OR (target_type = 'node' AND target_id IN (SELECT id FROM nodes WHERE doc_id = ?))
    `).run(docId, docId);
    store.db!.prepare('DELETE FROM axioms WHERE doc_id = ?').run(docId);
    store.db!.prepare('DELETE FROM nodes WHERE doc_id = ?').run(docId);
    insertSnapshotNodes(store, snapshotNodes, docId);
    if (hasSpanMap) {
      restoreSpanMap(store, docId, snapshot.spanMap || { links: [] }, snapshotNodeIds);
    } else {
      const restoreSourceSpan = store.db!.prepare('UPDATE source_spans SET node_id = ? WHERE id = ?');
      for (const link of sourceSpanLinks) {
        if (snapshotNodeIds.has(link.node_id)) restoreSourceSpan.run(link.node_id, link.id);
      }
    }
    // 绑定写回：只认快照里还在的节点（被该版本删掉的节点，其绑定随之作废）。
    // 不保留原自增 id——id 只是内部主键、业务键是 UNIQUE(entity_id, node_id)，没有外部引用；
    // 强行复用反而可能撞上期间别的文档占用的 id。OR IGNORE 兜 UNIQUE（正常不会撞，级联已清空）。
    const restoreEntityBinding = store.db!.prepare(`
      INSERT OR IGNORE INTO entity_node_bindings (entity_id, node_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const binding of entityBindings) {
      if (!snapshotNodeIds.has(binding.node_id)) continue;
      restoreEntityBinding.run(binding.entity_id, binding.node_id, binding.status, binding.created_at, binding.updated_at);
    }
    const insertAxiom = store.db!.prepare(`
      INSERT INTO axioms (id, doc_id, label, content, status, node_title, node_note, node_width, node_height, node_size_mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const axiom of snapshot.axioms || []) {
      const width = normalizePositiveNumber(axiom.node_width);
      const height = normalizePositiveNumber(axiom.node_height);
      const sizeMode = normalizeNodeSizeMode(axiom.node_size_mode ?? (width !== null && height !== null ? 'manual' : 'auto'));
      insertAxiom.run(
        axiom.id,
        axiom.doc_id,
        axiom.label,
        axiom.content,
        axiom.status,
        axiom.node_title || '',
        axiom.node_note || '',
        sizeMode === 'manual' ? width : null,
        sizeMode === 'manual' ? height : null,
        sizeMode
      );
    }
    const insertRef = store.db!.prepare(`
      INSERT INTO refs (id, source_type, source_id, target_type, target_id, ref_kind, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const ref of snapshot.refs || []) {
      insertRef.run(ref.id, ref.source_type, ref.source_id, ref.target_type, ref.target_id, ref.ref_kind, ref.note);
    }
    store.removeRootAxiomRefs(docId);
    store.refreshDocAddresses(docId);
    store.touchDoc(docId);
  });
}

function commitAncestry(store: HistoryStore, docId: string): string[] {
  // 一条递归 CTE 取整条祖先链（原先逐 commit 一次点查，C 个 commit = C 次串行查询）。
  // 语义与原 while 循环一致：head 在前、根在后（depth 序）。环防御：depth 上限 = 表行数
  // （无环时远达不到；有环时截断），JS 侧 seen 去重保持首个（= 链上首次）。
  const rows = store.db!.prepare(`
    WITH RECURSIVE ancestry(id, depth) AS (
      SELECT head_commit_id, 0 FROM doc_heads WHERE doc_id = ? AND head_commit_id IS NOT NULL
      UNION ALL
      SELECT c.parent_commit_id, a.depth + 1
      FROM commits c JOIN ancestry a ON c.id = a.id
      WHERE c.parent_commit_id IS NOT NULL
        AND a.depth < (SELECT COUNT(*) FROM commits)
    )
    SELECT id FROM ancestry ORDER BY depth
  `).all<Pick<CommitRow, 'id'>>(docId);
  const chain: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = String(row.id);
    if (seen.has(id)) continue;
    seen.add(id);
    chain.push(id);
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

export function listHistory(store: HistoryStore, docId: string): HistoryEntry[] {
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
export function nodeHistory(store: HistoryStore, docId: unknown, address: unknown, { scope = 'subtree' } = {}) {
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

  // O(K) 剪枝：先在对象库 tree 图上定位目标（locateNodeInTree，带跨 commit memo，每个
  // commit 只走改动路径 + 目标祖先链），相邻 commit 的目标指纹全同（scope=subtree 比子树
  // treeHash / scope=node 比内容 blobHash，均并比 parentNodeId+childIndex 位置——子树 hash
  // 覆盖不到目标自身被移动的 __moved__ 情形）就直接跳过；指纹不同或 legacy commit（无
  // root_tree_hash，location=undefined）才回退物化整树 + computeSnapshotDiff，保证 entry
  // 形态与 changeCount 语义和全量路径逐字节一致。
  const caches = createTreeLocateCaches();
  const locations: Array<TreeNodeLocation | null | undefined> = commits.map((commit) => (
    commit.root_tree_hash
      ? locateNodeInTree(store.db!, commit.root_tree_hash, commit.root_node_id, targetId, caches)
      : undefined
  ));
  const sameLocation = (a: TreeNodeLocation, b: TreeNodeLocation) => (
    (scope === 'node' ? a.blobHash === b.blobHash : a.treeHash === b.treeHash)
    && a.parentNodeId === b.parentNodeId
    && a.childIndex === b.childIndex
  );

  // 回退物化按需进行：上一 commit 的快照只在真要 diff 时才重建（单槽缓存避免重复物化）。
  let materialized: { index: number; snapshot: RowObject } | null = null;
  const snapshotAt = (index: number): RowObject => {
    if (materialized?.index !== index) {
      materialized = { index, snapshot: (commitSnapshotFromRow(store, commits[index]!) || { nodes: [] }) as RowObject };
    }
    return materialized.snapshot;
  };

  const entries = [];
  for (let i = 0; i < commits.length; i += 1) {
    const commit = commits[i]!;
    const cur = locations[i];
    const prev = i > 0 ? locations[i - 1] : null;

    let changes: RowObject[] = [];
    let changed = false;
    if (i === 0) {
      // 首 commit：changed ⟺ 目标当时存在（原实现 members 命中判定的等价形式）；legacy 回退物化判。
      if (cur !== undefined) {
        changed = cur !== null;
      } else {
        const snapshot = snapshotAt(0);
        changed = ((snapshot.nodes || []) as RowObject[]).some((node) => String(node.id) === String(targetId));
      }
    } else if (cur !== undefined && prev !== undefined) {
      if (cur === null && prev === null) {
        changed = false; // 两侧都无目标：diff 过滤后必为空
      } else if (cur !== null && prev !== null && sameLocation(prev, cur)) {
        changed = false; // 指纹全同：目标（或其子树）与挂载位置均未变
      } else {
        const prevSnapshot = snapshotAt(i - 1);
        const snapshot = snapshotAt(i);
        const members = scope === 'node'
          ? new Set([targetId])
          : new Set([
            ...subtreeMemberIds(prevSnapshot, targetId),
            ...subtreeMemberIds(snapshot, targetId)
          ]);
        changes = computeSnapshotDiff(prevSnapshot, snapshot).filter((entry) => members.has(entry.node_id));
        changed = changes.length > 0;
      }
    } else {
      // legacy commit（任一侧无 root_tree_hash）：走原全量路径。
      const prevSnapshot = snapshotAt(i - 1);
      const snapshot = snapshotAt(i);
      const members = scope === 'node'
        ? new Set([targetId])
        : new Set([
          ...subtreeMemberIds(prevSnapshot, targetId),
          ...subtreeMemberIds(snapshot, targetId)
        ]);
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
  }
  entries.reverse();
  return entries;
}

// 对象库 GC（独立运维动词，不在写热路径）：回收没被任何 commit（或活 undo token）引用的
// blob/tree/source 对象。reset/revert 后不自动跑——留「可后悔」窗口；需要时手动触发。
export function gcHistoryObjects(store: HistoryStore) {
  return store.withTransaction(() => {
    const result = gcObjects(store.db!, store.editorSnapshots.liveRoots());
    // 列缓存的前提是「hash 在列上 ⇒ 对象在库里」；sweep 之后无法廉价证明哪些缓存仍指向存活
    // 对象，一律作废（gc 低频，下次写快照全量重建缓存），换悬挂引用绝迹。
    store.db!.prepare('UPDATE nodes SET tree_object_hash = NULL WHERE tree_object_hash IS NOT NULL').run();
    // docs 的 spanmap 列缓存同理：置脏 + 清 hash，下次写快照全量重扫一遍归属。
    store.db!.prepare('UPDATE docs SET span_map_hash = NULL, span_map_dirty = 1 WHERE span_map_hash IS NOT NULL OR span_map_dirty = 0').run();
    return result;
  });
}

export function saveHistorySnapshot(store: HistoryStore, { docId, summary = '保存版本', owner = 'human' }: SaveHistorySnapshotPayload) {
  // 全量读移出写事务：安全性靠「createSnapshot 与 withTransaction 之间同步连续、无 await」——
  // 这两行之间不得引入任何 await/async 化（一旦出现异步窗口，其他写入即可插队使快照与提交脱节）。
  // 事务内只剩增量 hash/对象写 + commits/doc_heads 两条原子写——持锁时长从 O(N) 降到 O(depth)。
  const currentSnapshot = createSnapshot(store, docId);
  return store.withTransaction(() => {
    // diff 不再持久化（按需由 query-api 现算）；createCommit 把快照拆进对象库 + 内联 meta。
    const commit = createCommit(store, {
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
export function certifyNodes(store: HistoryStore, { docId, nodeId = null, address = null, scope = 'subtree', trust = '受控', owner = 'human' }: CertifyNodesPayload = {} as CertifyNodesPayload) {
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
export function restoreCommit(store: HistoryStore, commitId: unknown) {
  return store.withTransaction(() => {
    const commit = store.db!.prepare('SELECT * FROM commits WHERE id = ?').get<CommitRow>(commitId);
    if (!commit) throw new Error(`Commit not found: ${commitId}`);
    const snapshot = commitSnapshotFromRow(store, commit);
    if (!snapshot?.nodes) {
      throw new Error(`Commit is not restorable: ${commitId}`);
    }
    restoreSnapshot(store, commit.doc_id, snapshot);
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
export function revertCommit(store: HistoryStore, { commitId, owner = 'human', summary = null }: RevertCommitPayload = {} as RevertCommitPayload) {
  const normalizedCommitId = requireStableId(commitId, 'revert commitId');
  return store.withTransaction(() => {
    const target = store.db!.prepare('SELECT * FROM commits WHERE id = ?').get<CommitRow>(normalizedCommitId);
    if (!target) throw new Error(`revert 找不到 commit ${commitId}`);
    if (!target.parent_commit_id) throw new Error('revert 不能撤销初始提交（无父提交）');
    const parentRow = store.db!.prepare('SELECT * FROM commits WHERE id = ?').get<CommitRow>(target.parent_commit_id);
    if (!parentRow) throw new Error('revert 找不到父提交快照');
    const docId = target.doc_id;
    const baseSnap = commitSnapshotFromRow(store, target) || {};
    const parentSnap = commitSnapshotFromRow(store, parentRow) || {};
    const currentSnap = createSnapshot(store, docId);

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

    // 刻意不传 spanMap：revert 是「在当前主干上撤销一次改动」，句位归属应当跟着存活节点原地留在
    // 当前状态，而不是回到目标 commit 那个时代（那是 restore/reset 的语义）。少这个字段，
    // restoreSnapshot 的 hasOwnProperty 判定就走「缺失」分支 = 现行行为（按恢复前 live 链接过滤，
    // 被撤销掉的节点其 span 留 NULL）。**这一行是契约，别顺手补上 spanMap。**
    restoreSnapshot(store, docId, {
      doc: currentSnap.doc,
      sourceDocument: currentSnap.sourceDocument,
      nodes: targetNodes,
      axioms: currentSnap.axioms || [],
      refs: targetRefs
    });

    // 反向提交：parent = 当前 HEAD（createCommit 内部自取），保留历史链。
    const finalSnapshot = createSnapshot(store, docId);
    // 回执 touched 集合 = revert 前后两份 live 快照之差。早先拿 HEAD commit 的 materialize 快照做 prev，
    // 会与 live 的 finalSnapshot 跨口径比较：canonicalNodeContent 把 node_title/node_note 的 null 归一成
    // ''，而 materializeTree 不还原（只还原 trust_level），于是每个标题/备注为 NULL 的节点都被误判改动——
    // 撤一处小改动却报数万 touched。改用 revert 前的 live 快照 currentSnap：两边同口径，touched 恰为本次
    // revert 实际改动的节点。
    const entries = computeDiff(store, currentSnap, finalSnapshot);
    const shortId = String(normalizedCommitId).slice(0, 8);
    const commit = createCommit(store, {
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
