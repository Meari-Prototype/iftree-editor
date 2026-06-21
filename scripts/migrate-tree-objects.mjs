#!/usr/bin/env node
// 第 4 步存量迁移：把旧 commit 的整篇 snapshot 转进内容寻址对象库。
//   backfill：逐个旧 commit（root_tree_hash 为空）→ 解析旧 snapshot/diff → writeTree + writeSource +
//             buildCommitMeta（与 createCommit 同一套函数，产出逐字节一致）→ 回填 root_*/source_hash/meta。
//   verify  ：逐 commit 用对象库重建快照，与旧 snapshot 比内容+结构（忽略 address/depth/source_position/
//             时间戳这些不入对象库的派生量）；axioms/refs 计数、raw_markdown 也比。零差异才算过。
//   drop    ：verify 全过后才删 snapshot/diff 列（破坏性，--drop 显式触发）。
//
// 必须在后端停止时跑（它会写 commits/objects；与活后端并发写会撞 WAL）。--apply 前自动 db.backup() 备份。
// 用法：electron scripts/migrate-tree-objects.mjs            # dry-run：报需迁移数 + 校验已迁移的
//      electron scripts/migrate-tree-objects.mjs --apply    # 备份 + backfill + verify（不删列）
//      electron scripts/migrate-tree-objects.mjs --apply --drop  # 再删 snapshot/diff 列
import Database from 'better-sqlite3';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCommitMeta,
  materializeTree,
  readSource,
  writeSource,
  writeTree
} from '../src/backend/db/object-store.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.IFTREE_DB || join(ROOT, 'database', 'store.sqlite');
const APPLY = process.argv.includes('--apply');
const DROP = process.argv.includes('--drop');

function oldSnapshot(row) {
  try { const s = JSON.parse(row.snapshot || 'null'); if (s?.nodes) return s; } catch { /* fall through */ }
  try {
    const d = JSON.parse(row.diff || '{}');
    const s = d.snapshot || (d.kind === 'snapshot' ? d : null);
    if (s?.nodes) return s;
  } catch { /* ignore */ }
  return null;
}

function oldEntries(row) {
  try { const d = JSON.parse(row.diff || '{}'); if (Array.isArray(d.entries)) return d.entries; } catch { /* ignore */ }
  return null;
}

// 内容+结构投影：按稳定 id 取内容字段 + parent + 父下子序（rank）；忽略 address/depth/source_position/时间戳。
function contentStructure(nodes = []) {
  const byId = new Map();
  const childrenByParent = new Map();
  for (const n of nodes) {
    const id = String(n.id);
    const parent = n.parent_id == null ? null : String(n.parent_id);
    byId.set(id, {
      parent,
      text: n.text ?? '',
      node_title: n.node_title ?? '',
      node_note: n.node_note ?? '',
      node_type: n.node_type ?? 'TEXT',
      trust_level: n.trust_level == null || n.trust_level === '' ? null : n.trust_level
    });
    const key = parent == null ? '__root__' : parent;
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(n);
  }
  // 每个父下按 sort_order 排出有序子 id 列表（绝对值不比，只比次序）。
  const order = new Map();
  for (const [key, list] of childrenByParent) {
    const sorted = [...list].sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
    order.set(key, sorted.map((n) => String(n.id)));
  }
  return { byId, order };
}

function diffTree(oldNodes, newNodes) {
  const a = contentStructure(oldNodes);
  const b = contentStructure(newNodes);
  const problems = [];
  if (a.byId.size !== b.byId.size) problems.push(`节点数 ${a.byId.size}→${b.byId.size}`);
  for (const [id, av] of a.byId) {
    const bv = b.byId.get(id);
    if (!bv) { problems.push(`缺失节点 ${id}`); continue; }
    for (const f of ['parent', 'text', 'node_title', 'node_note', 'node_type', 'trust_level']) {
      if (av[f] !== bv[f]) problems.push(`节点 ${id} 字段 ${f}: ${JSON.stringify(av[f])}→${JSON.stringify(bv[f])}`);
    }
  }
  for (const [key, aOrder] of a.order) {
    const bOrder = b.order.get(key) || [];
    if (aOrder.join(',') !== bOrder.join(',')) problems.push(`父 ${key} 子序变化`);
  }
  return problems;
}

