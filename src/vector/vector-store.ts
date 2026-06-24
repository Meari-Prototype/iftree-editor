// @ts-nocheck
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import * as lancedb from '@lancedb/lancedb';

import { MIN_VECTOR_DIMENSIONS, normalizeVector } from './embeddings.js';

const TABLE_NAME = 'nodes_vec';
const DELETE_PREDICATE_CHUNK_SIZE = 512;

function quoteValue(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function stringPredicate(column, value) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`Invalid predicate value for ${column}: ${value}`);
  return `${column} = ${quoteValue(text)}`;
}

function fieldTypeText(field) {
  const text = field?.type && typeof field.type.toString === 'function'
    ? field.type.toString()
    : String(field?.type || '');
  return text.toLowerCase();
}

function isTextField(schema, name) {
  const field = schema?.fields?.find((item) => item.name === name);
  const text = fieldTypeText(field);
  if (!text || text === '[object object]') return true;
  return text.includes('utf8') || text.includes('string');
}

function toVector(value, dimensions) {
  const expectedDimensions = Math.max(Number(dimensions) || MIN_VECTOR_DIMENSIONS, MIN_VECTOR_DIMENSIONS);
  const vector = normalizeVector(Array.from(value ?? [], Number), expectedDimensions);
  if (vector.length !== expectedDimensions) {
    throw new Error(`Vector must have exactly ${expectedDimensions} dimensions; got ${vector.length}`);
  }
  return vector;
}

function toRow({ nodeId, docId, text, contentHash, subtreeHash, vector }, dimensions) {
  const id = String(nodeId ?? '').trim();
  const doc_id = String(docId ?? '').trim();
  if (!id) throw new Error(`Invalid vector node id: ${nodeId}`);
  if (!doc_id) throw new Error(`Invalid vector doc id: ${docId}`);
  return {
    id,
    doc_id,
    // Merkle 哈希随行落库：content_hash 判自身要不要重嵌，subtree_hash 供 reconcile top-down 剪枝。
    content_hash: String(contentHash ?? ''),
    subtree_hash: String(subtreeHash ?? ''),
    text: text || '',
    vector: toVector(vector, dimensions)
  };
}

function vectorDimensionsFromSchema(schema) {
  const vectorField = schema?.fields?.find((field) => field.name === 'vector');
  return Number(vectorField?.type?.listSize) || 0;
}

function distanceToScore(distance) {
  if (typeof distance !== 'number' || !Number.isFinite(distance)) return 0;
  return 1 / (1 + Math.max(0, distance));
}

export class VectorStore {
  constructor(dbPath, options = {}) {
    this.dbPath = dbPath;
    this.dimensions = Math.max(Number(options.dimensions) || MIN_VECTOR_DIMENSIONS, MIN_VECTOR_DIMENSIONS);
    this.reset = Boolean(options.reset);
    this.connection = null;
    this.table = null;
  }

  async init() {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.connection = await lancedb.connect(this.dbPath);
    this.table = await this.openExistingTable();
  }

  close() {
    if (this.connection?.close) this.connection.close();
    this.connection = null;
    this.table = null;
  }

  async openExistingTable() {
    const names = await this.connection.tableNames();
    if (!names.includes(TABLE_NAME)) return null;
    if (this.reset) {
      await this.connection.dropTable(TABLE_NAME);
      return null;
    }
    const table = await this.connection.openTable(TABLE_NAME);
    const schema = await table.schema();
    const fieldNames = schema.fields.map((f) => f.name);
    if (
      !fieldNames.includes('id')
      || !fieldNames.includes('doc_id')
      || !isTextField(schema, 'id')
      || !isTextField(schema, 'doc_id')
      || vectorDimensionsFromSchema(schema) !== this.dimensions
    ) {
      await this.connection.dropTable(TABLE_NAME);
      return null;
    }
    // 渐进迁移：旧表缺 Merkle 哈希列就原地补（addColumns，旧行留空、靠 reconcile 回填），
    // 不重建、不丢向量。
    const newColumns = [];
    if (!fieldNames.includes('content_hash')) newColumns.push({ name: 'content_hash', valueSql: "''" });
    if (!fieldNames.includes('subtree_hash')) newColumns.push({ name: 'subtree_hash', valueSql: "''" });
    if (newColumns.length) await table.addColumns(newColumns);
    return table;
  }

  async upsertNodeVector(payload) {
    await this.upsertNodeVectors([payload]);
  }

  // 写入恒按 node_id 原子 upsert：匹配则整行覆盖、不匹配则插入。物理恒「一 id 一行」，
  // 同 id 重复写入幂等不堆行——从源头消除裸 add 的重复，连带消解计数虚高 /
  // 陈旧误判 / 补建死循环（不必再靠 deleteExisting 逐行删，也不会产生重复存量）。
  async upsertNodeVectors(payloads) {
    // 同批先按 id 去重（留后者）：mergeInsert 的 source 不能自带重复 id（多匹配行为未定义）。
    const byId = new Map();
    for (const payload of payloads || []) {
      const row = toRow(payload, this.dimensions);
      byId.set(row.id, row);
    }
    if (byId.size === 0) return;
    const rows = [...byId.values()];
    if (!this.table) {
      this.table = await this.connection.createTable(TABLE_NAME, rows);
      return;
    }
    // 幂等过滤交给 reconcile 外层（按 content_hash diff 只传变化节点）；这里恒覆盖匹配行。
    await this.table.mergeInsert('id')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(rows);
  }

