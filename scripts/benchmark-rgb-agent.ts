#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHeadlessAgentClient } from '../src/backend/llm/headless-agent-client.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── 本地 IPC 边界投影 / 业务领域类型 ──────────────────────────
interface BenchmarkCliOptions {
  testcard: string | null;
  contextDepth: number;
  offset: number;
  json: boolean;
  all: boolean;
  failOnMiss: boolean;
  docId?: string;
  apiId?: string;
  ids?: number[];
  limit?: number;
  help?: boolean;
}

interface BenchmarkCase {
  id: number;
  query: string;
  expected: string;
  passageCount: number;
}

interface ToolEventLike {
  name?: string;
  argsPreview?: string;
  [extra: string]: unknown;
}

interface AgentRunResult {
  answer?: unknown;
  sessionId?: unknown;
  toolEvents?: ToolEventLike[];
  [extra: string]: unknown;
}

interface RunCaseResult {
  id: number;
  sessionId: string | null;
  query: string;
  expected: string;
  answer: string;
  answerHit: boolean;
  evidenceNodeHit: boolean;
  evidenceNodes: string[];
  bodyRead: boolean;
  actions: string[];
}

interface BenchmarkReport {
  docId: string | undefined;
  testcard: string | null;
  summary: {
    total: number;
    answerHits: number;
    answerRecall: string;
    evidenceNodeHits: number;
    evidenceNodeRecall: string;
    bodyReadHits: number;
    bodyReadRate: string;
  };
  results: RunCaseResult[];
}

type HeadlessAgentClient = ReturnType<typeof createHeadlessAgentClient>;

function printHelp(): void {
  console.log([
    'Usage:',
    '  $env:ELECTRON_RUN_AS_NODE = \'1\'',
    '  .\\node_modules\\.bin\\electron.cmd scripts/benchmark-rgb-agent.mjs --doc-id 019e8e89-e1b6-72eb-b5d7-3fdc239b6e86 --testcard <path> --ids 5-10',
    '  .\\node_modules\\.bin\\electron.cmd scripts/benchmark-rgb-agent.mjs --doc-id 019e8e89-e1b6-72eb-b5d7-3fdc239b6e86 --testcard <path> --limit 20 --offset 0',
    '  .\\node_modules\\.bin\\electron.cmd scripts/benchmark-rgb-agent.mjs --doc-id 019e8e89-e1b6-72eb-b5d7-3fdc239b6e86 --testcard <path> --all',
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

function parseArgs(argv: string[] = []): BenchmarkCliOptions {
  const options: BenchmarkCliOptions = {
    testcard: null,
    contextDepth: 2,
    offset: 0,
    json: false,
    all: false,
    failOnMiss: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      return options;
    }
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
      options.docId = String(next || '').trim();
      i += 1;
      continue;
    }
    if (arg === '--api-id') {
      options.apiId = String(next || '').trim();
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
      options.testcard = resolve(PROJECT_ROOT, next ?? '');
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
  if (!options.docId) {
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

function parseIdList(text: string = ''): number[] {
  const ids = new Set<number>();
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

function parseMarkdownTableRow(line: string = ''): BenchmarkCase | null {
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

function readTestcard(path: string): BenchmarkCase[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map(parseMarkdownTableRow)
    .filter((row): row is BenchmarkCase => row !== null);
}

function selectCases(cases: BenchmarkCase[], options: BenchmarkCliOptions): BenchmarkCase[] {
  if (options.all) return cases;
  if (options.ids) {
    const byId = new Map<number, BenchmarkCase>(cases.map((item) => [item.id, item]));
    return options.ids.map((id) => {
      const item = byId.get(id);
      if (!item) throw new Error(`Case id not found in testcard: ${id}`);
      return item;
    });
  }
  const limit = options.limit ?? cases.length;
  return cases.slice(options.offset, options.offset + limit);
}

function normalizeForMatch(value: unknown = ''): string {
  return String(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s"'“”‘’《》「」『』（）()\[\]【】，,。.!！?？:：;；、]/g, '');
}

function answerGroups(expected: unknown = ''): string[][] {
  return String(expected)
    .split(/[；;]/)
    .map((group) => group
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean))
    .filter((group) => group.length > 0);
}

function answerHit(answer: unknown = '', expected: unknown = ''): boolean {
  const normalizedAnswer = normalizeForMatch(answer);
  const groups = answerGroups(expected);
  if (groups.length === 0) return false;
  return groups.every((group) => group.some((alias) => {
    const normalizedAlias = normalizeForMatch(alias);
    return Boolean(normalizedAlias) && normalizedAnswer.includes(normalizedAlias);
  }));
}

function evidenceNodeAddresses(answer: unknown = ''): string[] {
  const text = String(answer || '');
  const markerIndex = text.search(/证据节点[：:]/);
  if (markerIndex < 0) return [];
  const tail = text.slice(markerIndex);
  return [...tail.matchAll(/\b1(?:-\d+)+\b/g)].map((match) => match[0]);
}

function toolActionSummary(toolEvents: ToolEventLike[] = []): { actions: string[]; bodyRead: boolean } {
  const actions: string[] = [];
  let bodyRead = false;
  for (const tool of toolEvents || []) {
    if (tool?.name === 'admin_override' && tool.argsPreview) {
      try {
        const args = JSON.parse(tool.argsPreview);
        const action = String(args.action || '');
        actions.push(action || 'admin_override');
        if (['content.getNode', 'content.getSubtree', 'content.getArticle'].includes(action)) {
          bodyRead = true;
        }
      } catch {
        actions.push('admin_override:parse_failed');
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

function formatPercent(numerator: number, denominator: number): string {
  if (denominator === 0) return '0.00%';
  return `${((numerator / denominator) * 100).toFixed(2)}%`;
}

function printReport(report: BenchmarkReport): void {
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

async function exitProcess(code: number): Promise<void> {
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

async function runCase(client: HeadlessAgentClient, item: BenchmarkCase, options: BenchmarkCliOptions): Promise<RunCaseResult> {
  const result = await client.request('agent.run', {
    payload: {
      mode: 'qa',
      docId: options.docId,
      contextDepth: options.contextDepth,
      prompt: item.query,
      agentApiId: options.apiId || undefined
    }
  }) as AgentRunResult;
  const answer = String(result.answer || '');
  const evidenceNodes = evidenceNodeAddresses(answer);
  const toolSummary = toolActionSummary(result.toolEvents || []);
  return {
    id: item.id,
    sessionId: result.sessionId ? String(result.sessionId) : null,
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    await exitProcess(0);
    return;
  }
  if (!options.testcard) throw new Error('--testcard 未传入（parseArgs 应已校验）');
  const cases = selectCases(readTestcard(options.testcard), options);
  const client = createHeadlessAgentClient({
    cwd: PROJECT_ROOT,
    scriptPath: join(PROJECT_ROOT, 'dist', 'scripts', 'agent-host.js'),
    onStderr: (text: string) => process.stderr.write(text)
  });
  const results: RunCaseResult[] = [];
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
  console.error((error as { stack?: string } | null | undefined)?.stack || (error as { message?: string } | null | undefined)?.message || String(error));
  await exitProcess(1);
});
