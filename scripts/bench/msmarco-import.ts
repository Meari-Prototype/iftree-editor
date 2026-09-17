#!/usr/bin/env node
// MS MARCO v2.1 segmented 导入压测（projectneed 4-16 流式写入 / bulk 加速会话）。
//
// 建树策略：headings 当嵌套链（与用户确认）。数据集的 `headings` 是「整文档恒定的扁平
// 标题/别名堆叠」，不是逐段层级；这里把它当成一条从浅到深的嵌套链——
//   doc 根 → headings[0] → headings[1] → … → headings[k] → 各 segment（叶子）。
// 同一原始文档的所有 segment 共享同一条 headings 链，故都挂在最深 heading 节点下。
// 这是「模拟深度」（语义上是别名不是真层级），但深度数据驱动（中位 5、最深 ~1000+），
// 能压到深路径插入 + 嵌套地址校验 + subtree_hash 深链——压测语义无关，可接受。
//
// 写入走 headless-agent 运行时（与 MCP 同一条路径）：stream.bulkBegin → 多次 stream.push
// （address 直写快路径）→ stream.bulkEnd。FTS 关键字增量每批自动入库；向量按开关。
//
// 用法（跑真 node：读回验证在本进程里 require better-sqlite3，而它只编 node ABI）：
//   node dist/scripts/bench/msmarco-import.js --file <path .json.gz|.jsonl> [--limit N|N1,N2,...]
//       [--batch 5000] [--embed] [--vector-backfill] [--report <csv>] [--label <name>]
//
// 目标库由 env 决定：IFTREE_DB（sqlite 文件）、IFTREE_HOME（settings/vectors/models 根）。
// 走共享后端后这两个 env 的效力不对称，压测前务必核对：
//   · IFTREE_DB 恒生效——共享后端的管道名由库的绝对路径派生，指哪个库就连（或拉起）哪个库的后端。
//   · IFTREE_HOME 只在「本脚本亲手拉起后端」时生效；若该库的后端已经在跑，用的是它启动时的
//     IFTREE_HOME，脚本这次设的值被忽略。要隔离向量/模型目录，就用一个没人在跑的专用 IFTREE_DB。
// 另注意：拉起的共享后端是 detached 常驻的，压测结束只断连接、不关它（见 runImport 的 finally）；
// 压测专用库用完想回收进程，按 database/backend-connection.json 里的 pid 处理。

import { createReadStream, existsSync, mkdirSync, statSync, appendFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { createRequire } from 'node:module';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createBackendClient } from '../../src/backend/llm/backend-client.js';
import { resolveBackendDbPath } from '../../src/backend/llm/backend-discovery.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TRUST_LEVEL = '不受控'; // 外部网页语料；压测中标签无实际意义（与用户确认）。
const ROOT_ADDRESS = '1'; // createDoc 末尾 refreshDocAddresses 把单根节点地址定为 "1"。
// headings 链深度上限：数据里有 1000+ 层的别名堆叠极端样本，会让 JSON.stringify(IPC)
// 及写入侧递归（writeTree/地址校验）爆栈。深 alias 链无语义价值，截断安全。
const DEFAULT_MAX_CHAIN_DEPTH = 128;

// ── 本地 IPC 边界投影 / 业务领域类型 ──────────────────────────
interface MsmarcoSegment {
  docid: unknown;
  segment: unknown;
  start_char: unknown;
  end_char: unknown;
}

interface MsmarcoGroup {
  prefix: string;
  url?: unknown;
  title?: unknown;
  headings: string[];
  segments: MsmarcoSegment[];
}

interface TreeNode {
  node_title?: string;
  text: string;
  node_note?: string;
  trust_level: string;
  children: TreeNode[];
  address?: string;
}

interface RunImportOptions {
  filePath: string;
  limit?: number;
  batchNodes?: number;
  embed?: boolean;
  vectorBackfill?: boolean;
  title?: string;
  verify?: boolean;
  progressEvery?: number;
  maxChainDepth?: number;
}

interface ImportStats {
  segments: number;
  origDocs: number;
  headingNodes: number;
  segmentNodes: number;
  nodesTotal: number;
  maxDepth: number;
  batches: number;
}

