#!/usr/bin/env node
// MS MARCO 非向量(关键字 FTS)召回评测。语料只导了 shard _00，故把 qrels 金标准过滤到
// _00（docid 前缀 msmarco_v2.1_doc_00_），做 shard-局部 Recall@K。
//
// 直接只读查 LanceDB 关键字表 nodes_keyword（FTS=ngram 分词 + BM25），不起后端、不碰 SQLite、
// 不抢锁（向量任务可并行）。这是 FTS 检索层召回；运行时 content.searchKeyword 会在其上再加
// 多词 AND 过滤，只会更低——故此数为 FTS 召回上界。docid 取自行内 node_note。
//
// 用法（electron-as-node）：
//   electron scripts/bench/msmarco-recall.mjs [--doc <docId>] [--qrels binary|umbrela] [--rel N]
//       [--max-queries N] [--limit 100] [--report <csv>]
// --doc 省略则读 benchmark/reports/full-shard.docid。

import { readFileSync, existsSync, mkdirSync, appendFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as lancedb from '@lancedb/lancedb';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DATA = join(PROJECT_ROOT, 'benchmark', 'repos', 'TREC_RAG_MS_MARCO_V2.1_segmented');
const SHARD_PREFIX = 'msmarco_v2.1_doc_00_';
const QRELS = {
  binary: { file: '2024-retrieval-qrels.txt', defaultRel: 1 },
  umbrela: { file: 'qrels.rag24.test-umbrela-all.txt', defaultRel: 2 }
};
type QrelsKind = keyof typeof QRELS;
type RecallArgs = {
  doc: string | null;
  qrels: QrelsKind;
  rel: number | null;
  maxQueries: number;
  limit: number;
  report: string;
};
const STOPWORDS = new Set('a an the of to in on for and or is are was were be been being do does did how what why when where which who whom whose with without into from by as at it its this that these those you your we they his her their can could should would will'.split(/\s+/));

function loadTopics() {
  const m = new Map<string, string>();
  for (const file of ['topics.rag24.test.txt', 'topics.rag24.raggy-dev.txt', 'topics.rag24.researchy-dev.txt']) {
    const p = join(DATA, file);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      m.set(line.slice(0, tab).trim(), line.slice(tab + 1).trim());
    }
  }
  return m;
}

