import { createHash } from 'node:crypto';

// 条件树节点的 Merkle 哈希（A5-2）。
// - contentHash：节点「自身正文」的指纹，只看 5 个内容字段，与父级/位置无关。
// - subtreeHash：哈希(自身 contentHash + 各子节点 subtreeHash，按 sort_order)。同样 parent-independent，
//   所以一棵未变的子树搬到哪儿哈希都一样（这撑起「同 UUID 跨父=移动」「异 UUID 同 hash=收敛」）。
// 两者都用 sha256 截到 128 位（16 字节 / 32 hex）。Node 内置 crypto，零依赖；
// 选加密哈希是给将来同步/内容寻址对象库留门。

const HASH_HEX_LENGTH = 32; // 128 bits

export interface MerkleNode {
  id: number | string | null;
  parent_id?: number | string | null;
  parentId?: number | string | null;
  sort_order?: number;
  sortOrder?: number;
  [key: string]: unknown;
}

export interface SubtreeHashEntry {
  contentHash: string;
  subtreeHash: string;
}

// 内容寻址对象库（db/object-store.mjs）也用它给 raw_markdown 算 blob key，故导出复用。
export function sha256_128(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, HASH_HEX_LENGTH);
}

// 5 个内容字段，顺序固定。归一化与 store.mjs 的 normalizeDiffFieldValue 对齐，
// 保证「contentHash 变了」⟺ diff 判定该节点 modified。
// 刻意不含 sort_order / parent_id / source_position：位置与父级不进内容身份，
// 兄弟顺序由父节点 subtreeHash 的子哈希排列承载。
export const CONTENT_FIELDS = ['text', 'node_title', 'node_note', 'node_type', 'trust_level'];

const CAMEL_ALIAS: Record<string, string> = {
  node_title: 'nodeTitle',
  node_note: 'nodeNote',
  node_type: 'nodeType',
  trust_level: 'trustLevel'
};

function contentField(node: MerkleNode, field: string): string {
  const value = node[field] ?? node[CAMEL_ALIAS[field]];
  return value === null || value === undefined ? '' : String(value);
}

export function contentHash(node: MerkleNode): string {
  // JSON 数组：分隔/转义无歧义，字段顺序固定。
  return sha256_128(JSON.stringify(CONTENT_FIELDS.map((field) => contentField(node, field))));
}

export function subtreeHashFrom(ownContentHash: string, childSubtreeHashes: string[] = []): string {
  return sha256_128(JSON.stringify([ownContentHash, ...childSubtreeHashes]));
}

function parentKey(node: MerkleNode): string {
  const value = node.parent_id ?? node.parentId;
  return value === null || value === undefined ? '__root__' : String(value);
}

function sortKey(node: MerkleNode): number {
  return Number(node.sort_order ?? node.sortOrder) || 0;
}

export interface IncrementalHashRow extends MerkleNode {
  content_hash?: string | null;
  subtree_hash?: string | null;
}

export interface IncrementalHashResult {
  recomputed: Map<string, SubtreeHashEntry>;
  fullRecomputeNeeded: boolean;
}

