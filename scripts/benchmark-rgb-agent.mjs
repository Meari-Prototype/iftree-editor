#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHeadlessAgentClient } from '../src/backend/llm/headless-agent-client.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function printHelp() {
  console.log([
    'Usage:',
    '  $env:ELECTRON_RUN_AS_NODE = \'1\'',
    '  .\\node_modules\\.bin\\electron.cmd scripts/benchmark-rgb-agent.mjs --doc-id 32 --testcard <path> --ids 5-10',
    '  .\\node_modules\\.bin\\electron.cmd scripts/benchmark-rgb-agent.mjs --doc-id 32 --testcard <path> --limit 20 --offset 0',
    '  .\\node_modules\\.bin\\electron.cmd scripts/benchmark-rgb-agent.mjs --doc-id 32 --testcard <path> --all',
    '',
    'Options:',
    '  --doc-id <id>          Imported corpus doc id.',
    '  --ids <list>           Case ids, supports ranges like 5-10,22,31.',
    '  --limit <n>            Run n cases from --offset.',
    '  --offset <n>           First case offset for --limit. Default: 0.',
    '  --all                  Run every case in the testcard.',
    '  --testcard <path>      Markdown testcard path. Required.',
    '  --context-depth <n>    Agent default treeIndex depth. Default: 2.',
    '  --json                 Print JSON only.',
    '  --fail-on-miss         Exit non-zero if answer/evidence-node/body-read recall is incomplete.',
    '',
    'Recall:',
    '  answer: semicolon-separated answer groups must all match; comma-separated aliases are alternatives.',
    '  evidenceNode: final answer contains "证据节点：1-...".',
    '  bodyRead: tool chain reads at least one full body node/subtree/article or db read.'
  ].join('\n'));
}

function parseArgs(argv = []) {
  const options = {
    testcard: null,
    contextDepth: 2,
    offset: 0,
    json: false,
    all: false,
    failOnMiss: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--all') {
      options.all = true;
      continue;
    }
    if (arg === '--fail-on-miss') {
      options.failOnMiss = true;
      continue;
    }
    const next = argv[i + 1];
    if (arg === '--doc-id') {
      options.docId = Number(next);
      i += 1;
      continue;
    }
    if (arg === '--ids') {
      options.ids = parseIdList(next);
      i += 1;
      continue;
    }
    if (arg === '--limit') {
      options.limit = Number(next);
      i += 1;
      continue;
    }
    if (arg === '--offset') {
      options.offset = Number(next);
      i += 1;
      continue;
    }
    if (arg === '--testcard') {
      options.testcard = resolve(PROJECT_ROOT, next);
      i += 1;
      continue;
    }
    if (arg === '--context-depth') {
      options.contextDepth = Number(next);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.docId) || options.docId <= 0) {
    throw new Error('--doc-id is required');
  }
  if (!options.testcard) {
    throw new Error('--testcard is required');
  }
  if (!options.all && !options.ids && options.limit == null) {
    throw new Error('Choose one case selector: --ids, --limit, or --all');
  }
  if (!Number.isInteger(options.contextDepth) || options.contextDepth <= 0) {
    throw new Error('--context-depth must be a positive integer');
  }
  if (!Number.isInteger(options.offset) || options.offset < 0) {
    throw new Error('--offset must be a non-negative integer');
  }
  if (options.limit != null && (!Number.isInteger(options.limit) || options.limit <= 0)) {
    throw new Error('--limit must be a positive integer');
  }
  return options;
}