function loadGoldIn00(file: string, minRel: number) {
  const gold = new Map<string, Set<string>>();
  for (const line of readFileSync(join(DATA, file), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const p = line.split(/\s+/);
    if (p.length < 4) continue;
    const [qid, , docid, relStr] = p;
    if (Number(relStr) < minRel) continue;
    if (!docid.startsWith(SHARD_PREFIX)) continue;
    if (!gold.has(qid)) gold.set(qid, new Set());
    gold.get(qid)!.add(docid);
  }
  return gold;
}

function tokenize(text: unknown) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of String(text).toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

function lanceDbPath() {
  const home = process.env.IFTREE_HOME || join(homedir(), '.iftree');
  return join(home, 'vectors', 'nodes.lance');
}

function resolveDocId(cli: string | null) {
  if (cli) return cli;
  const statePath = join(PROJECT_ROOT, 'benchmark', 'reports', 'full-shard.docid');
  if (existsSync(statePath)) return readFileSync(statePath, 'utf8').trim();
  throw new Error('需要 --doc <docId>，或先跑出 benchmark/reports/full-shard.docid');
}

function recallAt(retrieved: string[], gold: Set<string>, k: number) {
  const top = new Set(retrieved.slice(0, k));
  let hit = 0;
  for (const g of gold) if (top.has(g)) hit += 1;
  return gold.size ? hit / gold.size : 0;
}

async function ftsRetrieve(table: unknown, docId: string, queryString: string, limit: number) {
  const safe = String(docId).replace(/'/g, "''");
  const rows = await (table as { search: (...args: unknown[]) => any }).search(queryString, 'fts', 'search_text')
    .where(`doc_id = '${safe}'`)
    .limit(limit)
    .toArray();
  const out: string[] = [];
  for (const r of rows) {
    let docid = null;
    try { docid = JSON.parse(r.node_note || '{}').docid || null; } catch { /* heading node: empty note */ }
    if (docid) out.push(docid);
  }
  return out;
}

async function main() {
  const args: RecallArgs = { doc: null, qrels: 'binary', rel: null, maxQueries: Infinity, limit: 100, report: join(PROJECT_ROOT, 'benchmark', 'reports', 'msmarco-recall.csv') };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--doc') args.doc = argv[++i];
    else if (a === '--qrels') args.qrels = (argv[++i] as QrelsKind) || 'binary';
    else if (a === '--rel') args.rel = Number(argv[++i]);
    else if (a === '--max-queries') args.maxQueries = Number(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--report') args.report = resolve(argv[++i]);
  }
  const docId = resolveDocId(args.doc);
  const qrelCfg = QRELS[args.qrels] || QRELS.binary;
  const minRel = args.rel ?? qrelCfg.defaultRel;
  const topics = loadTopics();
  const gold = loadGoldIn00(qrelCfg.file, minRel);
  const qids = [...gold.keys()].filter((q) => topics.has(q)).slice(0, args.maxQueries);
  console.log(`[recall] doc=${docId} qrels=${args.qrels} rel>=${minRel} queries=${qids.length} (FTS retrieval, limit=${args.limit})`);

  const conn = await lancedb.connect(lanceDbPath());
  const table = await conn.openTable('nodes_keyword');

  const Ks = [10, 100];
  const sum: Record<number, number> = { 10: 0, 100: 0 };
  let zeroHit = 0;
  let evaluated = 0;
  for (const qid of qids) {
    const terms = tokenize(topics.get(qid));
    if (terms.length === 0) continue;
    const retrieved = await ftsRetrieve(table, docId, terms.join(' '), args.limit);
    const g = gold.get(qid)!;
    if (retrieved.length === 0) zeroHit += 1;
    for (const k of Ks) sum[k] += recallAt(retrieved, g, k);
    evaluated += 1;
    if (evaluated <= 8) {
      console.log(`  ${qid} terms=${terms.length} hits=${retrieved.length} R@100=${recallAt(retrieved, g, 100).toFixed(2)} gold=${g.size} :: ${topics.get(qid)!.slice(0, 48)}`);
    }
  }
  conn.close?.();

  const meanR = (k: number) => (evaluated ? sum[k] / evaluated : 0);
  console.log(`\n[recall] evaluated=${evaluated}  zero-hit=${zeroHit} (${evaluated ? (100 * zeroHit / evaluated).toFixed(0) : 0}%)`);
  console.log(`[recall] mean Recall@10=${meanR(10).toFixed(3)}  mean Recall@100=${meanR(100).toFixed(3)}`);

  mkdirSync(dirname(args.report), { recursive: true });
  const fresh = !existsSync(args.report) || statSync(args.report).size === 0;
  const cols = ['timestamp', 'qrels', 'rel', 'queries', 'zeroHit', 'recall@10', 'recall@100', 'limit'];
  const row = [new Date().toISOString(), args.qrels, minRel, evaluated, zeroHit, meanR(10).toFixed(4), meanR(100).toFixed(4), args.limit].join(',');
  appendFileSync(args.report, (fresh ? cols.join(',') + '\n' : '') + row + '\n', 'utf8');
  console.log(`[csv] -> ${args.report}`);
}

async function exitProcess(code: number) {
  if (process.versions.electron) { try { const { app } = await import('electron'); app?.exit?.(code); return; } catch { /* */ } }
  process.exit(code);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then(() => exitProcess(0)).catch(async (e) => { console.error(e?.stack || e?.message || String(e)); await exitProcess(1); });
}
