import './_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';

import {
  parseHeadings,
  buildDocSubtree,
  chainLevels,
  assignAddresses,
  runImport
} from '../dist/scripts/bench/msmarco-import.js';

// ── 纯转换逻辑单测（不依赖数据集，始终运行）──────────────────

test('parseHeadings 保留原始多行（含重复/空行），空串得空数组', () => {
  assert.deepEqual(parseHeadings('A\nB\n'), ['A', 'B', '']);
  assert.deepEqual(parseHeadings('Only'), ['Only']);
  assert.deepEqual(parseHeadings(''), []);
  assert.deepEqual(parseHeadings(null), []);
});

test('buildDocSubtree 把 headings 串成嵌套链、segment 挂最深节点', () => {
  const group = {
    url: 'http://x',
    title: 'T',
    headings: ['H0', 'H1'],
    segments: [
      { docid: 'd#0', segment: 's0', start_char: 0, end_char: 3 },
      { docid: 'd#1', segment: 's1', start_char: 3, end_char: 6 }
    ]
  };
  const top = buildDocSubtree(group);
  // heading 节点：标题在 node_title，text 留空（不进向量）。
  assert.equal(top.node_title, 'H0');
  assert.equal(top.text, '');
  assert.equal(top.children.length, 1);
  const h1 = top.children[0];
  assert.equal(h1.node_title, 'H1');
  assert.equal(h1.text, '');
  assert.equal(h1.children.length, 2); // 两个 segment 都挂在最深 heading 下
  assert.equal(h1.children[0].text, 's0'); // segment 正文在 text（进向量）
  assert.equal(JSON.parse(h1.children[0].node_note).docid, 'd#0');
  assert.equal(top.trust_level, '不受控');
});

test('buildDocSubtree headings 为空时退化为 [title] 单层', () => {
  const top = buildDocSubtree({ title: 'OnlyTitle', headings: [], segments: [{ segment: 's', docid: 'd#0' }] });
  assert.equal(top.node_title, 'OnlyTitle');
  assert.equal(top.children.length, 1);
  assert.equal(top.children[0].text, 's');
});

test('assignAddresses 产出与 _validateStreamAddresses 自洽的纯追加地址', () => {
  const a = buildDocSubtree({ title: 'A', headings: ['H0', 'H1'], segments: [{ segment: 's0', docid: 'd#0' }, { segment: 's1', docid: 'd#1' }] });
  const b = buildDocSubtree({ title: 'B', headings: ['G0'], segments: [{ segment: 't0', docid: 'e#0' }] });
  const { nextOrder, count } = assignAddresses([a, b], '1', 0);

  assert.equal(a.address, '1-1');
  assert.equal(a.children[0].address, '1-1-1');
  assert.equal(a.children[0].children[0].address, '1-1-1-1');
  assert.equal(a.children[0].children[1].address, '1-1-1-2');
  assert.equal(b.address, '1-2');
  assert.equal(b.children[0].address, '1-2-1');
  assert.equal(nextOrder, 2);
  assert.equal(count, 6); // H0,H1,s0,s1,G0,t0

  // 跨批续号：第二批 startOrder = 上批 nextOrder。
  const c = buildDocSubtree({ title: 'C', headings: ['K0'], segments: [{ segment: 'u0', docid: 'f#0' }] });
  const next = assignAddresses([c], '1', nextOrder);
  assert.equal(c.address, '1-3');
  assert.equal(next.nextOrder, 3);
});

test('chainLevels/buildDocSubtree 截断超深 headings 链（防 JSON.stringify 爆栈）', () => {
  const headings = Array.from({ length: 200 }, (_, i) => `H${i}`);
  assert.equal(chainLevels({ headings, segments: [] }, 128).length, 128);
  const top = buildDocSubtree({ headings, segments: [{ segment: 's', docid: 'd#0' }] }, '不受控', 128);
  let depth = 1;
  let cur = top;
  while (cur.children.length && cur.children[0].text === '') {
    cur = cur.children[0];
    depth += 1;
  }
  assert.equal(depth, 128); // heading 链被截到 128 层
  assert.equal(cur.children[cur.children.length - 1].text, 's'); // segment 仍挂最深保留节点下
});

// ── 集成压测（填好 IFTREE_BENCH_MSMARCO_FILE 才跑，否则跳过）────
// 目标库由 IFTREE_DB / IFTREE_HOME 决定。IFTREE_BENCH_LIMIT 控制本次 smoke 行数。

const benchFile = process.env.IFTREE_BENCH_MSMARCO_FILE;
const benchConfigured = Boolean(benchFile) && existsSync(benchFile);

test('集成：MS MARCO 分片 bulk 导入并读回核对节点数', {
  skip: benchConfigured ? false : '设置 IFTREE_BENCH_MSMARCO_FILE 指向 .json.gz/.jsonl 才运行'
}, async () => {
  const limit = Number(process.env.IFTREE_BENCH_LIMIT || 2000);
  const result = await runImport({
    filePath: benchFile,
    limit,
    batchNodes: Number(process.env.IFTREE_BENCH_BATCH || 5000),
    embed: process.env.IFTREE_BENCH_VECTORS === '1',
    vectorBackfill: process.env.IFTREE_BENCH_VECTOR_BACKFILL === '1',
    verify: true
  });

  assert.equal(result.ok, true);
  assert.ok(result.docId, '应返回新建的增量编辑文档 id');
  assert.ok(result.segments > 0, '应至少导入一个 segment');
  assert.equal(result.readbackNodeCount, result.nodesTotal + 1, '读回节点数应为 构建节点数 + 1（根节点）');
  assert.equal(result.verifyOk, true);
});
