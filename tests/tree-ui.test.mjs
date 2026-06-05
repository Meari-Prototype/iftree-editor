import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collapsedForDepthLimit,
  summaryTargetsForMode
} from '../src/core/tree-ui.mjs';
import { buildTree } from '../src/core/tree.mjs';

function sampleTree() {
  return buildTree([
    { id: 'node-root', docId: 'doc-1', parentId: null, sortOrder: 1, nodeType: 'TEXT', text: 'Root' },
    { id: 'node-first', docId: 'doc-1', parentId: 'node-root', sortOrder: 1, nodeType: 'TEXT', text: 'First sibling' },
    { id: 'node-second', docId: 'doc-1', parentId: 'node-root', sortOrder: 2, nodeType: 'TEXT', text: 'Second sibling' },
    { id: 'node-child', docId: 'doc-1', parentId: 'node-second', sortOrder: 1, nodeType: 'TEXT', text: 'Second child' },
    { id: 'node-grandchild', docId: 'doc-1', parentId: 'node-child', sortOrder: 1, nodeType: 'TEXT', text: 'Grandchild' }
  ]);
}

test('summaryTargetsForMode uses selected node own text for current node summaries', () => {
  const tree = sampleTree();

  const targets = summaryTargetsForMode({
    tree,
    selectedNodeId: 'node-second',
    mode: 'selected'
  });

  assert.equal(targets.length, 1);
  assert.equal(targets[0].node.address, '1-2');
  assert.equal(targets[0].text, 'Second sibling');
});

test('summaryTargetsForMode uses ctrl-selected nodes for current node summaries', () => {
  const tree = sampleTree();

  const targets = summaryTargetsForMode({
    tree,
    selectedNodeId: 'node-second',
    selectedNodeIds: ['node-first', 'node-child'],
    mode: 'selected'
  });

  assert.deepEqual(targets.map((target) => target.node.address), ['1-1', '1-2-1']);
  assert.deepEqual(targets.map((target) => target.text), ['First sibling', 'Second child']);
});

test('summaryTargetsForMode uses selected subtree text for subtree summaries', () => {
  const tree = sampleTree();

  const subtreeTargets = summaryTargetsForMode({
    tree,
    selectedNodeId: 'node-second',
    mode: 'subtree'
  });
  assert.equal(subtreeTargets.length, 1);
  assert.equal(subtreeTargets[0].text, 'Second sibling\n\nSecond child\n\nGrandchild');
});

test('summaryTargetsForMode uses every node with children for article summaries', () => {
  const tree = sampleTree();

  const articleTargets = summaryTargetsForMode({
    tree,
    selectedNodeId: 'node-second',
    mode: 'article'
  });
  assert.deepEqual(articleTargets.map((target) => target.node.address), ['1', '1-2', '1-2-1']);
  assert.deepEqual(articleTargets.map((target) => target.summaryMode), ['node', 'node', 'node']);
  assert.deepEqual(articleTargets.map((target) => target.text), [
    'Root\n\nFirst sibling\n\nSecond sibling\n\nSecond child\n\nGrandchild',
    'Second sibling\n\nSecond child\n\nGrandchild',
    'Second child\n\nGrandchild'
  ]);
});

test('summaryTargetsForMode uses selected node address depth for current level summaries', () => {
  const tree = sampleTree();

  const targets = summaryTargetsForMode({
    tree,
    selectedNodeId: 'node-second',
    mode: 'depth'
  });

  assert.deepEqual(targets.map((target) => target.node.address), ['1-1', '1-2']);
  assert.deepEqual(targets.map((target) => target.text), ['First sibling', 'Second sibling\n\nSecond child\n\nGrandchild']);
});

test('collapsedForDepthLimit removes collapsed nodes that block the requested depth', () => {
  const tree = sampleTree();
  const collapsed = new Set(['node-second', 'node-child', 'node-grandchild']);

  const next = collapsedForDepthLimit({
    tree,
    collapsed,
    depthLimit: 3
  });

  assert.deepEqual([...next].sort(), ['node-child', 'node-grandchild']);
});