  async deleteNodeVectors(nodeIds = []) {
    if (!this.table) return 0;
    const ids = [...new Set((nodeIds || [])
      .map((id) => String(id ?? '').trim())
      .filter(Boolean))];
    for (let offset = 0; offset < ids.length; offset += DELETE_PREDICATE_CHUNK_SIZE) {
      const chunk = ids.slice(offset, offset + DELETE_PREDICATE_CHUNK_SIZE);
      try {
        await this.table.delete(`id IN (${chunk.map(quoteValue).join(',')})`);
      } catch (error) {
        if (chunk.length === 1) throw error;
        for (const id of chunk) await this.table.delete(stringPredicate('id', id));
      }
    }
    return ids.length;
  }

  // 批量查这批 id 里哪些已有向量（供增量补建找缺失，避免全量拉行 OOM）。
  async existingIds(nodeIds = []) {
    if (!this.table) return new Set();
    const ids = [...new Set((nodeIds || [])
      .map((id) => String(id ?? '').trim())
      .filter(Boolean))];
    const found = new Set();
    for (let offset = 0; offset < ids.length; offset += DELETE_PREDICATE_CHUNK_SIZE) {
      const chunk = ids.slice(offset, offset + DELETE_PREDICATE_CHUNK_SIZE);
      const rows = await this.table.query()
        .where(`id IN (${chunk.map(quoteValue).join(',')})`)
        .select(['id'])
        .limit(chunk.length)
        .toArray();
      for (const row of rows) found.add(String(row.id));
    }
    return found;
  }

  // 批量取这批 id 的 (id → text)：完整性比对用（正文一致性），按 id 分块查询，
  // 不按 doc 全量拉行进内存。
  async textByNodeIds(nodeIds = []) {
    if (!this.table) return new Map();
    const ids = [...new Set((nodeIds || [])
      .map((id) => String(id ?? '').trim())
      .filter(Boolean))];
    const found = new Map();
    for (let offset = 0; offset < ids.length; offset += DELETE_PREDICATE_CHUNK_SIZE) {
      const chunk = ids.slice(offset, offset + DELETE_PREDICATE_CHUNK_SIZE);
      const rows = await this.table.query()
        .where(`id IN (${chunk.map(quoteValue).join(',')})`)
        .select(['id', 'text'])
        .limit(chunk.length)
        .toArray();
      for (const row of rows) found.set(String(row.id), String(row.text || ''));
    }
    return found;
  }

  // 批量取这批 id 的 Merkle 哈希 (id → {contentHash, subtreeHash})：reconcile 逐层剪枝对账用，
  // 只拉哈希、不拉正文/向量。按 id 分块查询，不按 doc 全量拉行。
  async hashesByNodeIds(nodeIds = []) {
    if (!this.table) return new Map();
    const ids = [...new Set((nodeIds || [])
      .map((id) => String(id ?? '').trim())
      .filter(Boolean))];
    const found = new Map();
    for (let offset = 0; offset < ids.length; offset += DELETE_PREDICATE_CHUNK_SIZE) {
      const chunk = ids.slice(offset, offset + DELETE_PREDICATE_CHUNK_SIZE);
      const rows = await this.table.query()
        .where(`id IN (${chunk.map(quoteValue).join(',')})`)
        .select(['id', 'content_hash', 'subtree_hash'])
        .limit(chunk.length)
        .toArray();
      for (const row of rows) {
        found.set(String(row.id), {
          contentHash: String(row.content_hash ?? ''),
          subtreeHash: String(row.subtree_hash ?? '')
        });
      }
    }
    return found;
  }

  async hasNodeVector(nodeId) {
    if (!this.table) return false;
    const count = await this.table.countRows(stringPredicate('id', nodeId));
    return count > 0;
  }

  async countDocVectors(docId) {
    if (!this.table) return 0;
    return await this.table.countRows(stringPredicate('doc_id', docId));
  }

  async listDocVectorIds(docId, options = {}) {
    if (!this.table) return [];
    const explicitLimit = Math.floor(Number(options.limit));
    const limit = explicitLimit > 0
      ? explicitLimit
      : Math.max(1, await this.countDocVectors(docId));
    const rows = await this.table.query()
      .where(stringPredicate('doc_id', docId))
      .select(['id'])
      .limit(limit)
      .toArray();
    return rows.map((row) => String(row.id)).filter(Boolean);
  }

  async listDocVectorRows(docId, options = {}) {
    if (!this.table) return [];
    const explicitLimit = Math.floor(Number(options.limit));
    const limit = explicitLimit > 0
      ? explicitLimit
      : Math.max(1, await this.countDocVectors(docId));
    const rows = await this.table.query()
      .where(stringPredicate('doc_id', docId))
      .select(['id', 'text'])
      .limit(limit)
      .toArray();
    return rows
      .map((row) => ({ id: String(row.id), text: String(row.text || '') }))
      .filter((row) => row.id);
  }

  async deleteDoc(docId) {
    if (!this.table) return;
    await this.table.delete(stringPredicate('doc_id', docId));
  }

  async search({ docId = null, vector, limit = 20 }) {
    if (!this.table) return [];
    const queryVector = toVector(vector, this.dimensions);
    let query = this.table.vectorSearch(queryVector);
    if (docId !== null && docId !== undefined) {
      query = query.where(stringPredicate('doc_id', docId));
    }
    const rows = await query.limit(Number(limit) || 20).toArray();
    return rows.map((row) => ({
      node_id: String(row.id),
      doc_id: String(row.doc_id),
      text: row.text || '',
      score: distanceToScore(row._distance)
    }));
  }
}
