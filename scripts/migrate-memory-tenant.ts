#!/usr/bin/env node
// @ts-nocheck
// 一次性迁移：给记忆区补租户层，修复多租户隔离（projectneed 15-10-4）。
//  现状非法：事件卷锚直挂 .memory/<工作区>/（缺租户层）、长期核心记忆 memory/<x>.md（缺租户目录层）。
//  迁移目标：.memory/<工作区>/<会话> → .memory/<租户>/<工作区>/<会话>（租户=该卷的 agent）；
//            memory/<x>.md → memory/<x>/CLAUDE.md。
//  做法：物理移动锚（renameSync 保 symlink/占位）+ 同步 source_documents.original_path；删空的旧目录。
//  默认 dry-run 只打印计划；加 --apply 才动。直连 better-sqlite3，请在共享后端空闲时跑（迁移期别发 MCP 写请求）。
//  跑法：ELECTRON_RUN_AS_NODE=1 electron scripts/migrate-memory-tenant.mjs [--apply]
import Database from 'better-sqlite3';
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB_PATH = process.env.IFTREE_DB || join(ROOT, 'database', 'store.sqlite');
const LIBRARY_ROOT = process.env.IFTREE_LIBRARY_ROOT || join(ROOT, 'library');
const APPLY = process.argv.includes('--apply');
const MEMORY_DIR = join(LIBRARY_ROOT, '.memory');
const LONGTERM_DIR = join(LIBRARY_ROOT, 'memory');
const SEP_MEM = `${sep}.memory${sep}`;

function isSymlink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

async function main() {
  const db = new Database(DB_PATH);
  const volumes = db.prepare(`
    SELECT d.id, json_extract(d.meta,'$.memoryVolume.agent') AS agent, s.original_path AS p
      FROM docs d JOIN source_documents s ON s.doc_id = d.id
     WHERE json_extract(d.meta,'$.memoryVolume') IS NOT NULL AND s.original_path IS NOT NULL
     ORDER BY s.original_path
  `).all();
  const updatePath = db.prepare('UPDATE source_documents SET original_path = ? WHERE doc_id = ?');
  // 现有 agent 集 = 合法租户名；.memory 下第一段已是租户名的卷视为已合法、跳过。
  const tenants = new Set(volumes.map((v) => String(v.agent || '')).filter(Boolean));

  const plan = [];
  for (const v of volumes) {
    const agent = String(v.agent || '').trim();
    if (!agent) continue;
    const i = v.p.indexOf(SEP_MEM);
    if (i < 0) continue;
    const after = v.p.slice(i + SEP_MEM.length); // <工作区>\<会话> 或已 <租户>\<工作区>\<会话>
    const first = after.split(sep)[0];
    if (tenants.has(first)) continue; // 已是 <租户>/，合法
    plan.push({ id: v.id, oldPath: v.p, newPath: join(MEMORY_DIR, agent, after) });
  }

  // 长期核心记忆：memory/<x>.md（直挂文件）→ memory/<x>/CLAUDE.md；同步可能存在的 DB 锚。
  const longterm = [];
  if (existsSync(LONGTERM_DIR)) {
    for (const e of readdirSync(LONGTERM_DIR, { withFileTypes: true })) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        const tenant = e.name.replace(/\.md$/i, '');
        const from = join(LONGTERM_DIR, e.name);
        const to = join(LONGTERM_DIR, tenant, 'CLAUDE.md');
        const docRow = db.prepare('SELECT doc_id FROM source_documents WHERE original_path = ?').get(from);
        longterm.push({ from, to, docId: docRow?.doc_id || null });
      }
    }
  }

  console.log(`[migrate] DB=${DB_PATH}`);
  console.log(`[migrate] 事件卷 ${volumes.length}，需补租户层 ${plan.length}（已合法 ${volumes.length - plan.length}）`);
  for (const p of plan.slice(0, 5)) console.log(`  ${p.oldPath}\n    → ${p.newPath}`);
  if (plan.length > 5) console.log(`  ... 其余 ${plan.length - 5} 个同形`);
  console.log(`[migrate] 长期核心记忆 ${longterm.length}：`);
  for (const l of longterm) console.log(`  ${l.from} → ${l.to}${l.docId ? `（DB 锚 doc=${l.docId}）` : '（纯文件、无 DB 锚）'}`);

  if (!APPLY) {
    console.log('\n--- DRY RUN（未动任何文件 / DB）。确认无误后加 --apply 执行。 ---');
    db.close();
    return;
  }

  // 动手前备份（对齐 migrate-tree-objects；记忆区迁移同样不可逆，留一个回滚点）。
  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const backupPath = `${DB_PATH}.pre-memory-tenant-${stamp}.bak`;
  console.log(`[migrate] 备份 DB → ${backupPath}`);
  await db.backup(backupPath);

  let done = 0;
  let failed = 0;
  for (const p of plan) {
    try {
      mkdirSync(dirname(p.newPath), { recursive: true });
      if (existsSync(p.oldPath) || isSymlink(p.oldPath)) renameSync(p.oldPath, p.newPath);
      updatePath.run(p.newPath, p.id);
      done += 1;
    } catch (error) {
      failed += 1;
      console.error(`[x] ${p.id}: ${error.message}`);
    }
  }
  for (const l of longterm) {
    try {
      mkdirSync(dirname(l.to), { recursive: true });
      if (existsSync(l.from)) renameSync(l.from, l.to);
      if (l.docId) updatePath.run(l.to, l.docId);
    } catch (error) {
      console.error(`[x] longterm ${l.from}: ${error.message}`);
    }
  }
  for (const e of readdirSync(MEMORY_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const d = join(MEMORY_DIR, e.name);
    try { if (readdirSync(d).length === 0) rmdirSync(d); } catch { /* 非空 / 占用跳过 */ }
  }
  console.log(`[migrate] 事件卷 done=${done} failed=${failed}；长期核心记忆 ${longterm.length} 个已迁。`);
  db.close();
}

main().catch((error) => {
  console.error('[migrate] 失败：', error);
  process.exitCode = 1;
});
