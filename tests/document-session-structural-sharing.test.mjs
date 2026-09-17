import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSession,
  evictChildren,
  ingestChildren,
  ingestRoot,
  projectToLegacyDoc,
  reconcileNode
} from '../dist/src/frontend/session/document-session.js';
import { sameTreeNodeFields, toTreeNode } from '../dist/src/core/node-model.js';

// 结构共享投影（F1）：未变子树引用复用 + 变化路径重建。不变量：引用相同 ⇒ 内容相同
// （upsert/patch 全字段相同时保留旧引用；childCount 校准走替换式）。

const row = (id, parentId, sortOrder, address, text = `t${id}`) => ({
  id, doc_id: 'd1', parent_id: parentId, sort_order: sortOrder, address, text,
  node_title: '', node_note: '', node_type: 'TEXT', depth: address.split('-').length
});

function buildSession() {
  // 根 1，子 1-1 / 1-2；1-1 下再有 1-1-1
  let session = createSession('d1');
  session = ingestRoot(session, row('r', null, 1, '1', 'root'));
  session = ingestChildren(session, {
    parentId: 'r', total: 2, offset: 0,
    rows: [row('a', 'r', 1, '1-1'), row('b', 'r', 2, '1-2')]
  });
  session = ingestChildren(session, {
    parentId: 'a', total: 1, offset: 0,
    rows: [row('a1', 'a', 1, '1-1-1')]
  });
  return session;
}

test('无变化再投影：整树复用（tree 引用相同）', () => {
  const session = buildSession();
  const p1 = projectToLegacyDoc(session);
  const p2 = projectToLegacyDoc(session, p1);
  assert.equal(p2.tree, p1.tree, '无变化时根引用必须复用');
  assert.equal(p2.idByAddress, p1.idByAddress);
});

test('ingest 新页：变化路径重建、未变子树引用复用', () => {
  let session = buildSession();
  const p1 = projectToLegacyDoc(session);
  // 给 b 拉一页子（b 此前是取数边界）
  session = ingestChildren(session, {
    parentId: 'b', total: 1, offset: 0,
    rows: [row('b1', 'b', 1, '1-2-1')]
  });
  const p2 = projectToLegacyDoc(session, p1);
  assert.notEqual(p2.tree, p1.tree, '根在变化路径上，必须重建');
  const findById = (node, id) => (node.id === id ? node : (node.children || []).map((c) => findById(c, id)).find(Boolean) || null);
  const a1Prev = findById(p1.tree, 'a');
  const a1Next = findById(p2.tree, 'a');
  assert.equal(a1Next, a1Prev, '未受影响的 a 子树必须复用旧引用');
  assert.ok(findById(p2.tree, 'b1'), '新并入的 b1 出现在投影里');
});

test('单节点内容 patch：该节点重建、其余子树复用', () => {
  let session = buildSession();
  const p1 = projectToLegacyDoc(session);
  session = reconcileNode(session, row('a1', 'a', 1, '1-1-1', 'a1 改过'));
  const p2 = projectToLegacyDoc(session, p1);
  const findById = (node, id) => (node.id === id ? node : (node.children || []).map((c) => findById(c, id)).find(Boolean) || null);
  assert.equal(findById(p2.tree, 'a1').text, 'a1 改过', 'patch 内容生效');
  assert.equal(findById(p2.tree, 'b'), findById(p1.tree, 'b'), '无关的 b 子树复用');
  assert.notEqual(findById(p2.tree, 'a1'), findById(p1.tree, 'a1'), '被 patch 的节点必须换新引用');
});

test('驱逐后被驱逐子树从投影消失、其余复用；与全量投影内容逐字段一致', () => {
  let session = buildSession();
  const p1 = projectToLegacyDoc(session);
  session = evictChildren(session, 'a');
  const p2 = projectToLegacyDoc(session, p1);
  const full = projectToLegacyDoc(session); // 无 prev 的全量参考
  const flatten = (node, out = []) => { out.push([node.id, node.address, node.text]); for (const c of node.children || []) flatten(c, out); return out; };
  assert.deepEqual(flatten(p2.tree), flatten(full.tree), '结构共享投影与全量投影内容必须一致');
  const findById = (node, id) => (node.id === id ? node : (node.children || []).map((c) => findById(c, id)).find(Boolean) || null);
  assert.equal(findById(p2.tree, 'a1'), null, '被驱逐的 a1 不在投影里');
  assert.equal(findById(p2.tree, 'b'), findById(p1.tree, 'b'), '未驱逐的 b 子树复用');
});

// sameTreeNodeFields 穷尽性（reviewer #6a）：字段集与 toTreeNode 手工同步，漏一处就是
// 「引用相同但内容不同」的静默 UI 陈旧。两个方向都锁：产出 key 集合必须恰为预期清单；
// 逐字段篡改必须被比较函数察觉。
test('sameTreeNodeFields 穷尽性：toTreeNode 产出 key 全在比较清单内', () => {
  const fullRow = {
    id: 'n1', doc_id: 'd1', parent_id: 'p1', address: '1-2', depth: 2, sort_order: 3,
    child_count: 4, node_type: 'IF', node_title: '标题', text: '正文', node_note: '备注',
    trust_level: '受控', source_position: 7, created_at: '2026-01-01 00:00:00', updated_at: '2026-01-02 00:00:00'
  };
  const node = toTreeNode(fullRow);
  const expectedKeys = ['id', 'docId', 'parentId', 'address', 'depth', 'sortOrder', 'childCount',
    'nodeType', 'title', 'text', 'note', 'trustLevel', 'sourcePosition', 'createdAt', 'updatedAt'];
  assert.deepEqual(Object.keys(node).sort(), [...expectedKeys].sort(),
    'toTreeNode 产出字段集变化时，必须同步 sameTreeNodeFields 的比较清单');
  for (const key of expectedKeys) {
    const tampered = { ...node, [key]: key === 'childCount' || key === 'sortOrder' || key === 'depth' ? 999 : `篡改-${String(node[key])}` };
    assert.equal(sameTreeNodeFields(node, tampered), false, `字段 ${key} 被篡改时 sameTreeNodeFields 必须返回 false`);
  }
  assert.equal(sameTreeNodeFields(node, { ...node }), true, '全字段相同必须 true');
});
