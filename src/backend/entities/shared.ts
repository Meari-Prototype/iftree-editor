import type Database from 'better-sqlite3';
import {
  compareStableIds,
  normalizeStableId,
  sameStableId
} from '../db/ids.js';
import type {
  EntityBindingStatus,
  EntityLinkKind,
  EntityLinkRow,
  EntityNodeBindingRow,
  EntityRow,
  NodeRow
} from '../db/rows.js';
import type { EditBranchRow } from '../db/rows.js';
import type { EditBranchEntry } from '../edit-branch-projection.js';
import { buildAhoCorasickMatcher } from '../../core/aho-corasick.js';

// IftreeStore 的 edit-branch 转调壳现已经从 (...args: unknown[]) 收紧到真签名（store/index.ts:1053-）。
// EntityStore 这里也跟上，否则 IftreeStore 传进来的方法类型比 EntityStore 声明的窄、TS 拒绝赋值。
// 不导入 IftreeStore 避免循环依赖，仍用方法形状描述子集。
export interface EntityStore {
  // 与 IftreeStore.db 对齐（构造前/close 后为 null）；访问点都已 `store.db!` 走断言。
  db: Database | null;
  activeEditBranchForDoc?: (docId: unknown, owner?: unknown) => EditBranchRow | null;
  _appendEditBranchEntry?: (branch: EditBranchRow, entry: EditBranchEntry) => EditBranchRow;
}

// 派生：entities JOIN docs 后的常用形状，外加投影层会带的 pending/命中计数。
export type EntityWithDocTitle = EntityRow & {
  doc_title: string;
};

export type ProjectedEntity = EntityWithDocTitle & {
  pending_insert?: boolean;
  hit_count?: number;
};

// entity_links / entity_node_bindings 的投影变体（编辑分支态可能附 pending_insert，id 也可能是 tmp）。
export type ProjectedEntityLink = Omit<EntityLinkRow, 'id'> & {
  id: EntityLinkRow['id'] | string;
  pending_insert?: boolean;
};

export type ProjectedEntityBinding = Omit<EntityNodeBindingRow, 'id'> & {
  id: EntityNodeBindingRow['id'] | string;
  pending_insert?: boolean;
};

export interface EntityState {
  entities: ProjectedEntity[];
  links: ProjectedEntityLink[];
  bindings: ProjectedEntityBinding[];
}

type Payload = Record<string, unknown>;

export function normalizePositiveInteger(value: unknown, fallback: string | null = null): string | null {
  return normalizeStableId(value, fallback);
}

export function normalizeLimit(value: unknown, fallback = 100, max = 1000): number {
  const number = Math.floor(Number(value));
  if (!Number.isInteger(number) || number <= 0) return fallback;
  return Math.min(max, number);
}

export function normalizeEntityLiteral(value: unknown = ''): string {
  return String(value || '').trim();
}

export function normalizeEntityKey(value: unknown = ''): string {
  return normalizeEntityLiteral(value).toLocaleLowerCase();
}

export function normalizeEntityLinkKind(value: unknown = ''): EntityLinkKind {
  const kind = String(value || '').trim().toLowerCase();
  if (kind === 'synonym' || kind === 'related') return kind;
  throw new Error('entity link kind must be synonym or related');
}

export function orderedEntityPair(leftId: unknown, rightId: unknown): [string, string] {
  const left = normalizePositiveInteger(leftId);
  const right = normalizePositiveInteger(rightId);
  if (!left || !right) throw new Error('entity link requires two entity ids');
  if (sameStableId(left, right)) throw new Error('entity link requires two different entities');
  return compareStableIds(left, right) <= 0 ? [left, right] : [right, left];
}

