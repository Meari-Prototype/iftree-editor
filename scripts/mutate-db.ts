#!/usr/bin/env node
// @ts-nocheck
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDatabaseService, databaseWriteActions } from '../src/backend/database-service.js';
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function defaultDbPath() {
  return process.env.IFTREE_DB || join(PROJECT_ROOT, 'database', 'store.sqlite');
}

function parseValue(value) {
  const raw = String(value ?? '');
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
    return JSON.parse(raw);
  }
  return raw;
}

function parseArgs(argv) {
  if (argv.length === 0) return { help: true };
  if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') return { help: true };
  if (argv[0] === 'actions') return { action: 'mutation.actions' };
  if (argv[0]?.startsWith('{')) return JSON.parse(argv.join(' '));

  const payload = {};
  let index = 0;
  if (!argv[0]?.startsWith('--')) {
    payload.action = argv[0];
    index = 1;
  }

  for (; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      payload[name] = true;
      continue;
    }
    payload[name] = parseValue(next);
    index += 1;
  }
  return payload;
}

function printHelp() {
  console.log([
    'Usage:',
    '  .\\node_modules\\.bin\\electron.cmd scripts/mutate-db.mjs mutation.actions',
    '  .\\node_modules\\.bin\\electron.cmd scripts/mutate-db.mjs --action doc.create --title "New doc"',
    '  .\\node_modules\\.bin\\electron.cmd scripts/mutate-db.mjs node.update --docId 18 --nodeId 42 --patch {"text":"updated"}',
    '',
    `Actions: ${databaseWriteActions().join(', ')}`,
    '',
    'Environment:',
    '  IFTREE_DB    Mutate a specific SQLite database path.'
  ].join('\n'));
}

async function exitProcess(code) {
  if (process.versions.electron) {
    const { app } = await import('electron');
    app.exit(code);
    return;
  }
  process.exit(code);
}

async function main() {
  const payload = parseArgs(process.argv.slice(2));
  if (payload.help) {
    printHelp();
    await exitProcess(0);
    return;
  }
  if (payload.action === 'mutation.actions') {
    const database = createDatabaseService({ dbPath: defaultDbPath() });
    console.log(JSON.stringify(await database.run({ operation: 'write', payload }, 'write'), null, 2));
    await exitProcess(0);
    return;
  }

  const dbPath = resolve(defaultDbPath());
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }

  const database = createDatabaseService({ dbPath });
  try {
    const result = await database.run({ operation: 'write', payload }, 'write');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    database.close();
  }
}

main()
  .then(() => exitProcess(0))
  .catch(async (error) => {
    console.error(error?.stack || error?.message || String(error));
    await exitProcess(1);
  });
