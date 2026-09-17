#!/usr/bin/env node
// 批量为「记忆卷」补建语义向量：一条共享后端连接上遍历所有带 memoryVolume meta 的文档
// 逐个 vector.ensureDoc。知识文档/压测语料不在范围内。
// 用法：配好 IFTREE_EMBED_* 后 `node dist/scripts/ensure-memory-vectors.js`。
import Database from 'better-sqlite3';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBackendClient } from '../src/backend/llm/backend-client.js';
import { resolveBackendDbPath } from '../src/backend/llm/backend-discovery.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// 与共享后端派生管道名用同一个解析（IFTREE_DB 优先）：保证这里列卷的库就是后端持有的库。
const dbPath = resolveBackendDbPath(PROJECT_ROOT);

interface MemoryDocRow {
  id: string;
  title?: unknown;
}

interface EnsureDocResult {
  missingInserted?: unknown;
  vectorCountAfter?: unknown;
}

// 清单查询走 better-sqlite3 只读连接：readonly 连接不 init/不迁移/不写，和共享后端的
// WAL 快照读并存是安全的，不算第二个写者（补建本身仍全程经共享后端，见 main）。
function listMemoryDocs(): MemoryDocRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        "SELECT id, title FROM docs WHERE json_extract(meta,'$.memoryVolume') IS NOT NULL ORDER BY created_at"
      )
      .all() as unknown as MemoryDocRow[];
  } finally {
    db.close();
  }
}

async function exitProcess(code: number) {
  if (process.versions.electron) {
    try {
      const { app } = await import('electron');
      app?.exit?.(code);
      return;
    } catch {
      // Fall through to process.exit for Electron-as-Node.
    }
  }
  process.exit(code);
}

async function main() {
  const docs = listMemoryDocs();
  console.log(`[ensure-memory-vectors] ${docs.length} 记忆卷待补；db=${dbPath}`);
  // 走共享后端（18-6-1 / ARCHITECTURE §1）：整轮补建复用同一条连接（原先「一个 host 内跑完」
  // 的省冷启初衷不变），但持库的是那个唯一的共享 host，不再自起私有 host 当第二个写者。
  const client = createBackendClient({
    projectRoot: PROJECT_ROOT,
    hostScriptPath: join(PROJECT_ROOT, 'dist', 'scripts', 'agent-host.js'),
    mode: 'shared',
    onStderr: (text: unknown) => { process.stderr.write(String(text ?? '')); },
    onStatus: (text: unknown) => { process.stderr.write(String(text ?? '')); }
  });
  let done = 0;
  let inserted = 0;
  let failed = 0;
  try {
    for (const doc of docs) {
      try {
        const result = await client.ensureDocVectors({ docId: doc.id }) as EnsureDocResult;
        const add = Number(result?.missingInserted) || 0;
        inserted += add;
        done += 1;
        const title = String(doc.title || '').slice(0, 36);
        console.log(
          `[${done}/${docs.length}] +${add} (after=${result?.vectorCountAfter}) ${doc.id} ${title}`
        );
      } catch (err: unknown) {
        failed += 1;
        console.error(`[x] ${doc.id}: ${(err as { message?: string } | null | undefined)?.message || err}`);
      }
    }
    console.log(
      `[ensure-memory-vectors] 完成 processed=${done} failed=${failed} totalInserted=${inserted}`
    );
  } finally {
    // 只断本连接：共享后端多客户端复用；私有兜底 host（mode !== 'pipe'）才由本进程收尸。
    if (client.mode !== 'pipe') await client.shutdown();
    client.close();
  }
}

main()
  .then(() => exitProcess(0))
  .catch(async (error: unknown) => {
    console.error((error as { stack?: string } | null | undefined)?.stack || (error as { message?: string } | null | undefined)?.message || String(error));
    await exitProcess(1);
  });