interface ImportResult extends ImportStats {
  ok: boolean;
  docId: string | null;
  filePath: string;
  limit: number | null;
  importMs: number;
  nodesPerSec: number;
  segPerSec: number;
  readbackNodeCount?: number;
  verifyOk?: boolean;
  vectorBackfillMs?: number;
  vectorCount?: unknown;
  [extra: string]: unknown;
}

interface PushResult {
  docId?: string;
  [extra: string]: unknown;
}

interface VectorBackfillResult {
  vectorCountAfter?: unknown;
  vectorCount?: unknown;
  [extra: string]: unknown;
}

interface VectorProgressEvent {
  type?: string;
  stage?: string;
  [extra: string]: unknown;
}

interface CliArgs {
  file: string | null;
  limits: number[];
  batch: number;
  embed: boolean;
  vectorBackfill: boolean;
  report: string;
  label: string;
  stateFile: string | null;
  maxDepth: number;
  help?: boolean;
}

interface VerifyEvent {
  type: string;
  [extra: string]: unknown;
}

interface CountRow { c: number }

type CsvRow = Record<string, unknown>;

// ── 纯转换逻辑（无 I/O，便于单测）─────────────────────────────

// headings 原文是 \n 分隔的多行；保留原样（含重复/空行）以忠实还原深度。
export function parseHeadings(headings: unknown): string[] {
  const value = typeof headings === 'string' ? headings : '';
  return value.length ? value.split('\n') : [];
}

const originalDocId = (docid: unknown): string => {
  const text = String(docid ?? '');
  const cut = text.indexOf('#');
  return cut < 0 ? text : text.slice(0, cut);
};

// 把「一个原始文档的所有 segment」构造成一条 headings 嵌套链 + 末端 segment 叶子。
// 返回顶层节点（嵌套 children，未带 address）。headings 为空时退化为 [title] 单层。
// heading 节点：标题放 node_title、text 留空 —— 进 FTS（node_title 被索引）但不进向量
// （向量只覆盖正文非空节点，heading 是别名堆叠无语义价值，与用户确认）。
// 取本文档实际入树的 headings 层级（含深度上限截断），供建树与统计共用、避免漂移。
export function chainLevels(group: MsmarcoGroup, maxChainDepth: number = DEFAULT_MAX_CHAIN_DEPTH): string[] {
  const raw = group.headings && group.headings.length ? group.headings : [String(group.title ?? '')];
  return maxChainDepth > 0 && raw.length > maxChainDepth ? raw.slice(0, maxChainDepth) : raw;
}

export function buildDocSubtree(group: MsmarcoGroup, trustLevel: string = TRUST_LEVEL, maxChainDepth: number = DEFAULT_MAX_CHAIN_DEPTH): TreeNode {
  const levels = chainLevels(group, maxChainDepth);
  const top: TreeNode = { node_title: levels[0] ?? '', text: '', trust_level: trustLevel, children: [] };
  let cursor: TreeNode = top;
  for (let index = 1; index < levels.length; index += 1) {
    const node: TreeNode = { node_title: levels[index] ?? '', text: '', trust_level: trustLevel, children: [] };
    cursor.children.push(node);
    cursor = node;
  }
  for (const seg of group.segments) {
    cursor.children.push({
      text: String(seg.segment ?? ''),
      node_note: JSON.stringify({
        docid: seg.docid,
        url: group.url ?? '',
        start_char: seg.start_char,
        end_char: seg.end_char
      }),
      trust_level: trustLevel,
      children: []
    });
  }
  return top;
}

// 递归赋 address，匹配 _validateStreamAddresses 的纯追加契约：
// 顶层 = `${baseAddress}-${startOrder + i}`；子节点 = `${parentAddress}-${j + 1}`。
// 返回下一批的起始 order（= 本批后根下 MAX(sort_order)）与本批节点总数。
export function assignAddresses(topNodes: TreeNode[], baseAddress: string = ROOT_ADDRESS, startOrder: number = 0): { nextOrder: number; count: number } {
  let order = startOrder;
  let count = 0;
  const visit = (node: TreeNode, address: string): void => {
    node.address = address;
    count += 1;
    const children = Array.isArray(node.children) ? node.children : [];
    for (let index = 0; index < children.length; index += 1) {
      visit(children[index], `${address}-${index + 1}`);
    }
  };
  for (const node of topNodes) {
    order += 1;
    visit(node, `${baseAddress}-${order}`);
  }
  return { nextOrder: order, count };
}

