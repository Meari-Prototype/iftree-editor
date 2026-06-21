// 库级导出：把「真实数据」表整表导成 json（逐表 columns + rows），带 schema 版本头。
// 导入端按 columns 对齐字段，故导出不依赖列序、可跨 schema 演进。
//
// 不导出：
// - 向量库 / 关键词索引：独立 LanceDB，本就不在这个 sqlite 库里。
// - nodes 的哈希 / 字数缓存列：派生量，导入后由触发器（字数）和脏标记 + 首次访问（哈希）现场重算。
//   历史对象库的哈希不在此列——它是内容寻址的存储本体（objects.hash），整表照搬。

const EMPTY_SET = new Set();

export const DERIVED_COLUMNS = {
  nodes: new Set(['content_hash', 'subtree_hash', 'title_chars', 'text_chars', 'note_chars'])
};

// 读出库里所有真实数据表（排除 sqlite 内部表），逐表导出。
// 返回 { schema_version, exported_at, tables: { <name>: { columns, rows } } }，rows 为按 columns 取值的数组。
export function exportDatabase(db, { schemaVersion = null, exportedAt = null } = {}) {
  const tableNames = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map((row) => row.name);

  const tables = {};
  for (const name of tableNames) {
    const allColumns = db.prepare(`PRAGMA table_info("${name}")`).all().map((col) => col.name);
    const derived = DERIVED_COLUMNS[name] || EMPTY_SET;
    const columns = allColumns.filter((col) => !derived.has(col));
    const selectList = columns.map((col) => `"${col}"`).join(', ');
    const rows = db.prepare(`SELECT ${selectList} FROM "${name}"`).all();
    tables[name] = {
      columns,
      rows: rows.map((row) => columns.map((col) => row[col]))
    };
  }

  return { schema_version: schemaVersion, exported_at: exportedAt, tables };
}
