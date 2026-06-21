#!/usr/bin/env node
// CHM → 流式写入端到端验证（projectneed 4-16）。
//
// 同一个 CHM 用同一解析器（readChmSourceDocument）产 records，走两条写入路径：
//   A 基线：createDocFromStructuredRecords 直写 + saveSourceDocument（import-chm-doc.mjs 同路径）
//   B 被测：headless-agent 运行时 stream.bulkBegin → 分块 stream.push → stream.bulkEnd
//          → stream.attachSource（与 MCP 同一条路径，FTS 关键字增量随批入库）
//
// 分块策略（验证「任意大子树都能逐级、逐批流式推」）：子树 ≤ --batch 整棵入批；
// 超限子树先推空父节点拿到 id，再以它为挂载点（parentId）递归分块推其 children。
// 单次 push 节点数被 --batch 封顶——不存在"顶层子树必须整棵一次推完"的限制。
//
// 断言：
//   1) 两棵树同构：有序遍历的 (childCount, source_position, text) 序列完全一致
//   2) B 节点数 = records 数 + 1（doc 根）；单批峰值 ≤ --batch
//   3) depth = address 段数、parent 地址前缀自洽、地址无重复，违例 0
//   4) 幂等：同 idempotencyKey 重推同批 → deduped=true 且 createdCount 不漂移
//   5) 乱序地址追加被拒：报错含「地址不连续」
//   6) FTS 完整性：推完后 LanceDB 行数 = SQL 行数（含 doc 根；少 1 行会让首查触发整库重建）
//   7) FTS 可用性：新会话冷启动 content.searchKeyword 命中正文高频词（计时仅观测）
//   8) 源文档层：source_documents/source_spans（总数与绑定数）与基线一致
//
// 用法（electron-as-node，匹配 better-sqlite3 ABI）：
//   $env:ELECTRON_RUN_AS_NODE='1'; .\node_modules\.bin\electron.cmd scripts/verify-chm-stream.mjs --file <path.chm> [--batch 800]

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readChmSourceDocument } from '../src/core/source-chm.mjs';
import { normalizeImportBaseName } from '../src/core/source-markdown.mjs';
import { createHeadlessAgentClient } from '../src/backend/llm/headless-agent-client.mjs';
import { KeywordStore } from '../src/vector/keyword-store.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TRUST_LEVEL = '不受控'; // CHM 外部语料；流式契约要求显式给值（直写基线为 null，对账时不比较此列）。

function log(event) {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
}

function fail(message) {
  log({ type: 'verify-fail', message });
  throw new Error(message);
}

function parseArgs(argv) {
  const args = { file: null, batch: 800 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file') args.file = argv[++i];
    else if (argv[i] === '--batch') args.batch = Number(argv[++i]);
  }
  if (!args.file) throw new Error('--file <path.chm> is required');
  return args;
}