// ── 流式读取：按原始文档分组（连续同前缀聚成一组，O(单组)内存）──────

export async function* streamGroups(filePath: string, { limit = Infinity }: { limit?: number } = {}): AsyncGenerator<MsmarcoGroup, void, void> {
  const raw = createReadStream(filePath);
  const input = filePath.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
  const reader = createInterface({ input, crlfDelay: Infinity });
  let count = 0;
  let current: MsmarcoGroup | null = null;
  try {
    for await (const line of reader) {
      if (!line || !line.trim()) continue;
      if (count >= limit) break;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      count += 1;
      const prefix = originalDocId(record.docid);
      if (!current || current.prefix !== prefix) {
        if (current) yield current;
        current = {
          prefix,
          url: record.url,
          title: record.title,
          headings: parseHeadings(record.headings),
          segments: []
        };
      }
      current.segments.push({
        docid: record.docid,
        segment: record.segment,
        start_char: record.start_char,
        end_char: record.end_char
      });
    }
    if (current) yield current;
  } finally {
    reader.close();
    input.destroy?.();
    raw.destroy?.();
  }
}

// ── 导入编排：bulkBegin → 分批 push → bulkEnd ───────────────────

// 与共享后端派生管道名用同一个解析：读回验证数的必须是后端刚写进去的那个库。
function resolveDbPath(): string {
  return resolveBackendDbPath(PROJECT_ROOT);
}

