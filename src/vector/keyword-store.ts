import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import * as lancedb from '@lancedb/lancedb';
import type {
  Connection,
  Table,
  IndexConfig,
  OptimizeStats,
  SchemaLike,
  FieldLike
} from '@lancedb/lancedb';

const TABLE_NAME = 'nodes_keyword';
const FTS_INDEX_NAME = 'nodes_keyword_search_text_fts';

// 原始来源行：通常来自 SQL 节点查询，字段名为 snake_case；兼容前端/调用方传的 camelCase。
export interface KeywordSourceRow {
  id?: unknown;
  node_id?: unknown;
  nodeId?: unknown;
  doc_id?: unknown;
  docId?: unknown;
  address?: unknown;
  node_title?: unknown;
  nodeTitle?: unknown;
  text?: unknown;
  node_note?: unknown;
  nodeNote?: unknown;
  updated_at?: unknown;
  updatedAt?: unknown;
  [extra: string]: unknown;
}

// 落 lance 的归一化行（schema 与表对齐）。index signature 让它能向上兼容
// KeywordSourceRow（接受额外字段，如再走一次 toKeywordRow 是 idempotent）与
// lancedb 的 `Data`（Record<string, unknown>[]）。
interface KeywordRow {
  id: string;
  doc_id: string;
  address: string;
  node_title: string;
  text: string;
  node_note: string;
  updated_at: string;
  search_text: string;
  [extra: string]: unknown;
}

interface KeywordIndexedRow {
  id: string;
  updated_at: string;
}

interface KeywordSearchHit {
  node_id: string;
  doc_id: string;
  score: number;
}

interface KeywordRawSearchHit {
  id: unknown;
  doc_id: unknown;
  _score?: unknown;
  [extra: string]: unknown;
}

function quoteValue(value: unknown): string {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function stringPredicate(column: string, value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`Invalid predicate value for ${column}: ${value}`);
  return `${column} = ${quoteValue(text)}`;
}

function stringInPredicate(column: string, values: ReadonlyArray<unknown> = []): string {
  const ids = [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))];
  if (ids.length === 0) return 'false';
  return `${column} IN (${ids.map(quoteValue).join(',')})`;
}

function fieldTypeText(field: FieldLike | undefined): string {
  const fieldType = field?.type as { toString?: () => string } | undefined;
  const text = fieldType && typeof fieldType.toString === 'function'
    ? fieldType.toString()
    : String(fieldType || '');
  return text.toLowerCase();
}

function isTextField(schema: SchemaLike | undefined, name: string): boolean {
  const field = schema?.fields?.find((item: FieldLike) => item.name === name);
  const text = fieldTypeText(field);
  if (!text || text === '[object object]') return true;
  return text.includes('utf8') || text.includes('string');
}

function cleanText(value: unknown = ''): string {
  return String(value || '');
}

function toKeywordRow(row: KeywordSourceRow = {}): KeywordRow {
  const id = String(row.id ?? row.node_id ?? row.nodeId ?? '').trim();
  const docId = String(row.doc_id ?? row.docId ?? '').trim();
  if (!id) throw new Error(`Invalid keyword node id: ${row.id}`);
  if (!docId) throw new Error(`Invalid keyword doc id: ${row.doc_id}`);
  const address = cleanText(row.address);
  const nodeTitle = cleanText(row.node_title ?? row.nodeTitle);
  const text = cleanText(row.text);
  const nodeNote = cleanText(row.node_note ?? row.nodeNote);
  return {
    id,
    doc_id: docId,
    address,
    node_title: nodeTitle,
    text,
    node_note: nodeNote,
    updated_at: cleanText(row.updated_at ?? row.updatedAt),
    search_text: [address, nodeTitle, text, nodeNote].filter(Boolean).join('\n')
  };
}

function expectedMap(rows: KeywordRow[] = []): Map<string, string> {
  return new Map(rows.map((row) => [String(row.id), cleanText(row.updated_at)]));
}

export interface KeywordStoreOptions {
  reset?: boolean;
}

export interface KeywordSearchInput {
  terms?: ReadonlyArray<unknown> | string;
  docId?: unknown;
  limit?: number;
}

export interface KeywordOptimizeOptions {
  cleanupOlderThan?: Date | null;
}

