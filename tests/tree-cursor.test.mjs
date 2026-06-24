import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ancestorChain,
  dfsBackward,
  dfsForward,
  nextInDfs,
  prevInDfs,
  spreadAddresses
} from '../dist/src/core/tree-cursor.js';
import { buildTree, flattenTree } from '../dist/src/core/tree.js';

// tree-cursor 是 flattenTree 的「懒加载版」：树没全在手，靠 address + childCount 推导出同一个
// DFS 先序。所以这里用 core/tree.mjs 的 buildTree + flattenTree 作独立 oracle —— 两套实现互验。
//
// 造树：用嵌套数组描述「每个节点的子节点形状」，[] = 叶。递归生成 rows（DFS 序的 id），
// 再交给 buildTree 算 address（不手算地址，避免人为算错）。

// 一棵刻意不规则的树：宽节点(1-1)、6~7 层深单链(1-2 / 1-4-3)、叶(1-3)、宽窄混合(1-4-2)、
// 末梢叶 nextInDfs 需多级上溯(1-4-3-1-1-1-1 → 1-5)。共 28 节点。
const SHAPE = [
  [[], [], []],                 // 1-1：3 个叶子
  [[[[[], []]]]],               // 1-2：单链下探到 1-2-1-1-1，末端分叉 2 子
  [],                           // 1-3：叶
  [                             // 1-4
    [],                         //   1-4-1：叶
    [[], [], [[], []]],         //   1-4-2：3 子，末子 1-4-2-3 再分 2 子
    [[[[[]]]]]                  //   1-4-3：单链直下 1-4-3-1-1-1-1
  ],
  [[], []]                      // 1-5：2 个叶子
];

function genRows(shape, parentId = null, sortOrder = 1, counter = { n: 0 }, rows = []) {
  const id = `n${counter.n++}`;
  rows.push({ id, doc_id: 1, parent_id: parentId, sort_order: sortOrder, node_type: 'TEXT', text: id });
  shape.forEach((childShape, index) => genRows(childShape, id, index + 1, counter, rows));
  return rows;
}

function childCountIndex(tree) {
  const counts = new Map();
  for (const node of flattenTree(tree)) {
    counts.set(node.address, (node.children || []).length);
  }
  return (address) => counts.get(address) || 0;
}

const tree = buildTree(genRows(SHAPE));
const order = flattenTree(tree).map((node) => node.address); // DFS 先序的 address 全序（oracle）
const childCountOf = childCountIndex(tree);

test('oracle 树形如预期：根为 1，含 28 节点、深至 7 层', () => {
  assert.equal(order[0], '1');
  assert.equal(order.length, 28);
  assert.ok(order.includes('1-4-3-1-1-1-1'), '存在 7 层深的末梢叶');
  assert.ok(order.includes('1-2-1-1-1-2'), '1-2 单链末端分叉');
});

test('nextInDfs 从根逐步推进，复现 flattenTree 的 DFS 先序全序', () => {
  const walked = ['1'];
  let current = '1';
  for (let next = nextInDfs(current, childCountOf); next; next = nextInDfs(current, childCountOf)) {
    walked.push(next);
    current = next;
  }
  assert.deepEqual(walked, order);
});

test('prevInDfs 从末节点逐步回退，复现反向全序', () => {
  const reversed = [...order].reverse();
  const last = order[order.length - 1];
  const back = [last];
  let current = last;
  for (let prev = prevInDfs(current, childCountOf); prev; prev = prevInDfs(current, childCountOf)) {
    back.push(prev);
    current = prev;
  }
  assert.deepEqual(back, reversed);
});

test('nextInDfs 与 prevInDfs 在相邻对上互逆；端点返回 null', () => {
  for (let i = 0; i < order.length - 1; i += 1) {
    assert.equal(nextInDfs(order[i], childCountOf), order[i + 1], `next(${order[i]})`);
    assert.equal(prevInDfs(order[i + 1], childCountOf), order[i], `prev(${order[i + 1]})`);
  }
  assert.equal(nextInDfs(order[order.length - 1], childCountOf), null, '末节点无后继');
  assert.equal(prevInDfs('1', childCountOf), null, '根无前驱');
});

test('dfsForward / dfsBackward 取 N 个后继/前驱，对照 order 切片', () => {
  const pivot = order.indexOf('1-4-2');
  assert.ok(pivot > 0);
  assert.deepEqual(dfsForward('1-4-2', 5, childCountOf), order.slice(pivot + 1, pivot + 6));
  const backExpected = order.slice(Math.max(0, pivot - 5), pivot).reverse();
  assert.deepEqual(dfsBackward('1-4-2', backExpected.length, childCountOf), backExpected);
});

test('ancestorChain 返回 [父…根]，根返回空', () => {
  assert.deepEqual(ancestorChain('1-4-2-3-1'), ['1-4-2-3', '1-4-2', '1-4', '1']);
  assert.deepEqual(ancestorChain('1'), []);
});

test('spreadAddresses：祖先链优先 + 以焦点为中心的 DFS 滑窗，去重且不含焦点', () => {
  const focus = '1-4-2';
  const spread = spreadAddresses(focus, 6, childCountOf);
  assert.ok(!spread.includes(focus), '不含焦点自身');
  const chain = ancestorChain(focus);
  assert.deepEqual(spread.slice(0, chain.length), chain, '祖先链排在最前');
  for (const address of spread) {
    assert.ok(order.includes(address), `${address} 应是真实节点`);
  }
  assert.equal(new Set(spread).size, spread.length, '无重复地址');
});

test('spreadAddresses：radius 0 只回祖先链，焦点为根则回空', () => {
  assert.deepEqual(spreadAddresses('1-2-1', 0, childCountOf), ['1-2', '1']);
  assert.deepEqual(spreadAddresses('1', 4, childCountOf), order.slice(1, 5));
});
