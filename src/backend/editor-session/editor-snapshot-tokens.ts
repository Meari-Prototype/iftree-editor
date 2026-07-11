// 编辑器易失撤销/重做令牌——进程内 Map，与持久化历史（commits / 内容寻址对象库）是两套机制
// （后端解耦第 1 步：从主库存储类剥离）。store 析构即令牌全失，符合「易失」语义。
//
// 存储底座（对象库化）：token 不再驻留全量 JS 快照（旧实现每次写前全表 SELECT 含正文进内存、
// 80 个栈位轻松吃掉 GB 级），只持一份 commit 行同形的引用 { root_tree_hash, source_hash, meta }——
// 快照本体进内容寻址对象库（按 hash 去重，未变子树零成本，写量 O(改动×深度)）。
// 恢复经 store.commitSnapshotFromRow 展开（与恢复历史 commit 完全同一条路径，含重复 id 防线）。
// gc 语义：活 token 的对象根经 liveRoots() 并入 gcHistoryObjects 的可达集，token 弃置后
// 其独占对象变孤儿、由下次 gc 回收。
import { normalizePositiveId } from '../db/normalizers.js';
import { sameStableId } from '../db/ids.js';

// commit 行同形的对象库引用（writeDocSnapshotObjects 的返回）。带齐 CommitRow 的行字段
// （id 等填空值）是为了原样喂 store.commitSnapshotFromRow——不是真 commit，不进 commits 表。
interface SnapshotObjectsRow {
  id: string;
  doc_id: string;
  parent_commit_id: string | null;
  committed_at: string;
  summary: string | null;
  author: string | null;
  root_node_id: string;
  root_tree_hash: string;
  source_hash: string | null;
  meta: string;
}

interface EditorSnapshotStore {
  writeDocSnapshotObjects(docId: string): SnapshotObjectsRow;
  commitSnapshotFromRow(row: SnapshotObjectsRow): unknown;
  restoreSnapshot(docId: string, snapshot: unknown): void;
}

interface EditorSnapshotTokenEntry {
  docId: string;
  row: SnapshotObjectsRow;
}

export class EditorSnapshotTokens {
  private store: EditorSnapshotStore;
  private tokens: Map<string, EditorSnapshotTokenEntry>;
  private seq: number;

  constructor(store: EditorSnapshotStore) {
    this.store = store;
    this.tokens = new Map();
    this.seq = 1;
  }

  create(docId: unknown): { id: string; docId: string } {
    const normalizedDocId = normalizePositiveId(docId);
    if (!normalizedDocId) {
      throw new Error('editor history requires docId');
    }
    const row = this.store.writeDocSnapshotObjects(normalizedDocId);
    const tokenId = `editor-${this.seq++}`;
    this.tokens.set(tokenId, {
      docId: normalizedDocId,
      row
    });
    return { id: tokenId, docId: normalizedDocId };
  }

  restore({ docId, tokenId }: { docId: unknown; tokenId: unknown }): { id: string; docId: string } {
    const normalizedDocId = normalizePositiveId(docId);
    const normalizedTokenId = String(tokenId || '');
    const entry = this.tokens.get(normalizedTokenId);
    if (!entry) throw new Error('Editor history token not found');
    if (!sameStableId(entry.docId, normalizedDocId)) throw new Error('Editor history token belongs to another document');

    const redoToken = this.create(normalizedDocId);
    const snapshot = this.store.commitSnapshotFromRow(entry.row);
    this.store.restoreSnapshot(normalizedDocId as string, snapshot);
    this.tokens.delete(normalizedTokenId);
    return redoToken;
  }

  discard(tokenIds: unknown[] | unknown = []): number {
    const ids = Array.isArray(tokenIds) ? tokenIds : [tokenIds];
    let deleted = 0;
    for (const tokenId of ids) {
      if (this.tokens.delete(String(tokenId || ''))) deleted += 1;
    }
    return deleted;
  }

  // 活 token 引用的对象根（gc mark 阶段的额外可达根）：不并入 gc 会把活 token 的对象 sweep 掉。
  liveRoots(): { treeHashes: string[]; sourceHashes: string[] } {
    const treeHashes: string[] = [];
    const sourceHashes: string[] = [];
    for (const entry of this.tokens.values()) {
      if (entry.row.root_tree_hash) treeHashes.push(entry.row.root_tree_hash);
      if (entry.row.source_hash) sourceHashes.push(entry.row.source_hash);
    }
    return { treeHashes, sourceHashes };
  }
}
