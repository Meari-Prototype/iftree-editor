#!/usr/bin/env node
// 库级导入：把导出的 json 灌进一个全新空库（按最新 schema 建表+索引+触发器，逐表搬+字段对齐+id 复用/重生）。
// 跑法：electron scripts/import-db-from-json.mjs <dump.json> [目标库路径] --apply
//   不带 --apply 只做 dry-run 报告；目标库默认 database/store.sqlite。
//   只进「不存在的目标」——拒绝覆盖已有库（迁移时先把旧库移走/改名，再导入重建）。

import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TABLES_SQL, SCHEMA_VERSION } from '../src/backend/db/schema.js';
import { importDatabase } from '../src/backend/db/db-import.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const positional = args.filter((arg) => !arg.startsWith('--'));
const jsonPath = positional[0];
const targetPath = positional[1] || join(ROOT, 'database', 'store.sqlite');

interface DumpTable {
  rows?: unknown[];
}

interface JsonDump {
  schema_version?: unknown;
  tables?: Record<string, DumpTable>;
}

interface ImportResult {
  counts: Record<string, number>;
  violations: unknown[];
}

function main() {
  if (!jsonPath) {
    console.error('用法: electron scripts/import-db-from-json.mjs <dump.json> [目标库路径] --apply');
    process.exitCode = 1;
    return;
  }
  if (!existsSync(jsonPath)) {
    console.error(`[import-db] 找不到 dump：${jsonPath}`);
    process.exitCode = 1;
    return;
  }
  const dump = JSON.parse(readFileSync(jsonPath, 'utf8')) as JsonDump;
  const tables = dump.tables || {};
  const tableCount = Object.keys(tables).length;
  const rowCount = Object.values(tables).reduce((sum, table) => sum + (table.rows?.length || 0), 0);
  console.log(`[import-db] dump=${jsonPath} schema_version=${dump.schema_version} → 目标=${targetPath} apply=${APPLY}`);

  if (existsSync(targetPath)) {
    console.error(`[import-db] 目标已存在，拒绝覆盖（导入只进空库）：${targetPath}`);
    process.exitCode = 1;
    return;
  }
  if (!APPLY) {
    console.log(`[import-db] dry-run：将建空库并导入 ${tableCount} 表 / ${rowCount} 行。确认后加 --apply 执行。`);
    return;
  }

  const db = new Database(targetPath);
  db.pragma('journal_mode = MEMORY');
  db.pragma('synchronous = OFF');
  db.exec(TABLES_SQL);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
  const result = importDatabase(db, dump as Parameters<typeof importDatabase>[1]) as ImportResult;
  db.close();

  const imported = Object.values(result.counts).reduce((sum, n) => sum + n, 0);
  console.log(`[import-db] 导入 ${Object.keys(result.counts).length} 表 / ${imported} 行`);
  if (result.violations.length > 0) {
    console.error(`[import-db] 外键完整性检查发现 ${result.violations.length} 处悬挂引用：`, result.violations.slice(0, 10));
    process.exitCode = 1;
    return;
  }
  console.log('[import-db] 外键完整性检查通过');
}

main();