function verifyCommit(db, row) {
  const snap = oldSnapshot(row);
  if (!row.root_tree_hash) return { skipped: true, reason: 'no_root_tree_hash' };
  const nodes = materializeTree(db, row.root_tree_hash, row.root_node_id);
  if (!snap) return { ok: nodes.length > 0, reconstructedOnly: true, nodeCount: nodes.length };
  const problems = diffTree(snap.nodes || [], nodes);
  // raw_markdown
  const raw = readSource(db, row.source_hash);
  const oldRaw = snap.sourceDocument?.raw_markdown || '';
  if (raw !== oldRaw) problems.push(`raw_markdown 不一致（${oldRaw.length}→${raw.length} 字符）`);
  // axioms/refs 计数
  const meta = JSON.parse(row.meta || '{}');
  const oldAx = Array.isArray(snap.axioms) ? snap.axioms.length : 0;
  const newAx = Array.isArray(meta.axioms) ? meta.axioms.length : 0;
  if (oldAx !== newAx) problems.push(`axioms 计数 ${oldAx}→${newAx}`);
  const oldRefs = Array.isArray(snap.refs) ? snap.refs.length : 0;
  const newRefs = Array.isArray(meta.refs) ? meta.refs.length : 0;
  if (oldRefs !== newRefs) problems.push(`refs 计数 ${oldRefs}→${newRefs}`);
  return { ok: problems.length === 0, problems };
}

