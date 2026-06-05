import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTree } from '../src/core/tree.mjs';
import { buildTreeIndex } from '../src/core/node-model.mjs';
import {
  deriveColumns,
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
