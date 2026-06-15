#!/usr/bin/env node
// 迁移 .memory 物理锚（projectneed 15-10）：
//  (A) 事件卷：把 .memory/ 下的 .md 全文实体换成指向「宿主原始 jsonl」的 symlink，
//      并按 hostAnchor 里的工作区切子目录 .memory/<workspace>/。正文已在 DB，物理只留锚。
//  (B) 真记忆 CLAUDE CODE记忆库.md：从 .memory/ 移到 library/memory/（保留 .md 实体）。
// 权威是 DB 里的 hostAnchor，symlink 只是物理便利层；建链后立即回读核对，
// readlink≠hostAnchor 即报错记录、不静默跳过。
// 默认 dry-run 只打印计划；加 --apply 才动文件并改 source_documents.original_path。
import Database from 'better-sqlite3';
import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.IFTREE_DB || join(ROOT, 'database', 'store.sqlite');
const APPLY = process.argv.includes('--apply');

function parseHostAnchor(anchor) {
  const raw = String(anchor || '');
  const targetPath = raw.split('#')[0];
  const matched = targetPath.match(/[\\/]\.claude[\\/]projects[\\/]([^\\/]+)[\\/]/);
  return { targetPath, workspace: matched ? matched[1] : null };
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function main() {
  const db = new Database(DB_PATH);
  const volumes = db
    .prepare(
      `SELECT d.id,
              json_extract(d.meta,'$.memoryVolume.hostAnchor') AS hostAnchor,
              s.original_path AS originalPath
         FROM docs d JOIN source_documents s ON s.doc_id = d.id
        WHERE json_extract(d.meta,'$.memoryVolume') IS NOT NULL
          AND s.original_path IS NOT NULL
        ORDER BY s.original_path`
    )
    .all();
  const memoryDoc = db
    .prepare(
      `SELECT d.id, s.original_path AS originalPath
         FROM docs d JOIN source_documents s ON s.doc_id = d.id
        WHERE d.title = 'CLAUDE CODE记忆库' AND s.original_path IS NOT NULL`
    )
    .get();
  const updatePath = db.prepare('UPDATE source_documents SET original_path = ? WHERE doc_id = ?');

  const plan = [];
  const byWorkspace = {};
  let missingTarget = 0;
  let unparsed = 0;
  for (const vol of volumes) {
    const { targetPath, workspace } = parseHostAnchor(vol.hostAnchor);
    const ws = workspace || '_unparsed';
    if (!workspace) unparsed += 1;
    const targetExists = existsSync(targetPath);
    if (!targetExists) missingTarget += 1;
    byWorkspace[ws] = (byWorkspace[ws] || 0) + 1;
    plan.push({
      id: vol.id,
      from: vol.originalPath,
      link: join(dirname(vol.originalPath), ws, basename(vol.originalPath)),
      target: targetPath,
      workspace: ws,
      targetExists
    });
  }

  console.log(`[migrate] DB=${DB_PATH}`);
  console.log(`[migrate] 事件卷锚 ${volumes.length} 个；按工作区切分：`);
  for (const [ws, n] of Object.entries(byWorkspace).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${ws} : ${n}`);
  }
  console.log(`[migrate] 目标 jsonl 缺失（将建悬空 symlink + 标记）: ${missingTarget}；无法解析工作区: ${unparsed}`);
  let memTarget = null;
  if (memoryDoc) {
    memTarget = join(dirname(dirname(memoryDoc.originalPath)), 'memory', basename(memoryDoc.originalPath));
    console.log(`[migrate] 真记忆 CLAUDE CODE记忆库.md → ${memTarget}（保留实体、移出 .memory）`);
  }

  if (!APPLY) {
    console.log('\n--- DRY RUN（未动任何文件）：样本前 10 条 ---');
    for (const p of plan.slice(0, 10)) {
      console.log(`  .memory/${p.workspace}/${basename(p.from)}`);
      console.log(`      → ${p.target}${p.targetExists ? '' : '   [!目标不可达]'}`);
    }
    console.log('\n确认无误后加 --apply 执行。');
    db.close();
    return;
  }

  let done = 0;
  let failed = 0;
  let dangling = 0;
  for (const p of plan) {
    try {
      mkdirSync(dirname(p.link), { recursive: true });
      if (existsSync(p.link) || isSymlink(p.link)) rmSync(p.link, { force: true });
      symlinkSync(p.target, p.link, 'file');
      const back = readlinkSync(p.link);
      if (resolve(back) !== resolve(p.target)) {
        throw new Error(`锚错位：readlink=${back} != hostAnchor=${p.target}`);
      }
      if (!p.targetExists) dangling += 1;
      rmSync(p.from, { force: true });
      updatePath.run(p.link, p.id);
      done += 1;
    } catch (error) {
      failed += 1;
      console.error(`[x] ${p.id} ${basename(p.from)}: ${error.message}`);
    }
  }
  if (memoryDoc && memTarget) {
    try {
      mkdirSync(dirname(memTarget), { recursive: true });
      renameSync(memoryDoc.originalPath, memTarget);
      updatePath.run(memTarget, memoryDoc.id);
    } catch (error) {
      console.error(`[x] CLAUDE记忆库 move: ${error.message}`);
    }
  }
  console.log(`[migrate] 完成 done=${done} failed=${failed} dangling(悬空但已建链)=${dangling}`);
  db.close();
}

main();
