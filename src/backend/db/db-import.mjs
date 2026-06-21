// 库级导入：把导出的 dump 灌进一个已建好 schema 的空库（db 含表/索引/触发器）。
// 整表照搬 + 字段对齐（共有列才搬、缺列走 DEFAULT、派生列由触发器和首次访问重算）+ 非法值现场规范化。
// id 有值复用（整数主键或 UUID 都原样）、空则重生 UUIDv7——0.5.0 live 的 id 都齐，实践中全复用，引用天然自洽。
// foreign_keys 临时关闭整表搬（源数据本自洽），结束开启并做完整性检查、报告悬挂引用。

import { newStableId } from './ids.mjs';
import { normalizeNodeSizeMode, normalizeDocFolderName } from './normalizers.mjs';
import { normalizeNodeType } from '../../core/node-model.mjs';

// 旧导入器产物的占位标题（最新导入不再产生这种）——按最新规则清空。
const GENERATED_PARAGRAPH_TITLE = /^段\d+\s*[·・]\s*\d+句$/u;

// 非法值现场规范化（per-table 逐行钩子；吸收原启动期三类清洗里的单行规范化部分）。
const TRANSFORMS = {
  nodes(row) {
    row.node_type = normalizeNodeType(row.node_type);
    if (GENERATED_PARAGRAPH_TITLE.test(String(row.node_title ?? '').trim())) row.node_title = '';
  },
  axioms(row) {
    row.node_size_mode = normalizeNodeSizeMode(row.node_size_mode);
  },
  doc_folders(row) {
    row.name = normalizeDocFolderName(row.name);
  }
};

// id 规则：有值复用、空则重生 UUIDv7。
function resolveId(value) {
  return value === null || value === undefined || value === '' ? newStableId() : value;
}

// 跨表清洗（整库搬完后跑一次）：公理不得把根节点当「事实前提」，按最新规则删除这类非法引用。
function postImportCleanup(db) {
  db.prepare(`
    DELETE FROM refs
    WHERE source_type = 'axiom' AND target_type = 'node' AND ref_kind = '事实前提'
      AND EXISTS (
        SELECT 1 FROM axioms
        JOIN nodes roots ON roots.doc_id = axioms.doc_id AND roots.parent_id IS NULL
        WHERE axioms.id = refs.source_id AND roots.id = refs.target_id
      )
  `).run();
}

function importTable(db, name, table, transform) {
  const rows = table.rows || [];
  if (rows.length === 0) return 0;
  const targetColumns = new Set(
    db.prepare(`PRAGMA table_info("${name}")`).all().map((col) => col.name)
  );
  const sourceColumns = table.columns || [];
  const shared = sourceColumns.filter((col) => targetColumns.has(col));
  if (shared.length === 0) return 0;
  const colList = shared.map((col) => `"${col}"`).join(', ');
  const placeholders = shared.map(() => '?').join(', ');
  const insert = db.prepare(`INSERT INTO "${name}" (${colList}) VALUES (${placeholders})`);
  const hasId = sourceColumns.includes('id');

  let count = 0;
  for (const rawRow of rows) {
    const row = {};
    sourceColumns.forEach((col, i) => { row[col] = rawRow[i]; });
    if (hasId) row.id = resolveId(row.id);
    if (transform) transform(row);
    insert.run(shared.map((col) => row[col] ?? null));
    count += 1;
  }
  return count;
}

// dump = { schema_version, exported_at, tables }；db 须已建好最新 schema 的空库。
// 返回 { counts: { <table>: n }, violations: [...] }，violations 非空即有悬挂外键。
export function importDatabase(db, dump, { transforms = TRANSFORMS } = {}) {
  const tables = dump.tables || {};
  db.pragma('foreign_keys = OFF');
  const counts = {};
  const run = db.transaction(() => {
    for (const [name, table] of Object.entries(tables)) {
      counts[name] = importTable(db, name, table, transforms[name]);
    }
    postImportCleanup(db);
  });
  run();
  db.pragma('foreign_keys = ON');
  const violations = db.pragma('foreign_key_check');
  return { counts, violations };
}
