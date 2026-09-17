#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dbShellHelp } from '../src/backend/db-shell.js';
import { createBackendClient } from '../src/backend/llm/backend-client.js';
import { resolveBackendDbPath } from '../src/backend/llm/backend-discovery.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function exitProcess(code: number) {
  if (process.env.ELECTRON_RUN_AS_NODE === '1') {
    process.exit(code);
    return;
  }
  if (process.versions.electron) {
    const { app } = await import('electron');
    if (app?.exit) {
      app.exit(code);
      return;
    }
  }
  process.exit(code);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || ['help', '--help', '-h'].includes(argv[0])) {
    console.log(dbShellHelp());
    await exitProcess(0);
    return;
  }

  // 目标库经 resolveBackendDbPath 解析（IFTREE_DB 优先）：共享后端的管道名由库的绝对路径派生，
  // 用同一个函数才能保证「这里校验存在的库」就是「连上的后端持有的库」——否则 CLI 校验 A 库、
  // 却连到按 B 库派生的管道上。
  const dbPath = resolveBackendDbPath(PROJECT_ROOT);
  if (!existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);
  // 走共享后端（18-6-1 / ARCHITECTURE §1「一库一后端·单写者」），与 mcp-server 同口径：
  // 曾经每条 db 命令都冷启一个私有 stdio host，而私有 host 不是只读 host——IftreeStore.init()
  // 自己就要 exec(TABLES_SQL)/ALTER TABLE/迁移，于是 GUI 或 MCP 在线时随手跑一条 db，
  // 就是第二条可写连接在同一主库上并发跑迁移。复用之外还顺带省掉每条命令的 host 冷启开销。
  const client = createBackendClient({
    projectRoot: PROJECT_ROOT,
    hostScriptPath: join(PROJECT_ROOT, 'dist', 'scripts', 'agent-host.js'),
    mode: 'shared',
    onStderr: (text: unknown) => { process.stderr.write(String(text ?? '')); },
    onStatus: (text: unknown) => { process.stderr.write(String(text ?? '')); }
  });
  try {
    const result = await client.dbShell(argv, {
      currentDocId: process.env.IFTREE_CURRENT_DOC_ID
    }) as { text?: unknown };
    console.log(result.text || '');
  } finally {
    // 共享后端是多客户端复用的：一条 CLI 命令跑完只断本连接，不能把 GUI/MCP 也在用的 host 关掉。
    // mode !== 'pipe' 才 shutdown——那是拉不起共享后端时回退出来的私有兜底 host，由本进程独占、得收尸。
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
