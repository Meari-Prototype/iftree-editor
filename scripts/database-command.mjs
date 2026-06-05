#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDatabaseService } from '../src/backend/database-service.mjs';
import { normalizeDatabaseCommand } from '../src/backend/database-command.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function defaultDbPath() {
  return process.env.IFTREE_DB || join(PROJECT_ROOT, 'database', 'store.sqlite');
}

function defaultLibraryRoot() {
  return process.env.IFTREE_LIBRARY_ROOT || join(PROJECT_ROOT, 'library');
}

function printHelp() {
  console.log([
    'Usage:',
    '  .\\node_modules\\.bin\\electron.cmd scripts/database-command.mjs {"operation":"read","payload":{"action":"doc.list"}}',
    '  .\\node_modules\\.bin\\electron.cmd scripts/database-command.mjs read {"action":"doc.list"}',
    '  .\\node_modules\\.bin\\electron.cmd scripts/database-command.mjs tree --docId 28 --depth 2',
    '  .\\node_modules\\.bin\\electron.cmd scripts/database-command.mjs tree --docId 28 --address 1 --levels 3',
    '  .\\node_modules\\.bin\\electron.cmd scripts/database-command.mjs library --depth 2',
    '  .\\node_modules\\.bin\\electron.cmd scripts/database-command.mjs library-index',
    '  .\\node_modules\\.bin\\electron.cmd scripts/database-command.mjs library-navigation',
    '  .\\node_modules\\.bin\\electron.cmd scripts/database-command.mjs library --q filename',
    '  .\\node_modules\\.bin\\electron.cmd scripts/database-command.mjs search --q keyword',
    '  echo {"operation":"read","payload":{"action":"query.actions"}} | .\\node_modules\\.bin\\electron.cmd scripts/database-command.mjs --stdin',
    '',
    'Command shape:',
    '  {"operation":"read"|"write","payload":{"action":"..."}}',
    '',
    'Environment:',
    '  IFTREE_DB    Use a specific SQLite database path.'
  ].join('\n'));
}

function parseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('JSON command is required');
  return JSON.parse(raw);
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

function parseFlags(argv) {
  const payload = {};
  for (let index = 0; index < argv.length; index += 1) {
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

function defaultActionForOperation(operation) {
  return operation === 'write' ? 'mutation.actions' : 'query.actions';
}

function normalizeActionShortcut(operation, action) {
  return action === 'actions' || !action ? defaultActionForOperation(operation) : action;
}

function parseCommand(argv) {
  const first = argv[0] || '';
  if (!first || first === 'help' || first === '--help' || first === '-h') return { help: true };
  if (first === '--stdin') return parseJson(readFileSync(0, 'utf8'));
  if (first === 'tree') {
    const payload = parseFlags(argv.slice(1));
    return {
      operation: 'read',
      payload: {
        ...payload,
        action: payload.address ? 'content.getSubtree' : 'content.getIndex',
        format: 'ascii_tree',
        detail: 'summary'
      }
    };
  }
  if (first === 'library') {
    const payload = parseFlags(argv.slice(1));
    return {
      operation: 'read',
      payload: {
        ...payload,
        action: 'library.getTree',
        format: 'ascii_tree'
      }
    };
  }
  if (first === 'library-index' || first === 'library_index') {
    const payload = parseFlags(argv.slice(1));
    return {
      operation: 'read',
      payload: {
        ...payload,
        action: 'library.index',
        format: 'ascii_tree'
      }
    };
  }
  if (first === 'library-navigation' || first === 'library_navigation') {
    const payload = parseFlags(argv.slice(1));
    return {
      operation: 'read',
      payload: {
        ...payload,
        action: 'library.getNavigation'
      }
    };
  }
  if (first === 'docs') {
    const payload = parseFlags(argv.slice(1));
    return {
      operation: 'read',
      payload: {
        ...payload,
        action: 'content.listDocs',
        format: 'ascii_tree'
      }
    };
  }
  if (first === 'search' || first === 'search-all' || first === 'search_all') {
    const payload = parseFlags(argv.slice(1));
    return {
      operation: 'read',
      payload: {
        ...payload,
        action: 'content.searchAll',
        format: 'ascii_tree',
        detail: 'summary'
      }
    };
  }
  if (first === 'read' || first === 'write') {
    const payloadText = argv.slice(1).join(' ').trim();
    return {
      operation: first,
      payload: payloadText.startsWith('{')
        ? parseJson(payloadText)
        : { action: normalizeActionShortcut(first, payloadText) }
    };
  }
  return parseJson(argv.join(' '));
}

async function exitProcess(code) {
  if (process.versions.electron) {
    try {
      const { app } = await import('electron');
      if (app?.exit) {
        app.exit(code);
        return;
      }
    } catch {
      // Electron-as-Node can expose process.versions.electron without app.
    }
  }
  process.exit(code);
}

async function main() {
  const command = parseCommand(process.argv.slice(2));
  if (command.help) {
    printHelp();
    await exitProcess(0);
    return;
  }

  const normalized = normalizeDatabaseCommand(command, 'read');
  const action = normalized.payload?.action || normalized.payload?.type;
  const dbPath = resolve(defaultDbPath());
  if (action !== 'query.actions' && action !== 'mutation.actions' && action !== 'library.getTree' && !existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }

  const database = createDatabaseService({
    dbPath,
    libraryRoot: defaultLibraryRoot(),
    initOptions: normalized.operation === 'read' ? { readonly: true, migrate: false } : {}
  });
  try {
    const result = await database.run(normalized);
    if (result?.format === 'ascii_tree' && typeof result.text === 'string') console.log(result.text);
    else console.log(JSON.stringify(result, null, 2));
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
