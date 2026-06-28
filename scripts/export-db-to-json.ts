#!/usr/bin/env node
// 库级导出：把 live 库的真实数据导成单个 json（带 schema 版本头）。只读、不改源库。
// 跑法：electron scripts/export-db-to-json.mjs [输出路径]
//   不传输出路径则写 database/export-<时戳>.json。
// 与活后端可并发（只读），但要拿来做迁移替换 live 库时，建议先停后端。

import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { exportDatabase } from '../src/backend/db/db-export.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PATH = process.env.IFTREE_DB || join(ROOT, 'database', 'store.sqlite');
const outArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));

function main() {
  console.log(`[export-db] DB=${DB_PATH}`);
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const schemaVersion = db.pragma('user_version', { simple: true });
  const exportedAt = new Date().toISOString();
  const dump = exportDatabase(db, { schemaVersion, exportedAt });
  db.close();

  const stamp = exportedAt.replace(/[:.]/g, '').slice(0, 15);
  const outPath = outArg || join(ROOT, 'database', `export-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(dump));

  const tableCount = Object.keys(dump.tables).length;
  const rowCount = Object.values(dump.tables).reduce((sum, table) => sum + table.rows.length, 0);
  console.log(`[export-db] schema_version=${schemaVersion} tables=${tableCount} rows=${rowCount}`);
  console.log(`[export-db] → ${outPath}`);
}

main();
