import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyThreeWayMerge } from '../src/core/merkle-merge.mjs';

const n = (id, parentId, text, extra = {}) => ({
  id,
  parent_id: parentId,
  text,
  node_title: '',
  node_note: '',
  node_type: 'TEXT',
  trust_level: null,
  ...extra
});

// base：root -> a, b
const base = () => [n('root', null, 'r'), n('a', 'root', 'a'), n('b', 'root', 'b')];

function resolve(baseNodes, oursNodes, theirsNodes) {
  const out = classifyThreeWayMerge(baseNodes, oursNodes, theirsNodes);
  return { byId: new Map(out.nodes.map((x) => [x.id, x])), out };
}

test('三方都没动 → unchanged，无冲突', () => {
  const { byId, out } = resolve(base(), base(), base());
  assert.equal(out.hasConflicts, false);
  for (const [, r] of byId) assert.equal(r.resolution, 'unchanged');
});

test('只 ours 改 → 自动取 ours', () => {
  const ours = base().map((x) => (x.id === 'a' ? { ...x, text: 'a-ours' } : x));
  const { byId, out } = resolve(base(), ours, base());
  assert.equal(out.hasConflicts, false);
  assert.equal(byId.get('a').resolution, 'ours');
});

test('只 theirs 改 → 自动取 theirs', () => {
  const theirs = base().map((x) => (x.id === 'a' ? { ...x, text: 'a-theirs' } : x));
  const { byId, out } = resolve(base(), base(), theirs);
  assert.equal(out.hasConflicts, false);
  assert.equal(byId.get('a').resolution, 'theirs');
});

test('异侧改不同字段：ours 移动 parent + theirs 改 text → 自动合，无冲突', () => {
  const ours = base().map((x) => (x.id === 'a' ? { ...x, parent_id: 'b' } : x));
  const theirs = base().map((x) => (x.id === 'a' ? { ...x, text: 'a-theirs' } : x));
  const { byId, out } = resolve(base(), ours, theirs);
  assert.equal(out.hasConflicts, false);
  const r = byId.get('a');
  assert.equal(r.resolution, 'merged');
  assert.equal(r.merged.parent_id, 'b', '取 ours 的移动');
  assert.equal(r.merged.text, 'a-theirs', '取 theirs 的正文');
});

test('同一字段两侧改不同 → 冲突', () => {
  const ours = base().map((x) => (x.id === 'a' ? { ...x, text: 'a-ours' } : x));
  const theirs = base().map((x) => (x.id === 'a' ? { ...x, text: 'a-theirs' } : x));
  const { byId, out } = resolve(base(), ours, theirs);
  assert.equal(out.hasConflicts, true);
  const r = byId.get('a');
  assert.equal(r.resolution, 'conflict');
  const c = r.conflicts.find((x) => x.field === 'text');
  assert.equal(c.ours, 'a-ours');
  assert.equal(c.theirs, 'a-theirs');
});

test('两侧改同字段成相同值 → 收敛，无冲突', () => {
  const same = (x) => (x.id === 'a' ? { ...x, text: 'a-same' } : x);
  const { byId, out } = resolve(base(), base().map(same), base().map(same));
  assert.equal(out.hasConflicts, false);
  assert.equal(byId.get('a').resolution, 'merged');
  assert.equal(byId.get('a').merged.text, 'a-same');
});

test('ours 删除、theirs 没改 → 接受删除', () => {
  const ours = base().filter((x) => x.id !== 'a');
  const { byId, out } = resolve(base(), ours, base());
  assert.equal(out.hasConflicts, false);
  assert.equal(byId.get('a').resolution, 'deleted');
});

test('ours 删除、theirs 改 → 删除/修改 冲突', () => {
  const ours = base().filter((x) => x.id !== 'a');
  const theirs = base().map((x) => (x.id === 'a' ? { ...x, text: 'a-theirs' } : x));
  const { byId, out } = resolve(base(), ours, theirs);
  assert.equal(out.hasConflicts, true);
  assert.equal(byId.get('a').resolution, 'conflict');
  assert.equal(byId.get('a').kind, 'delete-modify');
});

test('ours 新增节点 → added-ours', () => {
  const ours = [...base(), n('c', 'root', 'c')];
  const { byId, out } = resolve(base(), ours, base());
  assert.equal(out.hasConflicts, false);
  assert.equal(byId.get('c').resolution, 'added-ours');
});

test('两侧把同一节点移到不同 parent → parent_id 冲突', () => {
  const ours = base().map((x) => (x.id === 'a' ? { ...x, parent_id: 'b' } : x));     // a 移到 b 下
  const theirs = base().map((x) => (x.id === 'a' ? { ...x, parent_id: null } : x));  // a 移到顶层
  const { byId, out } = resolve(base(), ours, theirs);
  assert.equal(out.hasConflicts, true);
  const c = byId.get('a').conflicts.find((x) => x.field === 'parent_id');
  assert.equal(c.ours, 'b');
  assert.equal(c.theirs, null);
});

test('ours 删父、theirs 在其下新增 → __parent__ 结构冲突（只报孤儿链顶端）', () => {
  const ours = base().filter((x) => x.id !== 'b'); // 主干删 b
  const theirs = [...base(), n('t1', 'b', '新增1'), n('t2', 't1', '新增2')]; // 分支在 b 下挂链
  const { byId, out } = resolve(base(), ours, theirs);
  assert.equal(out.hasConflicts, true);
  assert.equal(byId.get('b').resolution, 'deleted', 'b 本身仍是接受删除');
  const r = byId.get('t1');
  assert.equal(r.resolution, 'conflict');
  assert.equal(r.kind, 'parent-deleted');
  assert.equal(r.conflicts[0].field, '__parent__');
  assert.equal(r.conflicts[0].theirs, 'b');
  assert.equal(byId.get('t2').resolution, 'added-theirs', 't2 的父由分支新建 → 不重复报');
  assert.equal(out.conflicts.filter((c) => c.field === '__parent__').length, 1);
});

test('ours 删父、theirs 把已有节点移入其下 → __parent__ 结构冲突', () => {
  const ours = base().filter((x) => x.id !== 'b'); // 主干删 b
  const theirs = base().map((x) => (x.id === 'a' ? { ...x, parent_id: 'b' } : x)); // 分支把 a 移到 b 下
  const { byId, out } = resolve(base(), ours, theirs);
  assert.equal(out.hasConflicts, true);
  const r = byId.get('a');
  assert.equal(r.resolution, 'conflict');
  assert.ok(r.conflicts.some((c) => c.field === '__parent__'));
});
