#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDatabaseService, databaseReadActions } from '../src/backend/database-service.mjs';

const ACTION_ALIASES = Object.freeze({
  sql: 'debug.sql',
  overview: 'debug.overview',
  docs: 'content.listDocs',
  library_index: 'library.index',
  'library-index': 'library.index',
  library_navigation: 'library.getNavigation',
  'library-navigation': 'library.getNavigation',
  index: 'content.getIndex',
  node_content: 'content.getNode',
  'node-content': 'content.getNode',
  subtree: 'content.getSubtree',
  depth: 'content.getDepth',
  article: 'content.getArticle',
  search: 'content.search',
  search_all: 'content.searchAll',
  'search-all': 'content.searchAll'
});
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function defaultDbPath() {
  return process.env.IFTREE_DB || join(PROJECT_ROOT, 'database', 'store.sqlite');
}

function defaultLibraryRoot() {
  return process.env.IFTREE_LIBRARY_ROOT || join(PROJECT_ROOT, 'library');
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
  if (argv.length === 0) return { action: 'debug.overview' };
  if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    return { help: true };
  }
  if (argv[0] === 'actions') return { action: 'query.actions' };
  if (argv[0]?.startsWith('{')) return JSON.parse(argv.join(' '));

  const payload = { action: ACTION_ALIASES[argv[0]] || argv[0] || 'debug.overview' };
  for (let index = 1; index < argv.length; index += 1) {
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
    '  .\\node_modules\\.bin\\electron.cmd scripts/query-db.mjs docs',
    '  .\\node_modules\\.bin\\electron.cmd scripts/query-db.mjs library-index',
    '  .\\node_modules\\.bin\\electron.cmd scripts/query-db.mjs library-navigation',
    '  .\\node_modules\\.bin\\electron.cmd scripts/query-db.mjs index --docId 22 --depth 3',
    '  .\\node_modules\\.bin\\electron.cmd scripts/query-db.mjs depth --docId 22 --from 1 --to 3 --detail full',
    '  .\\node_modules\\.bin\\electron.cmd scripts/query-db.mjs node-content --docId 22 --address 1-4-6 --include tags,source',
    '  .\\node_modules\\.bin\\electron.cmd scripts/query-db.mjs subtree --docId 22 --address 1-4-6 --levels 3',
    '  .\\node_modules\\.bin\\electron.cmd scripts/query-db.mjs search --docId 22 --query "keyword"',
    '  .\\node_modules\\.bin\\electron.cmd scripts/query-db.mjs search-all --query "keyword" --format ascii_tree',
    '  .\\node_modules\\.bin\\electron.cmd scripts/query-db.mjs article --docId 22 --startOffset 0 --limit 8000',
    '  .\\node_modules\\.bin\\electron.cmd scripts/query-db.mjs debug.overview',
    '  .\\node_modules\\.bin\\electron.cmd scripts/query-db.mjs debug.sql --sql "SELECT depth, COUNT(*) AS count FROM nodes WHERE doc_id = 23 GROUP BY depth"',
    '  .\\node_modules\\.bin\\electron.cmd scripts/query-db.mjs doc.list',
    '  .\\node_modules\\.bin\\electron.cmd scripts/query-db.mjs doc.getInfo --docId 18',
    '  .\\node_modules\\.bin\\electron.cmd scripts/query-db.mjs node.get --docId 18 --address 1-2',
    '  .\\node_modules\\.bin\\electron.cmd scripts/query-db.mjs node.listChildren --docId 18 --parentId 123 --limit 50',
    '',
    `Actions: ${databaseReadActions().join(', ')}`,
    '',
    'Environment:',
    '  IFTREE_DB    Query a specific SQLite database path.'
  ].join('\n'));
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
  const payload = parseArgs(process.argv.slice(2));
  if (payload.sqlFile) {
    const sqlFilePath = resolve(String(payload.sqlFile));
    if (!existsSync(sqlFilePath)) throw new Error(`SQL file not found: ${sqlFilePath}`);
    payload.sql = readFileSync(sqlFilePath, 'utf8');
    delete payload.sqlFile;
  }
  if (payload.help) {
    printHelp();
    await exitProcess(0);
    return;
  }
  if (payload.action === 'query.actions') {
    const database = createDatabaseService({
      dbPath: defaultDbPath(),
      libraryRoot: defaultLibraryRoot(),
      initOptions: { readonly: true, migrate: false }
    });
    console.log(JSON.stringify(await database.run({ operation: 'read', payload }, 'read'), null, 2));
    await exitProcess(0);
    return;
  }

  const dbPath = resolve(defaultDbPath());
  const action = payload.action || payload.type;
  if (action !== 'library.getTree' && !existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }

  const database = createDatabaseService({
    dbPath,
    libraryRoot: defaultLibraryRoot(),
    initOptions: { readonly: true, migrate: false }
  });
  try {
    const result = await database.run({ operation: 'read', payload }, 'read');
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
