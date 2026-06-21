#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { IftreeStore } from '../src/backend/store/index.mjs';
import { readChmSourceDocument } from '../src/core/source-chm.mjs';
import { normalizeImportBaseName } from '../src/core/source-markdown.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const result = {
    file: null,
    home: process.env.IFTREE_HOME || join(PROJECT_ROOT, 'database'),
    reset: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--file') {
      result.file = argv[index + 1];
      index += 1;
    } else if (arg === '--home') {
      result.home = argv[index + 1];
      index += 1;
    } else if (arg === '--reset') {
      result.reset = true;
    }
  }
  return result;
}

function printHelp() {
  console.log([
    'Usage:',
    '  electron scripts/import-chm-doc.mjs --file <path-to-source.chm> [--home <dir>] [--reset]',
    '',
    'Options:',
    '  --file <path>  CHM source file to import. Required.',
    '  --home <dir>   IFTree home directory. Default: IFTREE_HOME or ./database.',
    '  --reset        Remove --home first; allowed only for temp or project tmp paths.'
  ].join('\n'));
}

function importRecordSentenceIndexes(record, fallbackIndex, hasExplicitIndex) {
  if (Array.isArray(record?.indexes)) {
    return record.indexes
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
  }
  if (record?.index != null) {
    const index = Number(record.index);
    return Number.isFinite(index) && index > 0 ? [index] : [];
  }
  return hasExplicitIndex ? [] : [fallbackIndex];
}

function print(event) {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
}

async function exitProcess(code) {
  if (process.versions.electron) {
    const { app } = await import('electron');
    app.exit(code);
    return;
  }
  process.exit(code);
}

function assertResetPath(home) {
  const target = resolve(home);
  const tempRoot = resolve(tmpdir());
  const workspaceTmp = resolve(PROJECT_ROOT, 'tmp');
  if (!target.startsWith(tempRoot) && !target.startsWith(workspaceTmp)) {
    throw new Error(`Refusing to reset non-temp IFTREE_HOME: ${target}`);
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  await exitProcess(0);
}
if (!args.file) {
  printHelp();
  throw new Error('--file is required');
}
const filePath = resolve(args.file);
const home = resolve(args.home);
const dbPath = join(home, 'store.sqlite');
let stage = 'start';
const startedAt = Date.now();
const heartbeat = setInterval(() => {
  print({ type: 'import-heartbeat', stage, elapsedMs: Date.now() - startedAt });
}, 2000);

try {
  if (!existsSync(filePath)) throw new Error(`CHM not found: ${filePath}`);
  if (args.reset) {
    stage = 'reset-home';
    assertResetPath(home);
    rmSync(home, { recursive: true, force: true });
  }
  mkdirSync(home, { recursive: true });

  stage = 'read-chm';
  print({ type: 'import-stage', stage, filePath, home });
  const sourceDocument = await readChmSourceDocument(filePath, { granularity: 'sentence' });

  stage = 'build-records';
  print({
    type: 'import-stage',
    stage,
    rawLength: sourceDocument.rawText.length,
    spanCount: sourceDocument.spans.length
  });
  const records = sourceDocument.records;
  if (records.length === 0) throw new Error('CHM import produced 0 records');

  stage = 'write-sqlite';
  print({ type: 'import-stage', stage, records: records.length });
  const store = new IftreeStore(dbPath);
  store.init();
  try {
    const title = normalizeImportBaseName(filePath);
    const doc = store.createDocFromStructuredRecords({ title, sourcePath: filePath, records });

    stage = 'write-source-spans';
    print({ type: 'import-stage', stage, docId: doc.id, spanCount: sourceDocument.spans.length });
    const nodeIdsBySentenceIndex = new Map();
    const hasExplicitIndex = records.some((record) => record.index != null || Array.isArray(record.indexes));
    for (const [index, record] of records.entries()) {
      for (const sentenceIndex of importRecordSentenceIndexes(record, index + 1, hasExplicitIndex)) {
        const nodeId = doc.importedNodeIdsByRecordIndex?.[sentenceIndex] || doc.importedNodeIds[index];
        if (nodeId) nodeIdsBySentenceIndex.set(sentenceIndex, nodeId);
      }
    }
    store.saveSourceDocument({
      docId: doc.id,
      sourcePath: sourceDocument.sourcePath,
      sourceType: sourceDocument.sourceType,
      rawMarkdown: sourceDocument.rawText,
      spans: sourceDocument.spans,
      pdfPages: sourceDocument.pdfPages || [],
      pdfChars: sourceDocument.pdfChars || [],
      nodeIdsBySentenceIndex
    });

    const info = store.db.prepare('SELECT COUNT(*) AS node_count FROM nodes WHERE doc_id = ?').get(doc.id);
    print({
      type: 'import-result',
      ok: true,
      docId: doc.id,
      title,
      dbPath,
      home,
      sourcePath: filePath,
      structureSource: sourceDocument.structureSource,
      intermediateFormat: sourceDocument.intermediateFormat,
      records: records.length,
      nodeCount: Number(info?.node_count || 0),
      spanCount: sourceDocument.spans.length,
      rawLength: sourceDocument.rawText.length,
      elapsedMs: Date.now() - startedAt
    });
  } finally {
    store.close();
  }
  clearInterval(heartbeat);
  await exitProcess(0);
} catch (error) {
  clearInterval(heartbeat);
  print({
    type: 'import-result',
    ok: false,
    stage,
    elapsedMs: Date.now() - startedAt,
    error: error?.stack || error?.message || String(error)
  });
  await exitProcess(1);
}
