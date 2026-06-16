import './_assert-electron.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyTreeDiff } from '../src/core/merkle-diff.mjs';

const n = (id, parentId, sortOrder, text, extra = {}) => ({
  id,
  parent_id: parentId,
  sort_order: sortOrder,
  text,
  node_title: '',
  node_note: '',
  node_type: 'TEXT',
  trust_level: null,
  ...extra
});

// 基准树：
// root
//   a -> a1
//   b
//   c
function baseTree() {
  return [
    n('root', null, 1, 'r'),
    n('a', 'root', 1, 'a'),
    n('a1', 'a', 1, 'a1'),
    n('b', 'root', 2, 'b'),
    n('c', 'root', 3, 'c')
  ];
}

function statusById(baseNodes, projNodes) {
  const { items } = classifyTreeDiff(baseNodes, projNodes);
  return new Map(items.map((item) => [item.id, item.row]));
}

test('无变化：全部 unchanged', () => {
  const rows = statusById(baseTree(), baseTree());
  for (const [, row] of rows) assert.equal(row.status, 'unchanged');
});

test('改正文：只该节点 modified，字段为 text', () => {
  const proj = baseTree().map((node) => (node.id === 'a1' ? { ...node, text: 'a1-changed' } : node));
  const rows = statusById(baseTree(), proj);
  assert.equal(rows.get('a1').status, 'modified');
  assert.deepEqual(rows.get('a1').changedFields, ['text']);
  assert.equal(rows.get('a').status, 'unchanged');
  assert.equal(rows.get('b').status, 'unchanged');
});

test('在 a、b 之间插入 x：x=added，兄弟 b/c 不级联（keystone）', () => {
  const proj = [
    n('root', null, 1, 'r'),
    n('a', 'root', 1, 'a'),
    n('a1', 'a', 1, 'a1'),
    n('x', 'root', 2, 'x'),
    n('b', 'root', 3, 'b'),
    n('c', 'root', 4, 'c')
  ];
  const rows = statusById(baseTree(), proj);
  assert.equal(rows.get('x').status, 'added');
  assert.equal(rows.get('b').status, 'unchanged', 'b 仅地址顺移、相对次序未变 → 不该 modified');
  assert.equal(rows.get('c').status, 'unchanged');
  assert.equal(rows.get('a').status, 'unchanged');
});

test('跨父移动 a→b：a=modified(parent_id)，其子 a1 不变', () => {
  const proj = [
    n('root', null, 1, 'r'),
    n('b', 'root', 2, 'b'),
    n('a', 'b', 1, 'a'),
    n('a1', 'a', 1, 'a1'),
    n('c', 'root', 3, 'c')
  ];
  const rows = statusById(baseTree(), proj);
  assert.equal(rows.get('a').status, 'modified');
  assert.ok(rows.get('a').changedFields.includes('parent_id'));
  assert.equal(rows.get('a1').status, 'unchanged', '被搬子树内部未动');
});

test('同父重排：交换 b、c → 两者 modified(sort_order)，a 不变', () => {
  const proj = [
    n('root', null, 1, 'r'),
    n('a', 'root', 1, 'a'),
    n('a1', 'a', 1, 'a1'),
    n('c', 'root', 2, 'c'),
    n('b', 'root', 3, 'b')
  ];
  const rows = statusById(baseTree(), proj);
  assert.equal(rows.get('b').status, 'modified');
  assert.ok(rows.get('b').changedFields.includes('sort_order'));
  assert.equal(rows.get('c').status, 'modified');
  assert.equal(rows.get('a').status, 'unchanged');
});

test('删除 c：c=deleted，其余不变', () => {
  const proj = baseTree().filter((node) => node.id !== 'c');
  const rows = statusById(baseTree(), proj);
  assert.equal(rows.get('c').status, 'deleted');
  assert.equal(rows.get('c').row?.right ?? rows.get('c').right, null);
  assert.equal(rows.get('a').status, 'unchanged');
  assert.equal(rows.get('b').status, 'unchanged');
});

test('删除节点仍进入对比树（base-only 子节点被收纳）', () => {
  const proj = baseTree().filter((node) => node.id !== 'a1');
  const { items } = classifyTreeDiff(baseTree(), proj);
  const ids = new Set(items.map((item) => item.id));
  assert.ok(ids.has('a1'), '被删的 a1 应仍作为 a 的子项出现在对比树里');
});