function parseIdList(text = '') {
  const ids = new Set();
  for (const part of String(text).split(',')) {
    const item = part.trim();
    if (!item) continue;
    const range = item.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      const step = start <= end ? 1 : -1;
      for (let value = start; value !== end + step; value += step) ids.add(value);
      continue;
    }
    const value = Number(item);
    if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid case id: ${item}`);
    ids.add(value);
  }
  return [...ids];
}

function parseMarkdownTableRow(line = '') {
  const trimmed = String(line).trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  const cells = trimmed.slice(1, -1).split('|').map((cell) => cell.trim());
  if (cells.length < 4) return null;
  if (!/^\d+$/.test(cells[0])) return null;
  return {
    id: Number(cells[0]),
    query: cells[1],
    expected: cells[2],
    passageCount: Number(cells[3])
  };
}

function readTestcard(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map(parseMarkdownTableRow)
    .filter(Boolean);
}

function selectCases(cases, options) {
  if (options.all) return cases;
  if (options.ids) {
    const byId = new Map(cases.map((item) => [item.id, item]));
    return options.ids.map((id) => {
      const item = byId.get(id);
      if (!item) throw new Error(`Case id not found in testcard: ${id}`);
      return item;
    });
  }
  return cases.slice(options.offset, options.offset + options.limit);
}

function normalizeForMatch(value = '') {
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s"'“”‘’《》「」『』（）()\[\]【】，,。.!！?？:：;；、]/g, '');
}

function answerGroups(expected = '') {
  return String(expected)
    .split(/[；;]/)
    .map((group) => group
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean))
    .filter((group) => group.length > 0);
}

function answerHit(answer = '', expected = '') {
  const normalizedAnswer = normalizeForMatch(answer);
  const groups = answerGroups(expected);
  if (groups.length === 0) return false;
  return groups.every((group) => group.some((alias) => {
    const normalizedAlias = normalizeForMatch(alias);
    return normalizedAlias && normalizedAnswer.includes(normalizedAlias);
  }));
}

function evidenceNodeAddresses(answer = '') {
  const text = String(answer || '');
  const markerIndex = text.search(/证据节点[：:]/);
  if (markerIndex < 0) return [];
  const tail = text.slice(markerIndex);
  return [...tail.matchAll(/\b1(?:-\d+)+\b/g)].map((match) => match[0]);
}

function toolActionSummary(toolEvents = []) {
  const actions = [];
  let bodyRead = false;
  for (const tool of toolEvents || []) {
    if (tool?.name === 'database_read' && tool.argsPreview) {
      try {
        const args = JSON.parse(tool.argsPreview);
        const action = String(args.action || '');
        actions.push(action || 'database_read');
        if (['content.getNode', 'content.getSubtree', 'content.getArticle'].includes(action)) {
          bodyRead = true;
        }
      } catch {
        actions.push('database_read:parse_failed');
      }
      continue;
    }
    if (tool?.name === 'bash') {
      actions.push('bash');
      if (/db\s+read\b/.test(String(tool.argsPreview || ''))) bodyRead = true;
      continue;
    }
    if (tool?.name) actions.push(String(tool.name));
  }
  return { actions, bodyRead };
}

function formatPercent(numerator, denominator) {
  if (denominator === 0) return '0.00%';
  return `${((numerator / denominator) * 100).toFixed(2)}%`;
}

function printReport(report) {
  console.log(`RGB Agent benchmark doc#${report.docId}`);
  console.log(`cases=${report.summary.total} answerRecall=${report.summary.answerRecall} evidenceNodeRecall=${report.summary.evidenceNodeRecall} bodyReadRate=${report.summary.bodyReadRate}`);
  console.log('');
  console.log('id | session | answer | node | body | expected | short answer');
  console.log('---|---------|--------|------|------|----------|-------------');
  for (const row of report.results) {
    const answer = row.answer.replace(/\s+/g, ' ').slice(0, 80);
    console.log([
      row.id,
      row.sessionId || '',
      row.answerHit ? 'hit' : 'miss',
      row.evidenceNodeHit ? 'hit' : 'miss',
      row.bodyRead ? 'hit' : 'miss',
      row.expected,
      answer
    ].join(' | '));
  }
}

async function exitProcess(code) {
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

async function runCase(client, item, options) {
  const result = await client.request('agent.run', {
    payload: {
      mode: 'qa',
      docId: options.docId,
      contextDepth: options.contextDepth,
      prompt: item.query
    }
  });
  const answer = String(result.answer || '');
  const evidenceNodes = evidenceNodeAddresses(answer);
  const toolSummary = toolActionSummary(result.toolEvents || []);
  return {
    id: item.id,
    sessionId: result.sessionId || null,
    query: item.query,
    expected: item.expected,
    answer,
    answerHit: answerHit(answer, item.expected),
    evidenceNodeHit: evidenceNodes.length > 0,
    evidenceNodes,
    bodyRead: toolSummary.bodyRead,
    actions: toolSummary.actions
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    await exitProcess(0);
    return;
  }
  const cases = selectCases(readTestcard(options.testcard), options);
  const client = createHeadlessAgentClient({
    cwd: PROJECT_ROOT,
    scriptPath: join(PROJECT_ROOT, 'scripts', 'agent-host.mjs'),
    onStderr: (text) => process.stderr.write(text)
  });
  const results = [];
  try {
    for (const item of cases) {
      results.push(await runCase(client, item, options));
      if (!options.json) {
        const row = results[results.length - 1];
        console.error(`case ${row.id}: answer=${row.answerHit ? 'hit' : 'miss'} node=${row.evidenceNodeHit ? 'hit' : 'miss'} body=${row.bodyRead ? 'hit' : 'miss'} session=${row.sessionId}`);
      }
    }
  } finally {
    await client.shutdown();
    client.close();
  }
  const total = results.length;
  const answerHits = results.filter((row) => row.answerHit).length;
  const evidenceNodeHits = results.filter((row) => row.evidenceNodeHit).length;
  const bodyReadHits = results.filter((row) => row.bodyRead).length;
  const report = {
    docId: options.docId,
    testcard: options.testcard,
    summary: {
      total,
      answerHits,
      answerRecall: formatPercent(answerHits, total),
      evidenceNodeHits,
      evidenceNodeRecall: formatPercent(evidenceNodeHits, total),
      bodyReadHits,
      bodyReadRate: formatPercent(bodyReadHits, total)
    },
    results
  };
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  const failed = answerHits !== total || evidenceNodeHits !== total || bodyReadHits !== total;
  await exitProcess(options.failOnMiss && failed ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error?.stack || error?.message || String(error));
  await exitProcess(1);
});
