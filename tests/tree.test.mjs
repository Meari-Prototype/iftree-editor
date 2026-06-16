import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTree,
  collectDescendantText,
  maxTreeDepth,
  splitSentences
} from '../src/core/tree.mjs';

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
