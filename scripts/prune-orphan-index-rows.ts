#!/usr/bin/env node
// @ts-nocheck
// 清理 LanceDB 派生索引（关键词/向量）里主库已不存在 doc 的孤儿行。
// 孤儿来源：隔离前的 tests/db 运行与手动 db import 把临时 sqlite 的 docId
// 写进了共享 ~/.iftree 的 LanceDB。
//
// 用法（better-sqlite3 是 Electron ABI，必须用 electron 跑）：
//   ELECTRON_RUN_AS_NODE=1 electron scripts/prune-orphan-index-rows.mjs                # dry-run，只统计
//   ELECTRON_RUN_AS_NODE=1 electron scripts/prune-orphan-index-rows.mjs --yes          # 实际删除
//   ... prune-orphan-index-rows.mjs --db F:\path\store.sqlite                          # 追加合法主库
// 索引库取 IFTREE_HOME（缺省 ~/.iftree）下 vectors/nodes.lance。
// 同一个索引库可能被多个主库共用过（IFTREE_DB 可切换），所以合法 doc 集取并集：
// IFTREE_DB（或项目默认 database/store.sqlite）+ IFTREE_HOME 同目录的 store.sqlite + 所有 --db。
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as lancedb from '@lancedb/lancedb';
import Database from 'better-sqlite3';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TABLES = ['nodes_keyword', 'nodes_vec'];

function quoteValue(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function homeRoot() {
  return process.env.IFTREE_HOME || join(homedir(), '.iftree');
}

function mainDbCandidates() {
  const list = [process.env.IFTREE_DB || join(PROJECT_ROOT, 'database', 'store.sqlite')];
  const homeDb = join(homeRoot(), 'store.sqlite');
  if (existsSync(homeDb)) list.push(homeDb);
  const argv = process.argv;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--db' && argv[i + 1]) list.push(argv[i + 1]);
  }
  return [...new Set(list.map((path) => resolve(path)))];
}

function lanceDbPath() {
  return join(homeRoot(), 'vectors', 'nodes.lance');
}

async function main() {
  const apply = process.argv.includes('--yes');
  const lancePath = lanceDbPath();
  console.log(`索引库: ${lancePath}`);

  const validIdSet = new Set();
  for (const sqlitePath of mainDbCandidates()) {
    if (!existsSync(sqlitePath)) {
      console.log(`主库: ${sqlitePath}（不存在，跳过）`);
      continue;
    }
    const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    const ids = db.prepare('SELECT id FROM docs').all().map((row) => String(row.id));
    db.close();
    for (const id of ids) validIdSet.add(id);
    console.log(`主库: ${sqlitePath}（${ids.length} 个文档）`);
  }
  const validIds = [...validIdSet];
  if (validIds.length === 0) {
    throw new Error('所有主库 docs 都为空：路径很可能不对，拒绝继续（否则会把索引行全部判为孤儿）。');
  }
  console.log(`合法文档并集: ${validIds.length}`);

  const orphanPredicate = `doc_id NOT IN (${validIds.map(quoteValue).join(',')})`;
  const connection = await lancedb.connect(lancePath);
  const tableNames = await connection.tableNames();

  for (const name of TABLES) {
    if (!tableNames.includes(name)) {
      console.log(`\n[${name}] 表不存在，跳过`);
      continue;
    }
    const table = await connection.openTable(name);
    const total = await table.countRows();
    const orphanCount = await table.countRows(orphanPredicate);
    console.log(`\n[${name}] 总行数 ${total}，孤儿行 ${orphanCount}`);
    if (orphanCount === 0) continue;

    const orphanRows = await table.query().where(orphanPredicate).select(['doc_id']).limit(200000).toArray();
    const orphanDocIds = [...new Set(orphanRows.map((row) => String(row.doc_id)))];
    console.log(`[${name}] 孤儿 doc（${orphanDocIds.length} 个）:`);
    for (const docId of orphanDocIds) console.log(`  ${docId}`);

    if (apply) {
      await table.delete(orphanPredicate);
      const remaining = await table.countRows(orphanPredicate);
      console.log(`[${name}] 已删除，剩余孤儿行 ${remaining}`);
    }
  }

  if (!apply) console.log('\ndry-run 完成，未做任何修改；加 --yes 执行删除。');
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
