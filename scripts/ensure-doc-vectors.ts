#!/usr/bin/env node
// 给单篇文档补建语义向量（npm run vectors:ensure <docId>）。
// 用法：node dist/scripts/ensure-doc-vectors.js <docId>（目标库 = IFTREE_DB 或 database/store.sqlite）。
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBackendClient } from '../src/backend/llm/backend-client.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface VectorProgressEvent {
  type?: unknown;
  stage?: unknown;
  docId?: unknown;
  nodeCount?: unknown;
  vectorCountBefore?: unknown;
  staleCount?: unknown;
  changedCount?: unknown;
  staleDeleted?: unknown;
  changedDeleted?: unknown;
  missingCount?: unknown;
  batchSize?: unknown;
  missingInserted?: unknown;
  scanned?: unknown;
  vectorCountAfter?: unknown;
}

function docIdFromArg() {
  const value = String(process.argv[2] || '').trim();
  if (!value) {
    throw new Error('Usage: node dist/scripts/ensure-doc-vectors.js <docId>');
  }
  return value;
}

function progressLine(event: VectorProgressEvent = {}) {
  if (event.type !== 'vector.ensureDoc.progress') return '';
  if (event.stage === 'scan') {
    return `[vector] scan doc=${event.docId} nodes=${event.nodeCount} vectorsBefore=${event.vectorCountBefore} stale=${event.staleCount} changed=${event.changedCount}`;
  }
  if (event.stage === 'cleanup') {
    return `[vector] cleanup staleDeleted=${event.staleDeleted} changedDeleted=${event.changedDeleted}`;
  }
  if (event.stage === 'missing') return `[vector] missing=${event.missingCount} batchSize=${event.batchSize}`;
  if (event.stage === 'batch_done') return `[vector] embedded ${event.missingInserted} (scanned ${event.scanned})`;
  if (event.stage === 'done') return `[vector] done vectorsAfter=${event.vectorCountAfter} inserted=${event.missingInserted}`;
  return '';
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
  const docId = docIdFromArg();
  // 走共享后端（18-6-1 / ARCHITECTURE §1）：向量补建要写 LanceDB 并读主库的节点内容，
  // 该由持库的那个 host 做。私有 host 不是只读 host（IftreeStore.init 要跑迁移），
  // 共享后端在跑时另起一个就是两条可写连接压同一主库。
  const client = createBackendClient({
    projectRoot: PROJECT_ROOT,
    hostScriptPath: join(PROJECT_ROOT, 'dist', 'scripts', 'agent-host.js'),
    mode: 'shared',
    onStderr: (text: unknown) => { process.stderr.write(String(text ?? '')); },
    onStatus: (text: unknown) => { process.stderr.write(String(text ?? '')); }
  });
  try {
    const result = await client.ensureDocVectors({ docId }, {
      onEvent: (event: unknown) => {
        const line = progressLine(event as VectorProgressEvent);
        if (line) console.log(line);
      }
    });
    console.log(JSON.stringify(result, null, 2));
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