export function requireEntityId(payload: Payload = {}, key = 'entityId'): string {
  const value = normalizePositiveInteger(payload[key] ?? payload[snakeKey(key)]);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

export function requireDocId(payload: Payload = {}): string {
  const docId = normalizePositiveInteger(payload.docId ?? payload.doc_id);
  if (!docId) throw new Error('entity action requires docId');
  return docId;
}

function snakeKey(value: unknown = ''): string {
  return String(value).replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function entityRow(store: EntityStore, entityId: unknown): EntityWithDocTitle | null {
  const id = normalizePositiveInteger(entityId);
  if (!id) return null;
  return store.db!.prepare(`
    SELECT e.*,
      d.title AS doc_title
    FROM entities e
    JOIN docs d ON d.id = e.doc_id
    WHERE e.id = ?
  `).get<EntityWithDocTitle>(id) || null;
}

export interface FormattedEntity {
  id: EntityRow['id'] | string;
  docId: EntityRow['doc_id'];
  docTitle: string;
  literal: string;
  key: string;
  hitCount: number;
  [extra: string]: unknown;
}

export function formatEntity(
  row: Partial<ProjectedEntity> = {},
  extras: Record<string, unknown> = {}
): FormattedEntity {
  return {
    id: (row.id ?? '') as FormattedEntity['id'],
    docId: (row.doc_id ?? '') as FormattedEntity['docId'],
    docTitle: row.doc_title || '',
    literal: row.literal || '',
    key: row.normalized_literal || normalizeEntityKey(row.literal),
    hitCount: Number(row.hit_count ?? (extras.hitCount as number | undefined)) || 0,
    ...extras
  };
}

// 节点扫描 haystack：标题 + 正文 + 备注 + 地址（地址也参与匹配以容忍引用号字面）。
type NodeScanRow = Pick<NodeRow, 'id' | 'doc_id' | 'address' | 'depth' | 'node_title' | 'text' | 'node_note'>;

export function nodeHaystack(row: Partial<NodeScanRow> = {}): string {
  return [
    row.address,
    row.node_title,
    row.text,
    row.node_note
  ].map((value) => String(value || '').toLocaleLowerCase()).join('\n');
}

export function countLiteralOccurrences(haystack = '', needle = ''): number {
  const target = String(needle || '');
  if (!target) return 0;
  let count = 0;
  let index = 0;
  while (index < haystack.length) {
    const next = haystack.indexOf(target, index);
    if (next === -1) break;
    count += 1;
    index = next + target.length;
  }
  return count;
}

export interface EntityScanResult {
  totals: Map<string, number>;
  byNode: Map<string, Map<string, number>>;
}

export function scanEntityHits(
  rows: NodeScanRow[] = [],
  entities: Array<Pick<EntityRow, 'id' | 'literal'>> = []
): EntityScanResult {
  const totals = new Map<string, number>();
  const byNode = new Map<string, Map<string, number>>();
  const matcher = buildAhoCorasickMatcher(entities.map((entity) => ({
    id: entity.id,
    key: normalizeEntityKey(entity.literal)
  })));

  for (const row of rows) {
    matcher.scan(nodeHaystack(row), (entity: { id: unknown; key: string }) => {
      const entityId = String(entity.id || '');
      if (!entityId) return;
      totals.set(entityId, (totals.get(entityId) || 0) + 1);
      let nodeHits = byNode.get(entityId);
      if (!nodeHits) {
        nodeHits = new Map();
        byNode.set(entityId, nodeHits);
      }
      const nodeKey = String(row.id);
      nodeHits.set(nodeKey, (nodeHits.get(nodeKey) || 0) + 1);
    });
  }

  return { totals, byNode };
}

export function nodeRowsForDoc(store: EntityStore, docId: unknown): NodeScanRow[] {
  const normalizedDocId = normalizePositiveInteger(docId);
  if (!normalizedDocId) return [];
  return store.db!.prepare(`
    SELECT id, doc_id, address, depth, node_title, text, node_note
    FROM nodes
    WHERE doc_id = ?
    ORDER BY depth, address, id
  `).all<NodeScanRow>(normalizedDocId);
}

export function countEntityHitsInDoc(
  store: EntityStore,
  entity: Pick<EntityRow, 'id' | 'literal' | 'doc_id'> | null | undefined,
  docId: unknown = null
): number {
  const targetDocId = normalizePositiveInteger(docId ?? entity?.doc_id);
  if (!entity || !normalizeEntityKey(entity.literal) || !targetDocId) return 0;
  return scanEntityHits(nodeRowsForDoc(store, targetDocId), [entity]).totals.get(String(entity.id)) || 0;
}

export function ensureEntityNodeSameDoc(
  store: EntityStore,
  entityId: unknown,
  nodeId: unknown
): { entity: EntityWithDocTitle; node: Pick<NodeRow, 'id' | 'doc_id'> } {
  const entity = entityRow(store, entityId);
  if (!entity) throw new Error('entity not found');
  const node = store.db!
    .prepare('SELECT id, doc_id FROM nodes WHERE id = ?')
    .get<Pick<NodeRow, 'id' | 'doc_id'>>(nodeId);
  if (!node) throw new Error('node not found');
  if (!sameStableId(node.doc_id, entity.doc_id)) {
    throw new Error('entity node binding requires entity and node from the same doc');
  }
  return { entity, node };
}

// 给外部消费 entity binding 状态常用：
export type { EntityBindingStatus };
