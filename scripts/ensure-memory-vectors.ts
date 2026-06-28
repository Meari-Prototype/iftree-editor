#!/usr/bin/env node
// 批量为「记忆卷」补建语义向量：一个 headless host 内遍历所有带 memoryVolume meta 的
// 文档逐个 vector.ensureDoc，避免逐 doc 冷启 host 的开销。知识文档/压测语料不在范围内。
// 用法：配好 IFTREE_EMBED_* 后 `electron scripts/ensure-memory-vectors.mjs`。
import Database from 'better-sqlite3';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHeadlessAgentClient } from '../src/backend/llm/headless-agent-client.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dbPath = process.env.IFTREE_DB || join(PROJECT_ROOT, 'database', 'store.sqlite');

interface MemoryDocRow {
  id: string;
  title?: unknown;
}

interface EnsureDocResult {
  missingInserted?: unknown;
  vectorCountAfter?: unknown;
}

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
  const client = createHeadlessAgentClient({
    cwd: PROJECT_ROOT,
    scriptPath: join(PROJECT_ROOT, 'dist', 'scripts', 'agent-host.js'),
    onStderr: (text) => process.stderr.write(text)
  });
  let done = 0;
  let inserted = 0;
  let failed = 0;
  try {
    for (const doc of docs) {
      try {
        const result = await client.request('vector.ensureDoc', { payload: { docId: doc.id } }) as EnsureDocResult;
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
    await client.shutdown();
    client.close();
  }
}

main()
  .then(() => exitProcess(0))
  .catch(async (error: unknown) => {
    console.error((error as { stack?: string } | null | undefined)?.stack || (error as { message?: string } | null | undefined)?.message || String(error));
    await exitProcess(1);
  });
