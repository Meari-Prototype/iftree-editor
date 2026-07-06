import './_assert-electron.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  contentHash,
  computeSubtreeHashes,
  CONTENT_FIELDS
} from '../dist/src/core/merkle.js';

const baseNode = {
  id: 'n1',
  text: '正文',
  node_title: '标题',
  node_note: '备注',
  node_type: 'TEXT',
  trust_level: '受控'
};

test('contentHash 确定且为 128 位 hex', () => {
  const h = contentHash(baseNode);
  assert.equal(h, contentHash({ ...baseNode }));
  assert.match(h, /^[0-9a-f]{32}$/);
});

test('5 个内容字段任一变化都改变 contentHash', () => {
  for (const field of CONTENT_FIELDS) {
    const mutated = { ...baseNode, [field]: `${baseNode[field]}-changed` };
    assert.notEqual(contentHash(mutated), contentHash(baseNode), `${field} 应影响 contentHash`);
  }
});

test('位置/父级/源位置不进 contentHash', () => {
  const moved = { ...baseNode, sort_order: 99, parent_id: 'other', source_position: 12.5 };
  assert.equal(contentHash(moved), contentHash(baseNode));
});

test('字段边界无歧义（拼接注入不碰撞）', () => {
  const a = contentHash({ id: 'x', text: 'a', node_title: 'b', node_note: '', node_type: 'TEXT', trust_level: null });
  const b = contentHash({ id: 'x', text: 'a', node_title: '', node_note: 'b', node_type: 'TEXT', trust_level: null });
  assert.notEqual(a, b);
});

test('camelCase 客户端行与 snake_case 等价', () => {
  const camel = { id: 'n1', text: '正文', nodeTitle: '标题', nodeNote: '备注', nodeType: 'TEXT', trustLevel: '受控' };
  assert.equal(contentHash(camel), contentHash(baseNode));
});

// 一棵小树： root(1) -> a(1-1), b(1-2); a -> a1(1-1-1)
function sampleTree(overrides = {}) {
  return [
    { id: 'root', parent_id: null, sort_order: 1, text: 'r', node_title: '', node_note: '', node_type: 'TEXT', trust_level: null },
    { id: 'a', parent_id: 'root', sort_order: 1, text: 'a', node_title: '', node_note: '', node_type: 'TEXT', trust_level: null },
    { id: 'a1', parent_id: 'a', sort_order: 1, text: 'a1', node_title: '', node_note: '', node_type: 'TEXT', trust_level: null },
    { id: 'b', parent_id: 'root', sort_order: 2, text: 'b', node_title: '', node_note: '', node_type: 'TEXT', trust_level: null },
    ...(overrides.extra || [])
  ].map((node) => ({ ...node, ...(overrides.byId?.[node.id] || {}) }));
}

test('后代变化沿祖先链冒泡，旁支不变', () => {
  const before = computeSubtreeHashes(sampleTree());
  const after = computeSubtreeHashes(sampleTree({ byId: { a1: { text: 'a1-changed' } } }));

  // a1 改了 → a1、a、root 的 subtreeHash 都变
  assert.notEqual(after.get('a1').subtreeHash, before.get('a1').subtreeHash);
  assert.notEqual(after.get('a').subtreeHash, before.get('a').subtreeHash);
  assert.notEqual(after.get('root').subtreeHash, before.get('root').subtreeHash);
  // 旁支 b 没动 → subtreeHash 不变
  assert.equal(after.get('b').subtreeHash, before.get('b').subtreeHash);
});

test('parent-independent：同一子树搬到不同父级，subtreeHash 不变', () => {
  // a 在 root 下 vs a 在 b 下（内容、子结构都一样），a 的 subtreeHash 应相同
  const underRoot = computeSubtreeHashes(sampleTree());
  const reparented = computeSubtreeHashes([
    { id: 'root', parent_id: null, sort_order: 1, text: 'r', node_title: '', node_note: '', node_type: 'TEXT', trust_level: null },
    { id: 'b', parent_id: 'root', sort_order: 1, text: 'b', node_title: '', node_note: '', node_type: 'TEXT', trust_level: null },
    { id: 'a', parent_id: 'b', sort_order: 1, text: 'a', node_title: '', node_note: '', node_type: 'TEXT', trust_level: null },
    { id: 'a1', parent_id: 'a', sort_order: 1, text: 'a1', node_title: '', node_note: '', node_type: 'TEXT', trust_level: null }
  ]);
  assert.equal(reparented.get('a').subtreeHash, underRoot.get('a').subtreeHash);
  assert.equal(reparented.get('a1').subtreeHash, underRoot.get('a1').subtreeHash);
});

