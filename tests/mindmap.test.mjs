import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTree } from '../src/core/tree.mjs';
import { buildTreeIndex, getDescendants, getChildren } from '../src/core/node-model.mjs';
import {
  buildStatsIndex,
  contentStats,
  deriveColumns,
  statsForNode,
  subtreePreviewText
} from '../src/frontend/components/c2d-measure.mjs';

function sampleTree() {
  return buildTree([
    { id: 'node-root', docId: 'doc-1', parentId: null, sortOrder: 1, childCount: 2, nodeType: 'TEXT', text: 'Root' },
    { id: 'node-left', docId: 'doc-1', parentId: 'node-root', sortOrder: 1, childCount: 1, nodeType: 'IF', text: 'Left branch' },
    { id: 'node-right', docId: 'doc-1', parentId: 'node-root', sortOrder: 2, childCount: 0, nodeType: 'ELSE', text: 'Right branch' },
    { id: 'node-leaf', docId: 'doc-1', parentId: 'node-left', sortOrder: 1, childCount: 0, nodeType: 'TEXT', text: 'Leaf detail' }
  ]);
}

function sampleIndex() {
  return buildTreeIndex(sampleTree());
}

test('deriveColumns starts with the structural root only', () => {
  const index = sampleIndex();
  const columns = deriveColumns(index.root, new Set(), index);

  assert.equal(columns.length, 1);
  assert.equal(columns[0].groups.length, 1);
  assert.deepEqual(columns[0].groups[0].blocks.map((node) => node.id), ['node-root']);
});

test('deriveColumns expands children one visible depth at a time', () => {
  const index = sampleIndex();
  const columns = deriveColumns(index.root, new Set(['1', '1-1']), index);

  assert.equal(columns.length, 3);
  assert.deepEqual(columns[1].groups[0].blocks.map((node) => node.id), ['node-left', 'node-right']);
  assert.equal(columns[1].groups[0].parent.id, 'node-root');
  assert.deepEqual(columns[2].groups[0].blocks.map((node) => node.id), ['node-leaf']);
  assert.equal(columns[2].groups[0].parent.id, 'node-left');
});

test('subtreePreviewText folds descendant text without including the selected node', () => {
  const index = sampleIndex();

  assert.equal(subtreePreviewText(index, 'node-root'), 'Left branch\nLeaf detail\nRight branch');
  assert.equal(subtreePreviewText(index, 'node-root', 18), 'Left branch\nLeaf d');
  assert.equal(subtreePreviewText(index, 'node-leaf'), '');
});

// 旧实现（逐节点全子树遍历 + join 后整体统计），作为 buildStatsIndex 的对照真值。
function legacyNodeStats(index, node) {
  const nodeContent = (n) => [n?.title, n?.text, n?.note]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n');
  const subtreeNodes = [node, ...getDescendants(index, node.id)];
  const own = contentStats(nodeContent(node));
  const subtree = contentStats(subtreeNodes.map(nodeContent).filter(Boolean).join('\n'));
  const nodeDepth = Number(node?.depth) || String(node?.address || '1').split('-').filter(Boolean).length || 1;
  const maxDepth = subtreeNodes.reduce((max, item) => Math.max(max, Number(item?.depth) || nodeDepth), nodeDepth);
  return {
    own,
    subtree,
    subtreeNodeCount: subtreeNodes.length,
    remainingDepth: Math.max(0, maxDepth - nodeDepth),
    nextDepthWidth: getChildren(index, node.id).length
  };
}

function statsSampleIndex() {
  // 覆盖：中日韩单字计数、空白/空节点（join 分隔符数依赖非空片段数）、多层深度。
  return buildTreeIndex(buildTree([
    { id: 'n1', docId: 'doc-1', parentId: null, depth: 1, sortOrder: 1, childCount: 2, nodeType: 'TEXT', text: '根节点 root text', node_title: '标题' },
    { id: 'n2', docId: 'doc-1', parentId: 'n1', depth: 2, sortOrder: 1, childCount: 1, nodeType: 'IF', text: '中文 with English words', node_note: '备注 note' },
    { id: 'n3', docId: 'doc-1', parentId: 'n1', depth: 2, sortOrder: 2, childCount: 0, nodeType: 'TEXT', text: '' },
    { id: 'n4', docId: 'doc-1', parentId: 'n2', depth: 3, sortOrder: 1, childCount: 0, nodeType: 'TEXT', text: '  leaf 42  ' }
  ]));
}

test('buildStatsIndex matches per-node full-subtree recomputation', () => {
  const index = statsSampleIndex();
  const statsIndex = buildStatsIndex(index);

  for (const node of index.byId.values()) {
    const expected = legacyNodeStats(index, node);
    const actual = statsForNode(statsIndex, index, node);
    assert.deepEqual(actual, expected, `stats mismatch for ${node.id}`);
  }
});

test('statsForNode falls back to single-node stats for blocks outside the index', () => {
  const index = statsSampleIndex();
  const statsIndex = buildStatsIndex(index);
  const axiom = {
    id: 'axiom:7',
    address: 'A1',
    parentId: null,
    childCount: 0,
    nodeType: 'AXIOMS',
    title: '前提',
    text: '事实内容',
    note: ''
  };

  const actual = statsForNode(statsIndex, index, axiom);
  assert.equal(actual.subtreeNodeCount, 1);
  assert.equal(actual.remainingDepth, 0);
  assert.equal(actual.nextDepthWidth, 0);
  assert.deepEqual(actual.subtree, actual.own);
  assert.deepEqual(actual.own, contentStats('前提\n事实内容'));
});