// 增量重算：只重算「hash 缺失的脏行 ∪ 其祖先链」，其余子树直接用存量。
// 正确性依据一句话：脏节点的祖先全在重算集 ⇒ 凡不在重算集的节点，其整棵子树内无脏 ⇒
// 它的存量 subtree_hash 仍有效、无需下钻。
// 入参：rows = 全表结构行（id/parent_id/sort_order + 存量两 hash，不必带正文）；
//       contentById = 脏行的 5 个内容字段（只有这部分需要拉正文）。
// 出参 fullRecomputeNeeded=true 表示存量不完整（需要的存量 hash 缺失 / 出现游离行），
// 增量前提破损，调用方应退回全量重算——宁可慢不可错。
export function computeSubtreeHashesIncremental(
  rows: IncrementalHashRow[] = [],
  contentById: Map<string, MerkleNode> = new Map()
): IncrementalHashResult {
  const byId = new Map<string, IncrementalHashRow>();
  const childrenByParent = new Map<string, IncrementalHashRow[]>();
  for (const row of rows) {
    byId.set(String(row.id), row);
    const key = parentKey(row);
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key)!.push(row);
  }
  for (const list of childrenByParent.values()) list.sort((a, b) => sortKey(a) - sortKey(b));

  const recomputeSet = new Set<string>();
  const dirtyIds: string[] = [];
  for (const row of rows) {
    if (row.content_hash && row.subtree_hash) continue;
    dirtyIds.push(String(row.id));
    let cursor: IncrementalHashRow | undefined = row;
    while (cursor) {
      const key = String(cursor.id);
      if (recomputeSet.has(key)) break; // 祖先链上段已并入
      recomputeSet.add(key);
      const parentId: number | string | null | undefined = cursor.parent_id ?? cursor.parentId;
      cursor = parentId === null || parentId === undefined ? undefined : byId.get(String(parentId));
    }
  }

  const recomputed = new Map<string, SubtreeHashEntry>();
  let fullRecomputeNeeded = false;
  if (recomputeSet.size === 0) return { recomputed, fullRecomputeNeeded };

  const ownHashOf = (row: IncrementalHashRow): string => {
    if (row.content_hash) return row.content_hash; // 纯祖先（内容没变、只是子树变了）用存量
    const content = contentById.get(String(row.id));
    if (!content) {
      fullRecomputeNeeded = true;
      return '';
    }
    return contentHash(content);
  };

  // 显式栈后序（不递归，深链不爆栈）：只展开重算集内的节点，集外子直接取存量 subtree_hash。
  interface Frame { row: IncrementalHashRow; index: number; childHashes: string[] }
  for (const root of childrenByParent.get('__root__') || []) {
    if (!recomputeSet.has(String(root.id))) continue;
    const stack: Frame[] = [{ row: root, index: 0, childHashes: [] }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const children = childrenByParent.get(String(frame.row.id)) || [];
      if (frame.index < children.length) {
        const child = children[frame.index]!;
        frame.index += 1;
        if (recomputeSet.has(String(child.id))) {
          stack.push({ row: child, index: 0, childHashes: [] });
        } else if (child.subtree_hash) {
          frame.childHashes.push(child.subtree_hash);
        } else {
          fullRecomputeNeeded = true;
          frame.childHashes.push('');
        }
        continue;
      }
      const own = ownHashOf(frame.row);
      const entry: SubtreeHashEntry = { contentHash: own, subtreeHash: subtreeHashFrom(own, frame.childHashes) };
      recomputed.set(String(frame.row.id), entry);
      stack.pop();
      const parent = stack[stack.length - 1];
      if (parent) parent.childHashes.push(entry.subtreeHash);
    }
  }

  // 覆盖性自检：脏行未被遍历到（游离行 / parent 悬挂）意味着增量结果不完整——交回全量兜底，
  // 免得回写后该行 hash 仍空、每次 ensure 重复走增量却永不收敛。
  if (!fullRecomputeNeeded) {
    for (const id of dirtyIds) {
      if (!recomputed.has(id)) {
        fullRecomputeNeeded = true;
        break;
      }
    }
  }
  return { recomputed, fullRecomputeNeeded };
}

// 对一棵（或一组根的）节点数组做后序遍历，返回 Map<id, {contentHash, subtreeHash}>。
// 输入接受 base 行（snake_case）与投影行；只依赖 id / parent_id / sort_order + 5 个内容字段。
export function computeSubtreeHashes(nodes: MerkleNode[] = []): Map<string, SubtreeHashEntry> {
  const childrenByParent = new Map<string, MerkleNode[]>();
  for (const node of nodes) {
    const key = parentKey(node);
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key)!.push(node);
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => sortKey(a) - sortKey(b));
  }

  const result = new Map<string, SubtreeHashEntry>();
  const visit = (node: MerkleNode): SubtreeHashEntry => {
    const own = contentHash(node);
    const children = childrenByParent.get(node.id === null || node.id === undefined ? '__root__' : String(node.id)) || [];
    const childHashes = children.map((child) => visit(child).subtreeHash);
    const entry: SubtreeHashEntry = { contentHash: own, subtreeHash: subtreeHashFrom(own, childHashes) };
    result.set(String(node.id), entry);
    return entry;
  };
  for (const root of childrenByParent.get('__root__') || []) visit(root);
  return result;
}
