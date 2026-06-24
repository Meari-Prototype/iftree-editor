#!/usr/bin/env node
// @ts-nocheck
// 清理 refs 表里指向已不存在节点/事实前提的死引用行。
// 死行来源：补「节点摧毁 → 引用连带蒸发」逻辑（2026-06-11）之前，
// deleteNodeSubtree / mergeNodeIntoTarget / mergeNodeIntoPreviousSibling
// 删节点不清 refs 攒下的历史垃圾。refs 表无外键，库不会自动清。
//
// 用法（better-sqlite3 是 Electron ABI，必须用 electron 跑）：
//   ELECTRON_RUN_AS_NODE=1 electron scripts/prune-dead-refs.mjs            # dry-run，只统计
//   ELECTRON_RUN_AS_NODE=1 electron scripts/prune-dead-refs.mjs --yes      # 实际删除
//   ... prune-dead-refs.mjs --db D:\path\store.sqlite                      # 指定主库（缺省 IFTREE_DB 或项目 database/store.sqlite）
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 只判定已知端类型；未知 type 不动，避免误杀。
const DEAD_PREDICATE = `
  (source_type = 'node' AND source_id NOT IN (SELECT id FROM nodes))
  OR (target_type = 'node' AND target_id NOT IN (SELECT id FROM nodes))
  OR (source_type = 'axiom' AND source_id NOT IN (SELECT id FROM axioms))
  OR (target_type = 'axiom' AND target_id NOT IN (SELECT id FROM axioms))
`;

function mainDbPath() {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--db' && argv[i + 1]) return resolve(argv[i + 1]);
  }
  return resolve(process.env.IFTREE_DB || join(PROJECT_ROOT, 'database', 'store.sqlite'));
}

function describeDeadEnd(db, row) {
  const reasons = [];
  const nodeExists = db.prepare('SELECT 1 FROM nodes WHERE id = ?');
  const axiomExists = db.prepare('SELECT 1 FROM axioms WHERE id = ?');
  const endAlive = (type, id) => {
    if (type === 'node') return Boolean(nodeExists.get(id));
    if (type === 'axiom') return Boolean(axiomExists.get(id));
    return true;
  };
  if (!endAlive(row.source_type, row.source_id)) reasons.push(`source ${row.source_type}:${row.source_id} 已不存在`);
  if (!endAlive(row.target_type, row.target_id)) reasons.push(`target ${row.target_type}:${row.target_id} 已不存在`);
  return reasons.join('；');
}

function main() {
  const apply = process.argv.includes('--yes');
  const dbPath = mainDbPath();
  if (!existsSync(dbPath)) {
    throw new Error(`主库不存在: ${dbPath}（用 --db 指定，或设 IFTREE_DB）`);
  }
  console.log(`主库: ${dbPath}${apply ? '' : '（dry-run）'}`);

  const db = new Database(dbPath, { readonly: !apply, fileMustExist: true });
  try {
    const total = db.prepare('SELECT COUNT(*) AS c FROM refs').get().c;
    const deadRows = db.prepare(`
      SELECT id, source_type, source_id, target_type, target_id, ref_kind
      FROM refs
      WHERE ${DEAD_PREDICATE}
      ORDER BY id
    `).all();
    console.log(`refs 总行数 ${total}，死引用行 ${deadRows.length}`);

    for (const row of deadRows) {
      console.log(`  ${row.id} [${row.ref_kind}] ${row.source_type}:${row.source_id} -> ${row.target_type}:${row.target_id}（${describeDeadEnd(db, row)}）`);
    }

    if (deadRows.length === 0) return;

    if (apply) {
      const result = db.prepare(`DELETE FROM refs WHERE ${DEAD_PREDICATE}`).run();
      const remaining = db.prepare(`SELECT COUNT(*) AS c FROM refs WHERE ${DEAD_PREDICATE}`).get().c;
      console.log(`已删除 ${result.changes} 行，剩余死引用行 ${remaining}`);
    } else {
      console.log('\ndry-run 完成，未做任何修改；加 --yes 执行删除。');
    }
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(error?.message || error);
  process.exit(1);
}