function compareRecordAddress(left, right) {
  const a = String(left.address || '').split('-').map(Number);
  const b = String(right.address || '').split('-').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// 与 import-chm-doc.mjs 同款：record 自带 index/indexes 时只认显式句位，
// 否则按记录序号兜底（整批一致，避免两套规则混用）。
function recordSentenceIndexes(record, fallbackIndex, hasExplicitIndex) {
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

// 扁平 records（带原始 address）→ 顶层嵌套子树数组（结构取自地址父子关系）。
// 同时返回与树先序遍历同序的 sortedRecords，供句位映射对位。
function buildTopSubtrees(records) {
  const byAddr = new Map();
  const tops = [];
  const sortedRecords = [...records].sort(compareRecordAddress);
  for (const record of sortedRecords) {
    const addr = String(record.address || '').trim();
    if (!addr) fail('record 缺少 address');
    const node = {
      address: '',
      text: record.text || '',
      node_type: record.nodeType ?? record.node_type ?? 'TEXT',
      source_position: record.sourcePosition ?? record.source_position ?? null,
      trust_level: TRUST_LEVEL,
      children: []
    };
    byAddr.set(addr, node);
    const cut = addr.lastIndexOf('-');
    if (cut < 0) {
      tops.push(node);
    } else {
      const parent = byAddr.get(addr.slice(0, cut));
      if (!parent) fail(`record 地址 ${addr} 找不到父记录`);
      parent.children.push(node);
    }
  }
  return { tops, sortedRecords };
}

// 递归赋连续地址，满足 _validateStreamAddresses 纯追加契约；返回本层已分配的末序号。
function assignAddresses(topNodes, baseAddress, startOrder) {
  let order = startOrder;
  const visit = (node, address) => {
    node.address = address;
    for (let i = 0; i < node.children.length; i += 1) {
      visit(node.children[i], `${address}-${i + 1}`);
    }
  };
  for (const node of topNodes) {
    order += 1;
    visit(node, `${baseAddress}-${order}`);
  }
  return order;
}

function countNodes(topNodes) {
  let count = 0;
  const visit = (node) => {
    count += 1;
    node.children.forEach(visit);
  };
  topNodes.forEach(visit);
  return count;
}

// stream.push 返回的 created 树先序展平：与 sortedRecords 顺序一一对应。
function collectCreatedIds(created, out) {
  for (const node of created || []) {
    out.push(node.id);
    if (Array.isArray(node.children) && node.children.length) collectCreatedIds(node.children, out);
  }
}

// 有序遍历 (childCount, source_position, text) 序列：两棵树同构判据。
function treeSignature(db, docId) {
  const childrenStmt = db.prepare(
    'SELECT id, text, source_position, (SELECT COUNT(*) FROM nodes c WHERE c.parent_id = n.id) AS childCount FROM nodes n WHERE doc_id = ? AND parent_id = ? ORDER BY sort_order, id'
  );
  const root = db.prepare('SELECT id FROM nodes WHERE doc_id = ? AND parent_id IS NULL').get(docId);
  if (!root) fail(`doc ${docId} 没有根节点`);
  const lines = [];
  const walk = (parentId) => {
    for (const row of childrenStmt.all(docId, parentId)) {
      lines.push(`${row.childCount} ${row.source_position ?? ''} ${row.text}`);
      walk(row.id);
    }
  };
  walk(root.id);
  return lines;
}

function firstDivergence(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return { index: i, baseline: a[i].slice(0, 120), stream: b[i].slice(0, 120) };
  }
  return { index: n, baseline: a[n]?.slice(0, 120) ?? '(end)', stream: b[n]?.slice(0, 120) ?? '(end)' };
}

// 从 records 里挑一个高频 CJK 双字词做 FTS 探针（动态选词，不依赖具体文档内容）。
function pickSearchTerm(records) {
  const freq = new Map();
  for (const record of records) {
    const text = String(record.text || '');
    for (const match of text.matchAll(/[\p{Script=Han}]{2}/gu)) {
      freq.set(match[0], (freq.get(match[0]) || 0) + 1);
    }
    if (freq.size > 5000) break;
  }
  let best = null;
  for (const [term, count] of freq) {
    if (!best || count > best.count) best = { term, count };
  }
  return best;
}

// 分块流式推送引擎：子树 ≤ batchLimit 整棵入批；超限子树「先推空父节点，
// 再以其 id 为挂载点递归推 children」。证明任意大子树可逐级、逐批、逐节点推。
async function streamChunkedPush({ client, title, tops, batchLimit }) {
  const state = {
    docId: null,
    pushSeq: 0,
    pushes: 0,
    bareParentPushes: 0,
    maxPushNodes: 0,
    flatIds: /** @type {string[]} */ ([]),
    lastPushPayload: /** @type {Record<string, any> | null} */ (null),
    lastPushResult: /** @type {Record<string, any> | null} */ (null)
  };

  const pushNodes = async (parentId, batch) => {
    state.pushSeq += 1;
    const size = countNodes(batch);
    const payload = /** @type {Record<string, any>} */ ({
      action: 'stream.push',
      nodes: batch,
      idempotencyKey: `chm-stream-verify-${state.pushSeq}`
    });
    if (state.docId) payload.docId = state.docId;
    else payload.title = title;
    if (parentId) payload.parentId = parentId;
    const res = await client.request('database.write', { payload });
    if (!state.docId) state.docId = res.docId;
    if (res.deduped) fail(`push#${state.pushSeq} 不应命中幂等缓存`);
    if (Number(res.createdCount) !== size) fail(`push#${state.pushSeq} createdCount=${res.createdCount} != ${size}`);
    collectCreatedIds(res.created, state.flatIds);
    state.pushes += 1;
    if (size > state.maxPushNodes) state.maxPushNodes = size;
    state.lastPushPayload = payload;
    state.lastPushResult = res;
    return res;
  };

  const placeChildren = async (parentId, mountAddr, children) => {
    let assigned = 0;
    let buffer = [];
    let bufferCount = 0;
    const flush = async () => {
      if (!buffer.length) return;
      assigned = assignAddresses(buffer, mountAddr, assigned);
      await pushNodes(parentId, buffer);
      buffer = [];
      bufferCount = 0;
    };
    for (const child of children) {
      const size = countNodes([child]);
      if (size > batchLimit) {
        await flush();
        const bare = { ...child, children: [] };
        assigned = assignAddresses([bare], mountAddr, assigned);
        const res = await pushNodes(parentId, [bare]);
        state.bareParentPushes += 1;
        await placeChildren(res.created[0].id, bare.address, child.children);
      } else {
        if (bufferCount + size > batchLimit) await flush();
        buffer.push(child);
        bufferCount += size;
      }
    }
    await flush();
  };

  await placeChildren(null, '1', tops);
  return state;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chmPath = resolve(args.file);
  if (!existsSync(chmPath)) throw new Error(`CHM not found: ${chmPath}`);

  const runRoot = join(PROJECT_ROOT, 'tmp', `chm-stream-e2e-${Date.now()}`);
  const homeA = join(runRoot, 'home-baseline');
  const homeB = join(runRoot, 'home-stream');
  rmSync(runRoot, { recursive: true, force: true });
  mkdirSync(homeA, { recursive: true });
  mkdirSync(homeB, { recursive: true });

  // ── 解析（两条路径共用同一份 records）─────────────────────
  const t0 = Date.now();
  const sourceDocument = await readChmSourceDocument(chmPath, { granularity: 'sentence' });
  const records = sourceDocument.records;
  log({
    type: 'parse-ok',
    structureSource: sourceDocument.structureSource,
    intermediateFormat: sourceDocument.intermediateFormat,
    records: records.length,
    spans: sourceDocument.spans.length,
    rawLength: sourceDocument.rawText.length,
    parseMs: Date.now() - t0
  });
  if (sourceDocument.structureSource !== 'hhc') fail(`structureSource=${sourceDocument.structureSource}，期望 hhc`);
  if (records.length === 0) fail('解析出 0 条 records');

  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  const title = normalizeImportBaseName(chmPath);
  const hasExplicitIndex = records.some((record) => record.index != null || Array.isArray(record.indexes));

  // ── 路径 A：直写基线 + 源文档层（import-chm-doc.mjs 同款）──
  const { IftreeStore } = await import('../src/backend/store/index.mjs');
  const dbPathA = join(homeA, 'store.sqlite');
  const storeA = new IftreeStore(dbPathA);
  storeA.init();
  let baselineDocId;
  try {
    const tA = Date.now();
    const docA = storeA.createDocFromStructuredRecords({ title, sourcePath: chmPath, records });
    baselineDocId = docA.id;
    const nodeIdsBySentenceIndexA = new Map();
    records.forEach((record, index) => {
      for (const sentenceIndex of recordSentenceIndexes(record, index + 1, hasExplicitIndex)) {
        const nodeId = docA.importedNodeIdsByRecordIndex?.[sentenceIndex] || docA.importedNodeIds[index];
        if (nodeId) nodeIdsBySentenceIndexA.set(sentenceIndex, nodeId);
      }
    });
    storeA.saveSourceDocument({
      docId: baselineDocId,
      sourcePath: chmPath,
      sourceType: sourceDocument.sourceType,
      rawMarkdown: sourceDocument.rawText,
      spans: sourceDocument.spans,
      pdfPages: sourceDocument.pdfPages || [],
      pdfChars: sourceDocument.pdfChars || [],
      nodeIdsBySentenceIndex: nodeIdsBySentenceIndexA
    });
    log({ type: 'baseline-ok', docId: baselineDocId, importMs: Date.now() - tA });
  } finally {
    storeA.close();
  }

  // ── 路径 B：分块流式写入（headless-agent 运行时，会话 1）────
  const { tops, sortedRecords } = buildTopSubtrees(records);
  const streamNodeTotal = countNodes(tops);
  if (streamNodeTotal !== records.length) fail(`组树节点数 ${streamNodeTotal} != records 数 ${records.length}`);

  process.env.IFTREE_HOME = homeB;
  process.env.IFTREE_DB = join(homeB, 'store.sqlite');
  const clientOptions = {
    cwd: PROJECT_ROOT,
    scriptPath: join(PROJECT_ROOT, 'scripts', 'agent-host.mjs'),
    onStderr: (text) => process.stderr.write(text)
  };

  const session1 = createHeadlessAgentClient(clientOptions);
  let push;
  try {
    const tB = Date.now();
    await session1.request('database.write', { payload: { action: 'stream.bulkBegin' } });
    push = await streamChunkedPush({ client: session1, title, tops, batchLimit: args.batch });
    if (push.flatIds.length !== records.length) fail(`created id 数 ${push.flatIds.length} != records 数 ${records.length}`);
    if (push.maxPushNodes > args.batch) fail(`单批峰值 ${push.maxPushNodes} 超过 --batch ${args.batch}`);

    // 幂等重推：同 key 同 payload → deduped，且不再追加节点。
    const dedupRes = await session1.request('database.write', { payload: { ...push.lastPushPayload, docId: push.docId } });
    if (dedupRes.deduped !== true) fail('同 idempotencyKey 重推未返回 deduped=true');
    if (Number(dedupRes.createdCount) !== Number(push.lastPushResult?.createdCount)) {
      fail(`幂等重推 createdCount 漂移：${dedupRes.createdCount} != ${push.lastPushResult?.createdCount}`);
    }
    log({ type: 'dedupe-ok' });

    // 乱序地址追加：复用已消费的顶层地址 1-1，期望被纯追加校验拒绝。
    let rejected = false;
    try {
      await session1.request('database.write', {
        payload: {
          action: 'stream.push',
          docId: push.docId,
          nodes: [{ address: '1-1', text: 'out-of-order probe', trust_level: TRUST_LEVEL, children: [] }],
          idempotencyKey: 'chm-stream-verify-bad-address'
        }
      });
    } catch (error) {
      rejected = true;
      const message = error?.message || String(error);
      if (!message.includes('地址不连续')) fail(`乱序地址报错文案异常：${message}`);
    }
    if (!rejected) fail('乱序地址追加未被拒绝');
    log({ type: 'reject-ok' });

    await session1.request('database.write', { payload: { action: 'stream.bulkEnd' } });
    log({
      type: 'stream-ok',
      docId: push.docId,
      importMs: Date.now() - tB,
      pushes: push.pushes,
      bareParentPushes: push.bareParentPushes,
      maxPushNodes: push.maxPushNodes
    });

    // 源文档层挂载：句位 → 节点 id 映射按推送先序与 sortedRecords 对位自建。
    const sentenceMapB = /** @type {Record<string, string>} */ ({});
    sortedRecords.forEach((record, index) => {
      for (const sentenceIndex of recordSentenceIndexes(record, index + 1, hasExplicitIndex)) {
        sentenceMapB[sentenceIndex] = push.flatIds[index];
      }
    });
    const tAttach = Date.now();
    const attach = await session1.request('database.write', {
      payload: {
        action: 'stream.attachSource',
        docId: push.docId,
        sourcePath: chmPath,
        sourceType: sourceDocument.sourceType,
        rawMarkdown: sourceDocument.rawText,
        spans: sourceDocument.spans,
        pdfPages: sourceDocument.pdfPages || [],
        pdfChars: sourceDocument.pdfChars || [],
        nodeIdsBySentenceIndex: sentenceMapB
      }
    });
    log({ type: 'attach-ok', spanCount: attach.spanCount, attachMs: Date.now() - tAttach });
  } finally {
    await session1.shutdown();
    session1.close();
  }

  // ── FTS 完整性：重建只在「索引行数 < SQL 行数」时触发；在任何查询发生前
  // 直接数 LanceDB 行数，证明根节点行在位、首查不会触发整库重建。──────
  const keywords = new KeywordStore(join(homeB, 'vectors', 'nodes.lance'));
  await keywords.init();
  const kwCount = Number(await keywords.countDocRows(push.docId)) || 0;
  keywords.close?.();
  if (kwCount !== records.length + 1) {
    fail(`流式 FTS 行数 ${kwCount} != SQL 行数 ${records.length + 1}（含根）；首查将触发整库重建`);
  }
  log({ type: 'fts-complete-ok', kwCount });

  // ── 会话 2：冷启动检索探针（跨会话可搜 + 首查/二查耗时观测）──
  const probe = pickSearchTerm(records);
  if (probe) {
    const session2 = createHeadlessAgentClient(clientOptions);
    try {
      const timedSearch = async (label) => {
        const t = Date.now();
        const search = await session2.request('database.read', {
          payload: { action: 'content.searchKeyword', docId: push.docId, keyword: probe.term, limit: 5 }
        });
        const hits = Array.isArray(search?.results) ? search.results.length
          : Array.isArray(search?.nodes) ? search.nodes.length
            : Array.isArray(search?.rows) ? search.rows.length : 0;
        log({ type: 'fts-probe', label, term: probe.term, sourceFreq: probe.count, hits, ms: Date.now() - t });
        return hits;
      };
      const hits1 = await timedSearch('first');
      await timedSearch('second');
      if (hits1 === 0) fail(`FTS 关键字 '${probe.term}'（语料出现 ${probe.count} 次）在流式文档中 0 命中`);
    } finally {
      await session2.shutdown();
      session2.close();
    }
  } else {
    log({ type: 'fts-probe-skip', reason: '语料无 CJK 双字词' });
  }

  // ── 对账：结构/计数/一致性/源文档层 ────────────────────────
  const dbA = new Database(dbPathA, { readonly: true });
  const dbB = new Database(join(homeB, 'store.sqlite'), { readonly: true });
  try {
    const countB = Number(dbB.prepare('SELECT COUNT(*) AS c FROM nodes WHERE doc_id = ?').get(push.docId)?.c) || 0;
    if (countB !== records.length + 1) fail(`流式节点数 ${countB} != records+根 ${records.length + 1}`);

    const editMode = dbB.prepare('SELECT edit_mode FROM docs WHERE id = ?').get(push.docId)?.edit_mode;
    if (editMode !== 'incremental') fail(`流式文档 edit_mode=${editMode}，期望 incremental`);

    const badDepth = Number(dbB.prepare(
      "SELECT COUNT(*) AS c FROM nodes WHERE doc_id = ? AND depth != (LENGTH(address) - LENGTH(REPLACE(address, '-', '')) + 1)"
    ).get(push.docId)?.c) || 0;
    if (badDepth !== 0) fail(`depth 与 address 段数不一致的节点：${badDepth}`);

    const badParent = Number(dbB.prepare(`
      SELECT COUNT(*) AS c FROM nodes child
      JOIN nodes parent ON parent.id = child.parent_id
      WHERE child.doc_id = ? AND parent.parent_id IS NOT NULL
        AND child.address NOT LIKE parent.address || '-%'
    `).get(push.docId)?.c) || 0;
    if (badParent !== 0) fail(`address 与父地址前缀不自洽的节点：${badParent}`);

    const dupAddr = Number(dbB.prepare(
      'SELECT COUNT(*) AS c FROM (SELECT address FROM nodes WHERE doc_id = ? GROUP BY address HAVING COUNT(*) > 1)'
    ).get(push.docId)?.c) || 0;
    if (dupAddr !== 0) fail(`重复地址：${dupAddr}`);

    const sigA = treeSignature(dbA, baselineDocId);
    const sigB = treeSignature(dbB, push.docId);
    if (sigA.length !== sigB.length || sigA.some((line, i) => line !== sigB[i])) {
      const div = firstDivergence(sigA, sigB);
      fail(`两棵树不同构：首个分歧 #${div.index} 基线=${JSON.stringify(div.baseline)} 流式=${JSON.stringify(div.stream)}`);
    }
    log({ type: 'isomorphic-ok', nodes: sigA.length });

    // 源文档层对账：源文本、span 总数、span→节点绑定数与基线一致。
    const srcA = dbA.prepare('SELECT source_type, LENGTH(raw_markdown) AS rawLen FROM source_documents WHERE doc_id = ?').get(baselineDocId);
    const srcB = dbB.prepare('SELECT source_type, LENGTH(raw_markdown) AS rawLen FROM source_documents WHERE doc_id = ?').get(push.docId);
    if (!srcB) fail('流式文档缺 source_documents 行');
    if (!srcA || srcA.rawLen !== srcB.rawLen || srcA.source_type !== srcB.source_type) {
      fail(`source_documents 不一致：基线=${JSON.stringify(srcA)} 流式=${JSON.stringify(srcB)}`);
    }
    const spanStats = (db, docId) => db.prepare(
      'SELECT COUNT(*) AS total, SUM(CASE WHEN node_id IS NOT NULL THEN 1 ELSE 0 END) AS bound FROM source_spans WHERE doc_id = ?'
    ).get(docId);
    const spansA = spanStats(dbA, baselineDocId);
    const spansB = spanStats(dbB, push.docId);
    if (Number(spansB.total) !== Number(spansA.total) || Number(spansB.bound) !== Number(spansA.bound)) {
      fail(`source_spans 不一致：基线 total=${spansA.total} bound=${spansA.bound}，流式 total=${spansB.total} bound=${spansB.bound}`);
    }
    log({ type: 'source-layer-ok', spanTotal: Number(spansB.total), spanBound: Number(spansB.bound), rawLen: Number(srcB.rawLen) });
  } finally {
    dbA.close();
    dbB.close();
  }

  log({ type: 'result', ok: true, records: records.length, baselineDocId, streamDocId: push.docId, pushes: push.pushes, runRoot });
}

async function exitProcess(code) {
  if (process.versions.electron) {
    try {
      const { app } = await import('electron');
      if (app?.exit) { app.exit(code); return; }
    } catch { /* electron-as-node */ }
  }
  process.exit(code);
}

main()
  .then(() => exitProcess(0))
  .catch(async (error) => {
    log({ type: 'result', ok: false, error: error?.stack || String(error) });
    await exitProcess(1);
  });