function countDocNodes(dbPath: string, docId: string): number {
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  try {
    return Number((db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE doc_id = ?').get(docId) as CountRow | undefined)?.c) || 0;
  } finally {
    db.close();
  }
}

function log(event: VerifyEvent): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
}

export async function runImport(options: RunImportOptions): Promise<ImportResult> {
  const {
    filePath,
    limit = Infinity,
    batchNodes = 5000,
    embed = false,
    vectorBackfill = false,
    title = `MSMARCO ${basename(filePath)} limit=${limit} @${new Date().toISOString()}`,
    verify = true,
    progressEvery = 100000,
    maxChainDepth = DEFAULT_MAX_CHAIN_DEPTH
  } = options;
  if (!filePath || !existsSync(filePath)) throw new Error(`数据集文件不存在：${filePath}`);

  // 走共享后端（18-6-1 / ARCHITECTURE §1）：压测的就是 MCP 用的那条写入路径，且写入必须由
  // 唯一持库的 host 做——私有 host 会以第二条可写连接开同一库并跑迁移，压测期间尤其危险。
  const client = createBackendClient({
    projectRoot: PROJECT_ROOT,
    hostScriptPath: join(PROJECT_ROOT, 'dist', 'scripts', 'agent-host.js'),
    mode: 'shared',
    onStderr: (text: unknown) => { process.stderr.write(String(text ?? '')); },
    onStatus: (text: unknown) => { process.stderr.write(String(text ?? '')); }
  });

  const stats: ImportStats = {
    segments: 0,
    origDocs: 0,
    headingNodes: 0,
    segmentNodes: 0,
    nodesTotal: 0,
    maxDepth: 0,
    batches: 0
  };
  let docId: string | null = null;
  let rootOrder = 0;
  let pending: MsmarcoGroup[] = [];
  let pendingNodes = 0;
  let lastProgress = 0;
  const startedAt = Date.now();

  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const tops = pending.map((group) => buildDocSubtree(group, TRUST_LEVEL, maxChainDepth));
    const { nextOrder } = assignAddresses(tops, ROOT_ADDRESS, rootOrder);
    const payload: Record<string, unknown> = { action: 'stream.push', nodes: tops, embed };
    if (docId) payload.docId = docId;
    else payload.title = title;
    const res = await client.databaseWrite(payload) as PushResult;
    if (!docId && res.docId) docId = res.docId;
    rootOrder = nextOrder;
    stats.batches += 1;
    pending = [];
    pendingNodes = 0;
  };

  try {
    log({ type: 'bulk-begin', filePath, limit, batchNodes, embed });
    // bulkBegin 要独占共享后端：backend-shared-server 在「当前连接数 > 1」时直接拒绝开批，
    // 所以 GUI、MCP、别的脚本只要挂着一条连接，这一步就过不去。不吞不重试——拒绝理由原样抛出，
    // 让人去关掉那些客户端；脚本自作主张重试只会让压测从半截开始、数字失真。
    try {
      await client.databaseWrite({ action: 'stream.bulkBegin' });
    } catch (error) {
      log({ type: 'bulk-begin-rejected', hint: '批量导入需独占共享后端：先退出 GUI、停掉其它 MCP/脚本连接，再重跑' });
      throw error;
    }

    for await (const group of streamGroups(filePath, { limit })) {
      const headingCount = chainLevels(group, maxChainDepth).length;
      stats.origDocs += 1;
      stats.segments += group.segments.length;
      stats.headingNodes += headingCount;
      stats.segmentNodes += group.segments.length;
      if (headingCount > stats.maxDepth) stats.maxDepth = headingCount;
      pending.push(group);
      pendingNodes += headingCount + group.segments.length;
      if (pendingNodes >= batchNodes) await flush();
      if (stats.segments - lastProgress >= progressEvery) {
        lastProgress = stats.segments;
        const elapsed = (Date.now() - startedAt) / 1000;
        log({
          type: 'progress',
          segments: stats.segments,
          origDocs: stats.origDocs,
          batches: stats.batches,
          elapsedSec: Number(elapsed.toFixed(1)),
          segPerSec: Math.round(stats.segments / elapsed)
        });
      }
    }
    await flush();

    log({ type: 'bulk-end' });
    await client.databaseWrite({ action: 'stream.bulkEnd' });
    const importMs = Date.now() - startedAt;
    stats.nodesTotal = stats.headingNodes + stats.segmentNodes;

    const result: ImportResult = {
      ok: true,
      docId,
      filePath,
      limit: Number.isFinite(limit) ? Number(limit) : null,
      ...stats,
      importMs,
      nodesPerSec: Math.round((stats.nodesTotal / importMs) * 1000),
      segPerSec: Math.round((stats.segments / importMs) * 1000)
    };

    if (verify && docId) {
      const dbPath = resolveDbPath();
      const readback = countDocNodes(dbPath, docId);
      result.readbackNodeCount = readback;
      // +1 = createDoc 建的根节点。
      result.verifyOk = readback === stats.nodesTotal + 1;
    }

    if (vectorBackfill) {
      const t0 = Date.now();
      let lastStage: string | undefined;
      const vres = await client.ensureDocVectors({ docId }, {
        onEvent: (raw: unknown) => {
          const event = raw as VectorProgressEvent | null | undefined;
          if (event?.type === 'vector.ensureDoc.progress' && event.stage !== lastStage) {
            lastStage = event.stage;
            log({ type: 'vector-progress', stage: event.stage, ...event });
          }
        }
      }) as VectorBackfillResult;
      result.vectorBackfillMs = Date.now() - t0;
      result.vectorCount = vres?.vectorCountAfter ?? vres?.vectorCount ?? null;
    }

    log({ type: 'result', ...result });
    return result;
  } finally {
    // 只断本连接：共享后端多客户端复用，一轮压测跑完不该把它关掉（--limit 给多个值时后几轮还要用它，
    // GUI/MCP 也可能续着）。mode !== 'pipe' 才 shutdown——那是拉不起共享后端时的私有兜底 host。
    // 注意 bulkBegin 被拒时也会走到这里：那时连接还在、后端也没被开批，断连接即恢复原状。
    if (client.mode !== 'pipe') await client.shutdown();
    client.close();
  }
}

// ── CSV 报告（默认落 benchmark/reports/，已被 .gitignore 忽略）─────