export class KeywordStore {
  dbPath: string;
  reset: boolean;
  connection: Connection | null;
  table: Table | null;

  constructor(dbPath: string, options: KeywordStoreOptions = {}) {
    this.dbPath = dbPath;
    this.reset = Boolean(options.reset);
    this.connection = null;
    this.table = null;
  }

  async init(): Promise<void> {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.connection = await lancedb.connect(this.dbPath);
    this.table = await this.openExistingTable();
  }

  close(): void {
    if (this.connection?.close) this.connection.close();
    this.connection = null;
    this.table = null;
  }

  async openExistingTable(): Promise<Table | null> {
    if (!this.connection) return null;
    const names = await this.connection.tableNames();
    if (!names.includes(TABLE_NAME)) return null;
    if (this.reset) {
      await this.connection.dropTable(TABLE_NAME);
      return null;
    }
    const table = await this.connection.openTable(TABLE_NAME);
    const schema = await table.schema();
    const fieldNames = schema.fields.map((field: FieldLike) => field.name);
    if (
      !fieldNames.includes('id')
      || !fieldNames.includes('doc_id')
      || !fieldNames.includes('search_text')
      || !isTextField(schema, 'id')
      || !isTextField(schema, 'doc_id')
    ) {
      await this.connection.dropTable(TABLE_NAME);
      return null;
    }
    return table;
  }

  async ensureTable(rows: KeywordSourceRow[] = []): Promise<Table | null> {
    if (this.table) return this.table;
    if (!this.connection) return null;
    const keywordRows = rows.map(toKeywordRow);
    if (keywordRows.length === 0) return null;
    this.table = await this.connection.createTable(TABLE_NAME, keywordRows);
    await this.ensureFtsIndex();
    return this.table;
  }

  async ensureFtsIndex(options: { replace?: boolean } = {}): Promise<void> {
    if (!this.table) return;
    if (options.replace === true) {
      await this.table.createIndex('search_text', {
        config: lancedb.Index.fts({ baseTokenizer: 'ngram', ngramMinLength: 1 }),
        name: FTS_INDEX_NAME,
        replace: true
      });
      return;
    }
    const indices: IndexConfig[] = typeof this.table.listIndices === 'function'
      ? await this.table.listIndices()
      : [];
    if (indices.some((index) => index.name === FTS_INDEX_NAME)) return;
    await this.table.createIndex('search_text', {
      config: lancedb.Index.fts({ baseTokenizer: 'ngram', ngramMinLength: 1 }),
      name: FTS_INDEX_NAME
    });
  }

  async indexedRowsForDoc(docId: unknown, limit: number): Promise<KeywordIndexedRow[]> {
    if (!this.table) return [];
    const rows = await this.table.query()
      .where(stringPredicate('doc_id', docId))
      .select(['id', 'updated_at'])
      .limit(limit)
      .toArray();
    return rows as KeywordIndexedRow[];
  }

  async isCurrent(rows: KeywordSourceRow[] = []): Promise<boolean> {
    const keywordRows = rows.map(toKeywordRow);
    if (keywordRows.length === 0) return true;
    if (!this.table) return false;
    const byDoc = new Map<string, KeywordRow[]>();
    for (const row of keywordRows) {
      const list = byDoc.get(row.doc_id);
      if (list) list.push(row);
      else byDoc.set(row.doc_id, [row]);
    }
    for (const [docId, docRows] of byDoc.entries()) {
      const indexed = await this.indexedRowsForDoc(docId, docRows.length + 1);
      if (indexed.length !== docRows.length) return false;
      const expected = expectedMap(docRows);
      for (const row of indexed) {
        if (!expected.has(String(row.id))) return false;
        if (cleanText(row.updated_at) !== expected.get(String(row.id))) return false;
      }
    }
    return true;
  }

  async replaceRows(rows: KeywordSourceRow[] = []): Promise<void> {
    const keywordRows = rows.map(toKeywordRow);
    if (keywordRows.length === 0) return;
    const table = await this.ensureTable(keywordRows);
    if (!table) return;
    const docIds = [...new Set(keywordRows.map((row) => row.doc_id))];
    for (const docId of docIds) {
      await table.delete(stringPredicate('doc_id', docId));
    }
    await table.add(keywordRows);
    if (this.connection) this.table = await this.connection.openTable(TABLE_NAME);
    await this.ensureFtsIndex({ replace: true });
  }

