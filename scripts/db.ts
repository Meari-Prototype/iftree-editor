#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dbShellHelp } from '../src/backend/db-shell.js';
import { createHeadlessAgentClient } from '../src/backend/llm/headless-agent-client.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function defaultDbPath() {
  return process.env.IFTREE_DB || join(PROJECT_ROOT, 'database', 'store.sqlite');
}

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

  const dbPath = resolve(defaultDbPath());
  if (!existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);
  const client = createHeadlessAgentClient({
    cwd: PROJECT_ROOT,
    scriptPath: join(PROJECT_ROOT, 'dist', 'scripts', 'agent-host.js'),
    onStderr: (text) => process.stderr.write(text)
  });
  try {
    const result = await client.request('db.shell', {
      argv,
      currentDocId: process.env.IFTREE_CURRENT_DOC_ID
    }) as { text?: unknown };
    console.log(result.text || '');
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