const CSV_COLUMNS = [
  'timestamp', 'label', 'file', 'limit', 'segments', 'origDocs',
  'nodesTotal', 'headingNodes', 'segmentNodes', 'maxDepth', 'batchNodes',
  'vectorsInline', 'importMs', 'nodesPerSec', 'segPerSec',
  'readbackNodeCount', 'verifyOk', 'vectorBackfillMs', 'vectorCount'
];

export function appendCsvRow(reportPath: string, row: CsvRow): void {
  mkdirSync(dirname(reportPath), { recursive: true });
  const fresh = !existsSync(reportPath) || statSync(reportPath).size === 0;
  const line = CSV_COLUMNS.map((key) => {
    const value = row[key] ?? '';
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(',');
  appendFileSync(reportPath, (fresh ? `${CSV_COLUMNS.join(',')}\n` : '') + `${line}\n`, 'utf8');
}

// ── CLI ────────────────────────────────────────────────────────

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    file: null,
    limits: [Infinity],
    batch: 5000,
    embed: false,
    vectorBackfill: false,
    report: join(PROJECT_ROOT, 'benchmark', 'reports', 'msmarco-import.csv'),
    label: '',
    stateFile: null,
    maxDepth: DEFAULT_MAX_CHAIN_DEPTH
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file') args.file = argv[++i] ?? null;
    else if (arg === '--limit') args.limits = String(argv[++i]).split(',').map((v) => (v.trim() === 'all' ? Infinity : Number(v)));
    else if (arg === '--batch') args.batch = Number(argv[++i]);
    else if (arg === '--embed') args.embed = true;
    else if (arg === '--vector-backfill') args.vectorBackfill = true;
    else if (arg === '--report') args.report = resolve(argv[++i]);
    else if (arg === '--label') args.label = argv[++i] ?? '';
    else if (arg === '--state-file') args.stateFile = resolve(argv[++i]);
    else if (arg === '--max-depth') args.maxDepth = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

async function exitProcess(code: number): Promise<void> {
  if (process.versions.electron) {
    try {
      const { app } = await import('electron');
      app?.exit?.(code);
      return;
    } catch {
      // fall through
    }
  }
  process.exit(code);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.file) {
    console.log('Usage: node dist/scripts/bench/msmarco-import.js --file <.json.gz|.jsonl> [--limit N|N1,N2,...|all] [--batch 5000] [--max-depth 128] [--embed] [--vector-backfill] [--report <csv>] [--label <name>] [--state-file <path>]');
    await exitProcess(args.file ? 0 : 1);
    return;
  }
  const filePath = resolve(args.file);
  for (const limit of args.limits) {
    const result = await runImport({
      filePath,
      limit,
      batchNodes: args.batch,
      embed: args.embed,
      vectorBackfill: args.vectorBackfill,
      maxChainDepth: args.maxDepth
    });
    appendCsvRow(args.report, {
      timestamp: new Date().toISOString(),
      label: args.label,
      file: basename(filePath),
      limit: result.limit ?? 'all',
      segments: result.segments,
      origDocs: result.origDocs,
      nodesTotal: result.nodesTotal,
      headingNodes: result.headingNodes,
      segmentNodes: result.segmentNodes,
      maxDepth: result.maxDepth,
      batchNodes: args.batch,
      vectorsInline: args.embed,
      importMs: result.importMs,
      nodesPerSec: result.nodesPerSec,
      segPerSec: result.segPerSec,
      readbackNodeCount: result.readbackNodeCount ?? '',
      verifyOk: result.verifyOk ?? '',
      vectorBackfillMs: result.vectorBackfillMs ?? '',
      vectorCount: result.vectorCount ?? ''
    });
    console.log(`[csv] appended -> ${args.report}`);
    // 落 docId 供 .bat 断点续传（向量补建用同一 docId 续）。
    if (args.stateFile && result.docId) {
      mkdirSync(dirname(args.stateFile), { recursive: true });
      writeFileSync(args.stateFile, String(result.docId), 'utf8');
      console.log(`[state] docId -> ${args.stateFile}`);
    }
  }
  await exitProcess(0);
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] || '').href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch(async (error) => {
    console.error((error as { stack?: string } | null | undefined)?.stack || (error as { message?: string } | null | undefined)?.message || String(error));
    await exitProcess(1);
  });
}
