import { parseJsonObject } from '../../shared.js';

// 与 db/schema.mjs 的 TABLES_SQL 保持一致；errors 表只存在于 PRD 设计稿，
// 代码从未建过——列进来会让 COUNT(*) 直接抛 no such table。
const TABLES = Object.freeze([
  'docs',
  'doc_folders',
  'nodes',
  'axioms',
  'refs',
  'source_documents',
  'source_spans',
  'source_pdf_pages',
  'source_pdf_chars',
  'save_history',
  'commits',
  'doc_heads',
  'edit_branches',
  'entities',
  'entity_links',
  'entity_node_bindings'
]);

type SqlParams = unknown[] | Record<string, unknown>;
type RowObject = Record<string, unknown>;

interface DebugStore {
  db: {
    prepare(sql: string): {
      reader?: boolean;
      readonly?: boolean;
      get(...params: unknown[]): RowObject | undefined;
      all(...params: unknown[]): RowObject[];
    };
  };
  hasTable?: (table: string) => boolean;
  listDocs(): RowObject[];
}

function normalizeLimit(value: unknown, fallback = 100, max = 1000): number {
  const number = Math.floor(Number(value));
  if (!Number.isInteger(number) || number <= 0) return fallback;
  return Math.min(max, number);
}

function normalizeSqlParams(value: unknown): SqlParams {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return value as Record<string, unknown>;
  throw new Error('debug.sql params must be an array or object');
}

function normalizeReadOnlySql(value: unknown): string {
  const sql = String(value || '').trim().replace(/;+$/g, '').trim();
  if (!sql) throw new Error('debug.sql query is required');
  if (!/^(select|with)\b/i.test(sql)) {
    throw new Error('debug.sql query must be read-only and start with SELECT or WITH');
  }
  return sql;
}

function assertReadOnlySqlStatement(store: DebugStore, sql: string): void {
  const statement = store.db!.prepare(sql);
  if (!statement.reader || !statement.readonly) {
    throw new Error('debug.sql query must be a read-only row-returning statement');
  }
}

function plainRow(row: RowObject | null | undefined): RowObject | null {
  return row ? { ...row } : null;
}

function summarizeTreeViewState(value: unknown) {
  const state = parseJsonObject(value, {});
  return {
    depthLimit: Number(state.depthLimit) || null,
    collapsedNodeCount: Array.isArray(state.collapsedNodeIds) ? state.collapsedNodeIds.length : 0,
    expandedNodeCount: Array.isArray(state.expandedNodeIds) ? state.expandedNodeIds.length : 0,
    outlineCollapsedNodeCount: Array.isArray(state.outlineCollapsedNodeIds) ? state.outlineCollapsedNodeIds.length : 0
  };
}

function normalizeDocRow(row: RowObject | null | undefined) {
  if (!row) return null;
  const { meta, tree_view_state: treeViewStateRaw, ...rest } = row;
  return {
    ...rest,
    meta: parseJsonObject(meta, {}),
    treeViewState: summarizeTreeViewState(treeViewStateRaw)
  };
}

function tableStats(store: DebugStore): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const table of TABLES) {
    // query-db 以 readonly+migrate:false 打开任意路径的库，可能是缺新表的旧库：
    // 只统计实际存在的表，缺的跳过而不是让 COUNT(*) 抛 no such table。
    if (typeof store.hasTable === 'function' && !store.hasTable(table)) continue;
    stats[table] = Number(store.db!.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count || 0);
  }
  return stats;
}

function handleDebugOverviewQuery(store: DebugStore) {
  return {
    tables: tableStats(store),
    docs: store.listDocs().map(normalizeDocRow)
  };
}

function handleDebugSqlQuery(store: DebugStore, payload: RowObject = {}) {
  const sql = normalizeReadOnlySql(payload.sql ?? payload.query ?? payload.q);
  assertReadOnlySqlStatement(store, sql);
  const params = normalizeSqlParams(payload.params);
  const limit = normalizeLimit(payload.limit, 1000, 10000);
  const probeLimit = limit + 1;
  if (Array.isArray(params)) {
    const rows = store.db!.prepare(`SELECT * FROM (${sql}) LIMIT ?`).all(...params, probeLimit).map(plainRow);
    return { limit, rowCount: Math.min(rows.length, limit), truncated: rows.length > limit, rows: rows.slice(0, limit) };
  }
  const rows = store.db!.prepare(`SELECT * FROM (${sql}) LIMIT @__iftreeLimit`).all({
    ...params,
    __iftreeLimit: probeLimit
  }).map(plainRow);
  return { limit, rowCount: Math.min(rows.length, limit), truncated: rows.length > limit, rows: rows.slice(0, limit) };
}

export { handleDebugOverviewQuery, handleDebugSqlQuery };
