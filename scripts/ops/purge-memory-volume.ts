#!/usr/bin/env node
// 运维：强制清除一个记忆卷（管理员级，绕过「有锚永不删」保护，专清非法/测试残留卷）。
// 步骤：1) 解锚——删 source_documents 行，使 deleteDoc 守卫放行；
//      2) 正规删除（nodes/refs/keyword 索引/向量等）走 db delete；
//      3) 删 .memory 锚文件。
// 用法（需 electron 跑以匹配 better-sqlite3 ABI）：
//   $env:ELECTRON_RUN_AS_NODE='1'
//   .\node_modules\.bin\electron.cmd scripts/ops/purge-memory-volume.mjs <docId>
import Database from 'better-sqlite3';
import { existsSync, lstatSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHeadlessAgentClient } from '../../src/backend/llm/headless-agent-client.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DB_PATH = process.env.IFTREE_DB || join(ROOT, 'database', 'store.sqlite');
const docId = String(process.argv[2] || '').trim();

interface MemoryVolumeMetaRow {
  agent?: unknown;
}

interface SourceDocumentRow {
  original_path?: string | null;
}

async function main() {
  if (!docId) {
    console.error('usage: purge-memory-volume <docId>');
    process.exitCode = 1;
    return;
  }

  // 1) 解锚：取锚路径并删 source_documents 行（独占 better-sqlite3，调用前请确保后端未占用 DB）。
  const db = new Database(DB_PATH);
  const meta = db.prepare("SELECT json_extract(meta,'$.memoryVolume.agent') AS agent FROM docs WHERE id=?").get(docId) as MemoryVolumeMetaRow | undefined;
  if (!meta) {
    db.close();
    console.error(`doc 不存在：${docId}`);
    process.exitCode = 1;
    return;
  }
  const srcRow = db.prepare('SELECT original_path FROM source_documents WHERE doc_id=?').get(docId) as SourceDocumentRow | undefined;
  const anchorPath = srcRow?.original_path || null;
  db.prepare('DELETE FROM source_documents WHERE doc_id=?').run(docId);
  db.close();
  console.log(`[1] 解锚 ${docId}（agent=${meta.agent}）；原锚 = ${anchorPath || '(无)'}`);

  // 2) 正规删除（此时无锚，deleteDoc 守卫放行；连带清 nodes/refs/派生索引）。
  const client = createHeadlessAgentClient({
    cwd: ROOT,
    scriptPath: join(ROOT, 'dist', 'scripts', 'agent-host.js'),
    onStderr: (text) => process.stderr.write(text)
  });
  try {
    const res = await client.request('db.shell', { argv: ['delete', docId] }) as { text?: unknown };
    console.log(`[2] db delete →\n${res.text || ''}`);
  } finally {
    await client.shutdown();
    client.close();
  }

  // 3) 删 .memory 锚文件（symlink 或占位文件，悬空也删）。
  if (anchorPath) {
    try {
      let exists = existsSync(anchorPath);
      if (!exists) { try { exists = Boolean(lstatSync(anchorPath)); } catch { exists = false; } }
      if (exists) {
        rmSync(anchorPath, { force: true });
        console.log(`[3] 已删锚文件 ${anchorPath}`);
      } else {
        console.log('[3] 锚文件不存在，跳过');
      }
    } catch (error: unknown) {
      console.error(`[3] 删锚文件失败：${(error as { message?: string } | null | undefined)?.message || error}`);
    }
  }
  console.log('完成。');
}

main().finally(() => {
  if (process.env.ELECTRON_RUN_AS_NODE === '1') process.exit(process.exitCode || 0);
});