  async ensureRows(rows: KeywordSourceRow[] = []): Promise<void> {
    if (await this.isCurrent(rows)) return;
    await this.replaceRows(rows);
  }

  async upsertNode(row: KeywordSourceRow = {}): Promise<void> {
    const keywordRow = toKeywordRow(row);
    const table = await this.ensureTable([keywordRow]);
    if (!table) return;
    await table.delete(stringPredicate('id', keywordRow.id));
    await table.add([keywordRow]);
    await this.ensureFtsIndex();
  }

  async deleteNodes(nodeIds: ReadonlyArray<unknown> = []): Promise<void> {
    if (!this.table) return;
    await this.table.delete(stringInPredicate('id', nodeIds));
  }

  async deleteDoc(docId: unknown): Promise<void> {
    if (!this.table) return;
    await this.table.delete(stringPredicate('doc_id', docId));
  }

  // 增量入库（projectneed 4-16）：批量 add 一批行，分批写入；LanceDB FTS 对 add 的行即时可搜，
  // 不 delete 整 doc、不全量重建索引。来源保证不重复 id（SQL 地址校验先拦重复推送）。
  async addRows(rows: KeywordSourceRow[] = []): Promise<void> {
    const keywordRows = rows.map(toKeywordRow);
    if (keywordRows.length === 0) return;
    const BATCH = 2000;
    const hadTable = Boolean(this.table);
    const table = await this.ensureTable(keywordRows.slice(0, BATCH));
    if (!table) return;
    const start = hadTable ? 0 : Math.min(BATCH, keywordRows.length);
    for (let i = start; i < keywordRows.length; i += BATCH) {
      await table.add(keywordRows.slice(i, i + BATCH));
    }
    await this.ensureFtsIndex();
  }

  // 碎片/旧版本回收（维护层调用，不在读写热路径）：LanceDB append-only MVCC 下 add/delete 持续累积
  // data fragment 与历史版本、从不自动回收，会把 deleteDoc/add 拖慢近一个数量级。compaction 合并碎片；
  // 给定 cleanupOlderThan 连带 prune 早于该时刻的旧版本。optimize 后重开句柄，后续操作走合并后的版本。
  async optimize({ cleanupOlderThan = null }: KeywordOptimizeOptions = {}): Promise<OptimizeStats | null> {
    if (!this.table || !this.connection) return null;
    const stats = await this.table.optimize(cleanupOlderThan ? { cleanupOlderThan } : {});
    this.table = await this.connection.openTable(TABLE_NAME);
    return stats;
  }

  // 轻量计数（查询时判断该 doc 是否已建索引，避免全量拉行比对）。
  async countDocRows(docId: unknown): Promise<number> {
    if (!this.table) return 0;
    const normalized = String(docId ?? '').trim();
    if (!normalized) return 0;
    return this.table.countRows(stringPredicate('doc_id', normalized));
  }

  async search({ terms = [], docId = null, limit = 200 }: KeywordSearchInput = {}): Promise<KeywordSearchHit[]> {
    if (!this.table) return [];
    const termSource: ReadonlyArray<unknown> = Array.isArray(terms) ? terms : [terms];
    const query = termSource
      .map((term) => String(term || '').trim())
      .filter(Boolean)
      .join(' ');
    if (!query) return [];
    let request = this.table.search(query, 'fts', 'search_text');
    const normalizedDocId = String(docId ?? '').trim();
    if (normalizedDocId) {
      request = request.where(stringPredicate('doc_id', normalizedDocId));
    }
    // 不显式给 limit 时 LanceDB FTS 默认只返回 top 10，会把召回静默截断；放大上限。
    request = request.limit(Math.max(1, Number(limit) || 200));
    const rows = await request.toArray() as KeywordRawSearchHit[];
    // 透出 BM25 相关性分（LanceDB FTS `_score`）：keyword 召回由 Aho-Corasick 负责，
    // 这里只把分数交给上层给召回结果排序用。
    return rows.map((row) => ({
      node_id: String(row.id),
      doc_id: String(row.doc_id),
      score: Number(row._score) || 0
    })).filter((row) => row.node_id && row.doc_id);
  }
}
