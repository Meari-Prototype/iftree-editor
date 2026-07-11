// 导入产物落库编排（L3）：解释 sentence/structured records，并调用 L2 通用事务与 CRUD 原语。

import { normalizeNodeType } from '../../core/node-model.js';
import { compareNodeAddress } from '../shared.js';
import { newStableId } from '../db/ids.js';
import {
  areRecordsAddressSorted,
  normalizeSourcePosition,
  recordSentenceIndexes
} from '../db/normalizers.js';
import type { NodeRow } from '../db/schema.js';
import type { CommitPayload, SnapshotPayload } from '../store/history.js';

export interface ImportRecord {
  text?: unknown;
  address?: unknown;
  index?: unknown;
  indexes?: unknown[];
  nodeType?: unknown;
  node_type?: unknown;
  sourcePosition?: unknown;
  source_position?: unknown;
  trustLevel?: unknown;
}

export interface ImportedDocInput {
  title: string;
  sourcePath?: unknown;
  records: ImportRecord[];
  skipInitialCommit?: boolean;
}

export interface ImportWriteStore {
  db: {
    prepare(sql: string): {
      run(...params: unknown[]): unknown;
    };
  } | null;
  withTransaction<T>(fn: () => T): T;
  createDoc(payload: {
    title: string;
    rootText?: unknown;
    meta?: unknown;
    skipInitialCommit?: boolean;
  }): { id: string; title: string; rootNodeId: string };
  insertNode(payload: {
    docId: unknown;
    parentId: unknown;
    text?: unknown;
    nodeType?: unknown;
  }): NodeRow;
  refreshAddressScopes(docId: unknown, parentIds: unknown[]): unknown;
  refreshDocAddresses(docId: unknown): unknown;
  createCommit(payload: CommitPayload): unknown;
  createSnapshot(docId: unknown): SnapshotPayload;
}

function requireDb(store: ImportWriteStore): NonNullable<ImportWriteStore['db']> {
  if (!store.db) throw new Error('Import store is not initialized');
  return store.db;
}

export function createDocFromSentences(
  store: ImportWriteStore,
  { title, sourcePath, sentences }: { title: string; sourcePath?: unknown; sentences: string[] }
) {
  return createDocFromSentenceRecords(store, {
    title,
    sourcePath,
    records: sentences.map((text) => ({ text, vector: null }))
  });
}

export function createDocFromSentenceRecords(store: ImportWriteStore, {
  title, sourcePath, records, skipInitialCommit = false
}: ImportedDocInput) {
  return store.withTransaction(() => {
    const doc = store.createDoc({
      title,
      rootText: title,
      meta: JSON.stringify({ sourcePath, importedAt: new Date().toISOString() }),
      skipInitialCommit: true
    });
    const chapter = store.insertNode({
      docId: doc.id,
      parentId: doc.rootNodeId,
      text: '原始文本导入',
      nodeType: 'TEXT'
    });
    const importedNodeIds: string[] = [];
    const importedNodeIdsByRecordIndex: Record<number, string> = {};
    const insertNode = requireDb(store).prepare(`
      INSERT INTO nodes (id, doc_id, parent_id, sort_order, node_type, text)
      VALUES (?, ?, ?, ?, 'TEXT', ?)
    `);

    for (const [index, record] of records.entries()) {
      const nodeId = newStableId();
      insertNode.run(nodeId, doc.id, chapter.id, index + 1, record.text);
      importedNodeIds.push(nodeId);
      for (const recordIndex of recordSentenceIndexes(record, index + 1)) {
        importedNodeIdsByRecordIndex[recordIndex] = nodeId;
      }
    }
    store.refreshAddressScopes(doc.id, [chapter.id]);
    if (!skipInitialCommit) createImportInitialCommit(store, doc.id);

    return { ...doc, importedNodeIds, importedNodeIdsByRecordIndex };
  });
}

export function createDocFromStructuredRecords(store: ImportWriteStore, {
  title, sourcePath, records, skipInitialCommit = false
}: ImportedDocInput) {
  return store.withTransaction(() => {
    const doc = store.createDoc({
      title,
      rootText: title,
      meta: JSON.stringify({ sourcePath, importedAt: new Date().toISOString(), structured: true }),
      skipInitialCommit: true
    });
    const addressToId = new Map<string, string>();
    const importedNodeIds: string[] = [];
    const importedNodeIdsByRecordIndex: Record<number, string> = {};
    const sorted = areRecordsAddressSorted(records) ? records : [...records].sort(compareNodeAddress);
    const insertNode = requireDb(store).prepare(`
      INSERT INTO nodes (
        id, doc_id, parent_id, sort_order, node_type, text, node_title, node_note, source_position, trust_level
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const record of sorted) {
      const address = String(record.address || '').trim();
      const parts = address.split('-').map(Number);
      const parentId = parts.length === 1
        ? doc.rootNodeId
        : addressToId.get(parts.slice(0, -1).join('-')) || doc.rootNodeId;
      const sortOrder = parts[parts.length - 1] || 1;
      const nodeType = normalizeNodeType(record.nodeType ?? record.node_type ?? 'TEXT');
      const nodeId = newStableId();
      insertNode.run(
        nodeId,
        doc.id,
        parentId,
        sortOrder,
        nodeType,
        record.text || '',
        '',
        '',
        normalizeSourcePosition(record.sourcePosition ?? record.source_position),
        record.trustLevel || null
      );
      addressToId.set(address, nodeId);
      importedNodeIds.push(nodeId);
      for (const recordIndex of recordSentenceIndexes(record)) {
        importedNodeIdsByRecordIndex[recordIndex] = nodeId;
      }
    }
    store.refreshDocAddresses(doc.id);
    if (!skipInitialCommit) createImportInitialCommit(store, doc.id);

    return { ...doc, importedNodeIds, importedNodeIdsByRecordIndex };
  });
}

export function createImportInitialCommit(store: ImportWriteStore, docId: unknown) {
  return store.createCommit({
    docId,
    summary: '导入',
    snapshot: store.createSnapshot(docId),
    author: 'import'
  });
}
