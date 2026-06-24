import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { computeSnapshotDiff } from '../../dist/src/backend/db/snapshot-history.js';

// computeSnapshotDiff 是纯函数；但本项目统一用 electron 跑测试、禁用 node（见 ../_assert-electron.mjs）。覆盖三类比对：节点、公理、引用。
// 历史回归：曾只比 nodes，快照里现成的 axioms/refs 没比，跨 commit 看不到公理/引用变更。

const node = (id, over = {}) => ({
  id,
  address: id,
  text: `t-${id}`,
  node_title: '',
  node_note: '',
  source_position: 1,
  node_type: 'TEXT',
  trust_level: null,
  ...over
});

test('节点：新增 / 删除 / 改字段', () => {
  const prev = { nodes: [node('a'), node('b')] };
  const curr = { nodes: [node('a', { text: 't-a2' }), node('c')] };
  const e = computeSnapshotDiff(prev, curr);
  assert.ok(e.some((x) => x.node_id === 'a' && x.field === 'text' && x.old === 't-a' && x.new === 't-a2'));
  assert.ok(e.some((x) => x.node_id === 'c' && x.field === '*' && x.old === null));
  assert.ok(e.some((x) => x.node_id === 'b' && x.field === '*' && x.new === null));
});

test('节点：换父 / 同父调序记 __moved__，兄弟增删的连带重排不误报', () => {
  // 换父（reparent）：a 从 p1 移到 p2，意图明确无歧义 → __moved__
  const reA = { nodes: [node('p1', { sort_order: 1 }), node('p2', { sort_order: 2 }), node('a', { parent_id: 'p1', sort_order: 1 })] };
  const reB = { nodes: [node('p1', { sort_order: 1 }), node('p2', { sort_order: 2 }), node('a', { parent_id: 'p2', sort_order: 1 })] };
  const reparent = computeSnapshotDiff(reA, reB);
  assert.ok(reparent.some((x) => x.node_id === 'a' && x.field === '__moved__'));

  // 同父调序 + 子集不变：x/y 交换 sort_order → 两条 __moved__
  const soA = { nodes: [node('p', { sort_order: 1 }), node('x', { parent_id: 'p', sort_order: 1 }), node('y', { parent_id: 'p', sort_order: 2 })] };
  const soB = { nodes: [node('p', { sort_order: 1 }), node('x', { parent_id: 'p', sort_order: 2 }), node('y', { parent_id: 'p', sort_order: 1 })] };
  const reorder = computeSnapshotDiff(soA, soB);
  assert.ok(reorder.some((x) => x.node_id === 'x' && x.field === '__moved__'));
  assert.ok(reorder.some((x) => x.node_id === 'y' && x.field === '__moved__'));

  // 同父调序但兄弟新增（子集变了）：连带重排，不报 __moved__（避免头插一个就把后面全刷成移）
  const coA = { nodes: [node('p', { sort_order: 1 }), node('x', { parent_id: 'p', sort_order: 1 })] };
  const coB = { nodes: [node('p', { sort_order: 1 }), node('z', { parent_id: 'p', sort_order: 1 }), node('x', { parent_id: 'p', sort_order: 2 })] };
  const collateral = computeSnapshotDiff(coA, coB);
  assert.ok(!collateral.some((x) => x.field === '__moved__'), '兄弟增删连带重排不应误报为移动');
});

test('公理：新增 / 删除 / 改内容（对齐编辑分支比对字段）', () => {
  const ax = (id, over = {}) => ({ id, label: `L-${id}`, content: `c-${id}`, status: 'active', node_title: '', node_note: '', ...over });
  const prev = { nodes: [node('root')], axioms: [ax('1'), ax('2')] };
  const curr = { nodes: [node('root')], axioms: [ax('1', { content: 'c-1-new' }), ax('3')] };
  const e = computeSnapshotDiff(prev, curr);
  assert.ok(e.some((x) => x.axiom_id === '1' && x.field === 'content' && x.old === 'c-1' && x.new === 'c-1-new'));
  assert.ok(e.some((x) => x.axiom_id === '3' && x.field === '*' && x.old === null && x.label === 'L-3'));
  assert.ok(e.some((x) => x.axiom_id === '2' && x.field === '*' && x.new === null));
});

test('引用：纯增删，描述带节点地址', () => {
  const ref = (id, over = {}) => ({ id, source_type: 'node', source_id: 'a', target_type: 'node', target_id: 'b', ref_kind: 'mention', ...over });
  const prev = { nodes: [node('a'), node('b')], refs: [ref('r1')] };
  const curr = { nodes: [node('a'), node('b')], refs: [ref('r2', { target_id: 'a' })] };
  const e = computeSnapshotDiff(prev, curr);
  const added = e.find((x) => x.ref_id === 'r2');
  const removed = e.find((x) => x.ref_id === 'r1');
  assert.equal(added.old, null);
  assert.match(added.ref_label, /mention a→a/);
  assert.equal(removed.new, null);
  assert.match(removed.ref_label, /mention a→b/);
});

test('空 / 缺字段快照不抛错', () => {
  assert.deepEqual(computeSnapshotDiff({}, {}), []);
  assert.deepEqual(computeSnapshotDiff({ nodes: [] }, { nodes: [] }), []);
});