async function main() {
  console.log(`[tree-objects] DB=${DB_PATH}  apply=${APPLY}  drop=${DROP}`);
  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');

  // 列/表存在性兜底（正常启动已建；独立跑也安全）。
  const cols = new Set(db.prepare('PRAGMA table_info(commits)').all().map((c) => c.name));
  const hasSnapshotCol = cols.has('snapshot');
  for (const [name, def] of [['root_node_id', 'TEXT'], ['root_tree_hash', 'TEXT'], ['source_hash', 'TEXT'], ['meta', 'TEXT']]) {
    if (!cols.has(name)) db.exec(`ALTER TABLE commits ADD COLUMN ${name} ${def}`);
  }
  db.exec("CREATE TABLE IF NOT EXISTS objects (hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('blob','tree','source')), data TEXT NOT NULL)");

  const total = db.prepare('SELECT COUNT(*) AS n FROM commits').get().n;
  // 未迁移 = 无 tree 且无 meta（迁过的 entries-only commit 有 meta、root_tree_hash 仍空，不再重复计）。
  const pending = db.prepare('SELECT COUNT(*) AS n FROM commits WHERE root_tree_hash IS NULL AND meta IS NULL').get().n;
  console.log(`[tree-objects] commit 总数 ${total}；待迁移 ${pending}`);

  if (!APPLY) {
    // dry-run：报旧快照可解析性 + 只有操作条目（无快照、本就不可恢复）的 commit 数。
    let withSnapshot = 0;
    let entriesOnly = 0;
    let empty = 0;
    if (hasSnapshotCol) {
      for (const row of db.prepare('SELECT id, snapshot, diff FROM commits WHERE root_tree_hash IS NULL AND meta IS NULL').all()) {
        if (oldSnapshot(row)) withSnapshot += 1;
        else if ((oldEntries(row) || []).length) entriesOnly += 1;
        else empty += 1;
      }
    }
    console.log(`[tree-objects] dry-run：可迁快照 ${withSnapshot}；仅操作条目(不可恢复,只迁entries保cherry-pick) ${entriesOnly}；空(跳过) ${empty}`);
    console.log('确认后加 --apply 执行（会先 db.backup() 备份）。');
    db.close();
    return;
  }

  // 备份。
  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const backupPath = `${DB_PATH}.pre-tree-objects-${stamp}.bak`;
  console.log(`[tree-objects] 备份 → ${backupPath}`);
  await db.backup(backupPath);

  // backfill。
  let migrated = 0;
  let entriesOnly = 0;
  let skipped = 0;
  if (!hasSnapshotCol) {
    console.log('[tree-objects] 无 snapshot 列，无可迁移的旧数据（已是新格式）。');
  }
  const selectPending = db.prepare('SELECT id, root_tree_hash, snapshot, diff FROM commits WHERE root_tree_hash IS NULL AND meta IS NULL');
  const update = db.prepare('UPDATE commits SET root_node_id = ?, root_tree_hash = ?, source_hash = ?, meta = ? WHERE id = ?');
  const backfill = db.transaction(() => {
    for (const row of hasSnapshotCol ? selectPending.all() : []) {
      const snap = oldSnapshot(row);
      const entries = oldEntries(row);
      if (!snap) {
        if (entries && entries.length) {
          // 无快照但有操作条目（早期 edit-branch save，本就不可恢复）：只迁 entries 保 cherry-pick，
          // root_tree_hash 维持空（仍不可恢复，与历史一致），删 diff 列时不丢它。
          update.run(null, null, null, JSON.stringify(buildCommitMeta({}, entries)), row.id);
          entriesOnly += 1;
        } else {
          skipped += 1;
          console.warn(`[skip] commit ${row.id}：无快照且无操作条目`);
        }
        continue;
      }
      const tree = writeTree(db, snap.nodes || []);
      const sourceHash = writeSource(db, snap.sourceDocument?.raw_markdown);
      const meta = buildCommitMeta(snap, entries);
      update.run(tree?.root_node_id || null, tree?.root_tree_hash || null, sourceHash, JSON.stringify(meta), row.id);
      migrated += 1;
    }
  });
  backfill();
  console.log(`[tree-objects] backfill 完成：迁移 ${migrated}，仅条目 ${entriesOnly}，跳过 ${skipped}`);
  const objCount = db.prepare('SELECT COUNT(*) AS n FROM objects').get().n;
  console.log(`[tree-objects] objects 表对象数 ${objCount}`);

  // verify（逐 commit 重建比对）。
  let verified = 0;
  let failed = 0;
  const allCols = new Set(db.prepare('PRAGMA table_info(commits)').all().map((c) => c.name));
  const verifySelect = allCols.has('snapshot')
    ? db.prepare('SELECT id, root_node_id, root_tree_hash, source_hash, meta, snapshot, diff FROM commits')
    : db.prepare('SELECT id, root_node_id, root_tree_hash, source_hash, meta FROM commits');
  for (const row of verifySelect.all()) {
    let r;
    try {
      r = verifyCommit(db, row);
    } catch (error) {
      // 对象缺失等重建异常：记一条 failed、不中断整轮，让"verify 全过才删列"的安全闸照常拦住删列。
      failed += 1;
      console.error(`[verify x] commit ${row.id}：重建异常 ${error.message}`);
      continue;
    }
    if (r.skipped) continue;
    if (r.ok) { verified += 1; continue; }
    failed += 1;
    console.error(`[verify x] commit ${row.id}：${(r.problems || []).slice(0, 5).join(' | ')}`);
  }
  console.log(`[tree-objects] verify：通过 ${verified}，失败 ${failed}`);

  if (failed > 0) {
    console.error('[tree-objects] 有校验失败，未删任何旧列；请排查（备份已在）。');
    db.close();
    process.exitCode = 1;
    return;
  }

  if (DROP) {
    if (!hasSnapshotCol && !cols.has('diff')) {
      console.log('[tree-objects] snapshot/diff 列已不存在，无需删。');
    } else {
      console.log('[tree-objects] verify 全过 → 删 snapshot/diff 列。');
      db.exec('ALTER TABLE commits DROP COLUMN snapshot');
      db.exec('ALTER TABLE commits DROP COLUMN diff');
      db.exec('VACUUM');
      console.log('[tree-objects] 旧列已删 + VACUUM。');
    }
  } else {
    console.log('[tree-objects] 未传 --drop：保留 snapshot/diff 列（确认无虞后再加 --drop 删列回收空间）。');
  }
  db.close();
}

main().catch((error) => {
  console.error('[tree-objects] 失败：', error);
  process.exitCode = 1;
});