test('同父子节点重排会改变父的 subtreeHash（顺序进入子哈希序列）', () => {
  const ordered = computeSubtreeHashes(sampleTree());
  const swapped = computeSubtreeHashes(sampleTree({ byId: { a: { sort_order: 2 }, b: { sort_order: 1 } } }));
  // a、b 自身 subtreeHash 不变（内容/子树未动），但 root 的子顺序变了 → root 变
  assert.equal(swapped.get('a').subtreeHash, ordered.get('a').subtreeHash);
  assert.equal(swapped.get('b').subtreeHash, ordered.get('b').subtreeHash);
  assert.notEqual(swapped.get('root').subtreeHash, ordered.get('root').subtreeHash);
});

// ─── computeSubtreeHashesIncremental：增量与全量对拍 ───────────────────────────

test('增量重算与全量逐节点一致（随机树、随机脏点）', async () => {
  const { computeSubtreeHashesIncremental } = await import('../dist/src/core/merkle.js');
  // 固定种子的伪随机，保证可复现。
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

  const nodes = [{ id: 'n0', parent_id: null, sort_order: 1, text: 'root', node_title: '', node_note: '', node_type: 'TEXT', trust_level: null }];
  for (let i = 1; i < 200; i += 1) {
    const parent = nodes[Math.floor(rand() * i)];
    nodes.push({
      id: `n${i}`, parent_id: parent.id, sort_order: i, text: `t${i}`,
      node_title: i % 3 ? '' : `题${i}`, node_note: '', node_type: 'TEXT', trust_level: null
    });
  }
  const full = computeSubtreeHashes(nodes);

  // 随机挑 10 个脏点：改内容 + 抹掉 hash；其余行带存量 hash。
  const dirtyIds = new Set();
  while (dirtyIds.size < 10) dirtyIds.add(`n${Math.floor(rand() * 200)}`);
  const mutated = nodes.map((n) => (dirtyIds.has(n.id) ? { ...n, text: `${n.text}-改` } : n));
  const structureRows = mutated.map((n) => ({
    id: n.id, parent_id: n.parent_id, sort_order: n.sort_order,
    content_hash: dirtyIds.has(n.id) ? null : full.get(n.id).contentHash,
    subtree_hash: dirtyIds.has(n.id) ? null : full.get(n.id).subtreeHash
  }));
  const contentById = new Map(mutated.filter((n) => dirtyIds.has(n.id)).map((n) => [n.id, n]));

  const { recomputed, fullRecomputeNeeded } = computeSubtreeHashesIncremental(structureRows, contentById);
  assert.equal(fullRecomputeNeeded, false);
  const freshFull = computeSubtreeHashes(mutated);
  // 重算集内逐一相等；集外存量本就等于 freshFull（未受脏点影响）——合成全表对拍。
  for (const node of mutated) {
    const expected = freshFull.get(node.id);
    const actual = recomputed.get(node.id)
      || { contentHash: structureRows.find((r) => r.id === node.id).content_hash, subtreeHash: structureRows.find((r) => r.id === node.id).subtree_hash };
    assert.equal(actual.contentHash, expected.contentHash, `content ${node.id}`);
    assert.equal(actual.subtreeHash, expected.subtreeHash, `subtree ${node.id}`);
  }
  // 剪枝确凿：重算集应远小于全树（10 个脏点 × 祖先链）。
  assert.ok(recomputed.size < 200, `重算集 ${recomputed.size} 应小于全树`);
});

test('增量前提破损时报 fullRecomputeNeeded 而不是给错值', async () => {
  const { computeSubtreeHashesIncremental } = await import('../dist/src/core/merkle.js');
  const rows = [
    { id: 'r', parent_id: null, sort_order: 1, content_hash: 'x', subtree_hash: null }, // 脏（subtree 缺）
    { id: 'k', parent_id: 'r', sort_order: 1, content_hash: null, subtree_hash: null }  // 子也脏但没给内容行
  ];
  const { fullRecomputeNeeded } = computeSubtreeHashesIncremental(rows, new Map());
  assert.equal(fullRecomputeNeeded, true, '缺脏行内容 → 必须要求全量兜底');
});
