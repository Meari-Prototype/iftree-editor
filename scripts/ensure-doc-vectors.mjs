#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHeadlessAgentClient } from '../src/backend/llm/headless-agent-client.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function docIdFromArg() {
  const value = String(process.argv[2] || '').trim();
  if (!value) {
    throw new Error('Usage: electron scripts/ensure-doc-vectors.mjs <docId>');
  }
  return value;
}

function progressLine(event = {}) {
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

async function exitProcess(code) {
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
  const client = createHeadlessAgentClient({
    cwd: PROJECT_ROOT,
    scriptPath: join(PROJECT_ROOT, 'scripts', 'agent-host.mjs'),
    onStderr: (text) => process.stderr.write(text)
  });
  try {
    const result = await client.request('vector.ensureDoc', { payload: { docId } }, {
      onEvent: (event) => {
        const line = progressLine(event);
        if (line) console.log(line);
      }
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.shutdown();
    client.close();
  }
}

main()
  .then(() => exitProcess(0))
  .catch(async (error) => {
    console.error(error?.stack || error?.message || String(error));
    await exitProcess(1);
  });
