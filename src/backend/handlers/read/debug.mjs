import { parseJsonObject } from '../../shared.mjs';

const TABLES = Object.freeze([
  'docs',
  'doc_folders',
  'nodes',
  'axioms',
  'errors',
  'refs',
  'source_documents',
  'source_spans'
]);

function normalizeLimit(value, fallback = 100, max = 1000) {
  const number = Math.floor(Number(value));
  if (!Number.isInteger(number) || number <= 0) return fallback;
  return Math.min(max, number);
}

function normalizeSqlParams(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return value;
  throw new Error('debug.sql params must be an array or object');
}

function normalizeReadOnlySql(value) {
  const sql = String(value || '').trim().replace(/;+$/g, '').trim();
  if (!sql) throw new Error('debug.sql query is required');
  if (!/^(select|with)\b/i.test(sql)) {
    throw new Error('debug.sql query must be read-only and start with SELECT or WITH');
  }
  return sql;
}

function assertReadOnlySqlStatement(store, sql) {
  const statement = store.db.prepare(sql);
  if (!statement.reader || !statement.readonly) {
    throw new Error('debug.sql query must be a read-only row-returning statement');
  }
}

function plainRow(row) {
  return row ? { ...row } : null;
}

function summarizeTreeViewState(value) {
  const state = parseJsonObject(value, {});
  return {
    depthLimit: Number(state.depthLimit) || null,
    collapsedNodeCount: Array.isArray(state.collapsedNodeIds) ? state.collapsedNodeIds.length : 0,
    expandedNodeCount: Array.isArray(state.expandedNodeIds) ? state.expandedNodeIds.length : 0,
    outlineCollapsedNodeCount: Array.isArray(state.outlineCollapsedNodeIds) ? state.outlineCollapsedNodeIds.length : 0
  };
}

function normalizeDocRow(row) {
  if (!row) return null;
  const { meta, tree_view_state: treeViewStateRaw, ...rest } = row;
  return {
    ...rest,
    meta: parseJsonObject(meta, {}),
    treeViewState: summarizeTreeViewState(treeViewStateRaw)
  };
}

function tableStats(store) {
  const stats = {};
  for (const table of TABLES) {
    stats[table] = Number(store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count || 0);
  }
  return stats;
}

function handleDebugOverviewQuery(store) {
  return {
    tables: tableStats(store),
    docs: store.listDocs().map(normalizeDocRow)
  };
}

function handleDebugSqlQuery(store, payload = {}) {
  const sql = normalizeReadOnlySql(payload.sql ?? payload.query ?? payload.q);
  assertReadOnlySqlStatement(store, sql);
  const params = normalizeSqlParams(payload.params);
  const limit = normalizeLimit(payload.limit, 1000, 10000);
  if (Array.isArray(params)) {
    const rows = store.db.prepare(`SELECT * FROM (${sql}) LIMIT ?`).all(...params, limit).map(plainRow);
    return { limit, rowCount: rows.length, truncated: rows.length >= limit, rows };
  }
  const rows = store.db.prepare(`SELECT * FROM (${sql}) LIMIT @__iftreeLimit`).all({
    ...params,
    __iftreeLimit: limit
  }).map(plainRow);
  return { limit, rowCount: rows.length, truncated: rows.length >= limit, rows };
}

export { handleDebugOverviewQuery, handleDebugSqlQuery };
