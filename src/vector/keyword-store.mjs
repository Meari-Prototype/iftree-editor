import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import * as lancedb from '@lancedb/lancedb';

const TABLE_NAME = 'nodes_keyword';
const FTS_INDEX_NAME = 'nodes_keyword_search_text_fts';

function quoteValue(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function stringPredicate(column, value) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`Invalid predicate value for ${column}: ${value}`);
  return `${column} = ${quoteValue(text)}`;
}

function stringInPredicate(column, values = []) {
  const ids = [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))];
  if (ids.length === 0) return 'false';
  return `${column} IN (${ids.map(quoteValue).join(',')})`;
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

function cleanText(value = '') {
  return String(value || '');
}

function toKeywordRow(row = {}) {
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

function expectedMap(rows = []) {
  return new Map(rows.map((row) => [String(row.id), cleanText(row.updated_at)]));
}

export class KeywordStore {
  constructor(dbPath, options = {}) {
    this.dbPath = dbPath;
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
    const fieldNames = schema.fields.map((field) => field.name);
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

  async ensureTable(rows = []) {
    if (this.table) return this.table;
    const keywordRows = rows.map(toKeywordRow);
    if (keywordRows.length === 0) return null;
    this.table = await this.connection.createTable(TABLE_NAME, keywordRows);
    await this.ensureFtsIndex();
    return this.table;
  }

  async ensureFtsIndex(options = {}) {
    if (!this.table) return;
    if (options.replace === true) {
      await this.table.createIndex('search_text', {
        config: lancedb.Index.fts({ baseTokenizer: 'ngram', ngramMinLength: 1 }),
        name: FTS_INDEX_NAME,
        replace: true
      });
      return;
    }
    const indices = typeof this.table.listIndices === 'function' ? await this.table.listIndices() : [];
    if (indices.some((index) => index.name === FTS_INDEX_NAME)) return;
    await this.table.createIndex('search_text', {
      config: lancedb.Index.fts({ baseTokenizer: 'ngram', ngramMinLength: 1 }),
      name: FTS_INDEX_NAME
    });
  }

  async indexedRowsForDoc(docId, limit) {
    if (!this.table) return [];
    return this.table.query()
      .where(stringPredicate('doc_id', docId))
      .select(['id', 'updated_at'])
      .limit(limit)
      .toArray();
  }

  async isCurrent(rows = []) {
    const keywordRows = rows.map(toKeywordRow);
    if (keywordRows.length === 0) return true;
    if (!this.table) return false;
    const byDoc = new Map();
    for (const row of keywordRows) {
      if (!byDoc.has(row.doc_id)) byDoc.set(row.doc_id, []);
      byDoc.get(row.doc_id).push(row);
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

  async replaceRows(rows = []) {
    const keywordRows = rows.map(toKeywordRow);
    if (keywordRows.length === 0) return;
    const table = await this.ensureTable(keywordRows);
    if (!table) return;
    const docIds = [...new Set(keywordRows.map((row) => row.doc_id))];
    for (const docId of docIds) {
      await table.delete(stringPredicate('doc_id', docId));
    }
    await table.add(keywordRows);
    this.table = await this.connection.openTable(TABLE_NAME);
    await this.ensureFtsIndex({ replace: true });
  }

  async ensureRows(rows = []) {
    if (await this.isCurrent(rows)) return;
    await this.replaceRows(rows);
  }

  async upsertNode(row = {}) {
    const keywordRow = toKeywordRow(row);
    const table = await this.ensureTable([keywordRow]);
    if (!table) return;
    await table.delete(stringPredicate('id', keywordRow.id));
    await table.add([keywordRow]);
    await this.ensureFtsIndex();
  }

  async deleteNodes(nodeIds = []) {
    if (!this.table) return;
    await this.table.delete(stringInPredicate('id', nodeIds));
  }

  async deleteDoc(docId) {
    if (!this.table) return;
    await this.table.delete(stringPredicate('doc_id', docId));
  }

  // 增量入库（projectneed 4-16）：批量 add 一批行，分批写入；LanceDB FTS 对 add 的行即时可搜，
  // 不 delete 整 doc、不全量重建索引。来源保证不重复 id（SQL 地址校验先拦重复推送）。
  async addRows(rows = []) {
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

  // 轻量计数（查询时判断该 doc 是否已建索引，避免全量拉行比对）。
  async countDocRows(docId) {
    if (!this.table) return 0;
    const normalized = String(docId ?? '').trim();
    if (!normalized) return 0;
    return this.table.countRows(stringPredicate('doc_id', normalized));
  }

  async search({ terms = [], docId = null, limit = 200 } = {}) {
    if (!this.table) return [];
    const query = (Array.isArray(terms) ? terms : [terms])
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
    const rows = await request.toArray();
    return rows.map((row) => ({
      node_id: String(row.id),
      doc_id: String(row.doc_id)
    })).filter((row) => row.node_id && row.doc_id);
  }
}
