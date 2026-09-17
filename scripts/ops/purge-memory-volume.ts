#!/usr/bin/env node
// 运维：强制清除一个记忆卷（管理员级，绕过「有锚永不删」保护，专清非法/测试残留卷）。
// 步骤：1) 解锚——删 source_documents 行，使 deleteDoc 守卫放行；
//      2) 正规删除（nodes/refs/keyword 索引/向量等）走 db delete；
//      3) 删 .memory 锚文件。
// 用法（跑真 node：本进程静态 import better-sqlite3，而它只编 node ABI）：
//   node dist/scripts/ops/purge-memory-volume.js <docId>
// 前提：跑之前该库的共享后端必须不在跑（第 1 步要独占库，见下方闸门），脚本会自己检查并拒绝。
import Database from 'better-sqlite3';
import { existsSync, lstatSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBackendClient } from '../../src/backend/llm/backend-client.js';
import { backendDescriptorPath, readBackendDescriptor, resolveBackendDbPath } from '../../src/backend/llm/backend-discovery.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// 与共享后端派生管道名用同一个解析（IFTREE_DB 优先）：解锚动的库和第 2 步连的后端持有的库必须是同一个。
const DB_PATH = resolveBackendDbPath(ROOT);
const docId = String(process.argv[2] || '').trim();

// 探活该库的共享后端（pid 记在库同目录的连接描述文件里）。process.kill(pid, 0) 不发信号、
// 只探进程在不在：ESRCH=不存在；EPERM=存在但无权限（仍算活）。
function liveSharedBackendPid(): number | null {
  const recorded = Number(readBackendDescriptor(backendDescriptorPath(DB_PATH))?.pid);
  if (!Number.isInteger(recorded) || recorded <= 0) return null;
  try {
    process.kill(recorded, 0);
    return recorded;
  } catch (error) {
    return (error as { code?: string } | null)?.code === 'EPERM' ? recorded : null;
  }
}

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

  // 1) 解锚：取锚路径并删 source_documents 行。
  // 「解锚」没有对应的后端动词——db delete 的「有锚永不删」守卫读的就是 source_documents 行，
  // 要绕过它只能由本进程直连 sqlite 删行。直连写绕开共享后端的单写队列，破「一库一后端·单写者」
  // （ARCHITECTURE §1），所以这里先探活、在共享后端在线时拒绝动手：这条前提原本只是注释里的
  // 口头约定，第 2 步改走 shared 之后后端几乎总在跑，不立成闸门就是必然违约。
  const livePid = liveSharedBackendPid();
  if (livePid) {
    console.error(`共享后端在跑（pid=${livePid}，库=${DB_PATH}）：本脚本第 1 步要独占该库直连解锚，不能与它并写。`);
    console.error('先关停共享后端（MCP 的 restart_backend，或按 database/backend-connection.json 的 pid 结束进程），再重跑本脚本。');
    process.exitCode = 1;
    return;
  }
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
  // 走共享后端（18-6-1 / ARCHITECTURE §1）：删档要连带清对象库/关键词/向量等派生索引，
  // 该由持库的那个 host 做。上面的闸门保证了走到这里时该库没有后端在跑，于是这一步会拉起一个
  // ——拉起用的 projectRoot/env 与上面解锚用的是同一个 DB_PATH 解析，指的就是刚解锚的那个库。
  const client = createBackendClient({
    projectRoot: ROOT,
    hostScriptPath: join(ROOT, 'dist', 'scripts', 'agent-host.js'),
    mode: 'shared',
    onStderr: (text: unknown) => { process.stderr.write(String(text ?? '')); },
    onStatus: (text: unknown) => { process.stderr.write(String(text ?? '')); }
  });
  try {
    const res = await client.dbShell(['delete', docId]) as { text?: unknown };
    console.log(`[2] db delete →\n${res.text || ''}`);
  } finally {
    // 只断本连接：拉起来的共享后端留给后面的 GUI/MCP 复用（它是 detached 的，本就不系于本进程）。
    // mode !== 'pipe' 才 shutdown——那是连不上也拉不起时回退出来的私有兜底 host，得由本进程收尸。
    if (client.mode !== 'pipe') await client.shutdown();
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
