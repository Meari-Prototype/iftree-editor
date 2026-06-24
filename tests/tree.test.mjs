import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTree,
  collectChainText,
  collectDescendantText,
  findNode,
  getChainNodeIds,
  maxTreeDepth,
  resolveDisplayChildren,
  splitSentences
} from '../dist/src/core/tree.js';

test('splitSentences defaults to Chinese punctuation for mixed technical text', () => {
  const result = splitSentences('如果用户导入文本，那么切分。否则等待输入！OK? node.split。末尾无标点');

  assert.deepEqual(result, [
    '如果用户导入文本，那么切分。',
    '否则等待输入！',
    'OK? node.split。',
    '末尾无标点'
  ]);
});

test('splitSentences can opt in to ASCII punctuation splitting', () => {
  const result = splitSentences('OK? Next. 末尾无标点', { splitAsciiPunctuation: true });

  assert.deepEqual(result, [
    'OK?',
    'Next.',
    '末尾无标点'
  ]);
});

test('buildTree computes dynamic addresses from parent and sort order', () => {
  const tree = buildTree([
    { id: 1, doc_id: 1, parent_id: null, sort_order: 1, node_type: 'TEXT', text: '需求总目标' },
    { id: 2, doc_id: 1, parent_id: 1, sort_order: 1, node_type: 'IF', text: '如果启动程序，那么显示文档列表' },
    { id: 3, doc_id: 1, parent_id: 1, sort_order: 2, node_type: 'ELSE', text: '否则显示空状态' },
    { id: 4, doc_id: 1, parent_id: 3, sort_order: 1, node_type: 'TEXT', text: '等待用户导入' }
  ]);

  assert.equal(tree.address, '1');
  assert.equal(tree.children[0].address, '1-1');
  assert.equal(tree.children[1].address, '1-2');
  assert.equal(tree.children[1].children[0].address, '1-2-1');
});

test('collectDescendantText returns pre-order folded text', () => {
  const tree = buildTree([
    { id: 1, doc_id: 1, parent_id: null, sort_order: 1, node_type: 'TEXT', text: '根' },
    { id: 2, doc_id: 1, parent_id: 1, sort_order: 1, node_type: 'TEXT', text: '第一句。' },
    { id: 3, doc_id: 1, parent_id: 2, sort_order: 1, node_type: 'TEXT', text: '第二句。' },
    { id: 4, doc_id: 1, parent_id: 1, sort_order: 2, node_type: 'TEXT', text: '第三句。' }
  ]);

  assert.equal(collectDescendantText(tree), '根\n\n第一句。\n\n第二句。\n\n第三句。');
  assert.equal(collectDescendantText(tree.children[0]), '第一句。\n\n第二句。');
});

test('maxTreeDepth follows the actual document tree depth', () => {
  const tree = buildTree([
    { id: 1, doc_id: 1, parent_id: null, sort_order: 1, node_type: 'TEXT', text: 'Root' },
    { id: 2, doc_id: 1, parent_id: 1, sort_order: 1, node_type: 'TEXT', text: 'A' },
    { id: 3, doc_id: 1, parent_id: 2, sort_order: 1, node_type: 'TEXT', text: 'B' },
    { id: 4, doc_id: 1, parent_id: 3, sort_order: 1, node_type: 'TEXT', text: 'C' }
  ]);

  assert.equal(maxTreeDepth(tree), 4);
});

test('超节点：单链 TEXT 合并的展开与链文本', () => {
  // A→B→C 连续单链（各自仅一个子节点），C 有两个子 → 链止于 C
  const tree = buildTree([
    { id: 'r', doc_id: 1, parent_id: null, sort_order: 1, node_type: 'TEXT', text: '根' },
    { id: 'a', doc_id: 1, parent_id: 'r', sort_order: 1, node_type: 'TEXT', text: 'A文本' },
    { id: 'b', doc_id: 1, parent_id: 'a', sort_order: 1, node_type: 'TEXT', text: 'B文本' },
    { id: 'c', doc_id: 1, parent_id: 'b', sort_order: 1, node_type: 'TEXT', text: 'C文本' },
    { id: 'd1', doc_id: 1, parent_id: 'c', sort_order: 1, node_type: 'TEXT', text: 'D1' },
    { id: 'd2', doc_id: 1, parent_id: 'c', sort_order: 2, node_type: 'IF', text: 'D2' }
  ]);
  const nodeA = findNode(tree, 'a');

  const chainIds = getChainNodeIds(nodeA);
  assert.deepEqual(chainIds, ['a', 'b', 'c'], 'A→B→C 是连续单链');

  const chainText = collectChainText(nodeA);
  assert.match(chainText, /A文本/);
  assert.match(chainText, /B文本/);
  assert.match(chainText, /C文本/);

  // 展开：跳过链中的 B、C，返回 C 的实际子节点
  const displayKids = resolveDisplayChildren(nodeA);
  assert.equal(displayKids.length, 2, '超节点解析后应有 2 个实际子节点');
  const texts = displayKids.map((n) => n.text);
  assert.ok(texts.includes('D1'));
  assert.ok(texts.includes('D2'));

  // 非链节点（IF）直接返回自己的子节点
  const nodeD2 = displayKids.find((n) => n.text === 'D2');
  assert.equal(resolveDisplayChildren(nodeD2).length, 0, 'IF 节点不参与链合并');
});
